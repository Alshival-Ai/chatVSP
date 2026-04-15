"""KMZ packet extraction tools for MCP server."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from fastmcp.server.auth.auth import AccessToken

from onyx.chat.kmz_batching import run_kmz_batch_preprocessing
from onyx.db.engine.sql_engine import SqlEngine
from onyx.file_store.models import ChatFileType
from onyx.file_store.models import InMemoryChatFile
from onyx.llm.factory import get_default_llm
from onyx.llm.factory import get_llm_token_counter
from onyx.mcp_server.api import mcp_server
from onyx.mcp_server.utils import get_http_client
from onyx.mcp_server.utils import require_access_token
from onyx.utils.logger import setup_logger
from onyx.utils.variable_functionality import build_api_server_url_for_http_requests

logger = setup_logger()

SUPPORTED_PACKET_EXTENSIONS = {".pdf", ".xlsx", ".xls"}
DEFAULT_EXTRACTION_MODE = "many_to_many"
MCP_SERVER_DB_POOL_SIZE = 5
MCP_SERVER_DB_POOL_OVERFLOW = 5

_MODE_ALIASES = {
    "many_to_many": "many_to_many",
    "per_packet": "many_to_many",
    "one_per_packet": "many_to_many",
    "individual": "many_to_many",
    # Backward compatibility: compiled/single modes are now normalized to per-packet.
    "many_to_one": "many_to_many",
    "single": "many_to_many",
    "compiled": "many_to_many",
    "combined": "many_to_many",
}


def _normalize_mode(mode: str | None) -> str:
    raw_mode = (mode or "").strip().lower() or DEFAULT_EXTRACTION_MODE
    normalized = _MODE_ALIASES.get(raw_mode)
    if not normalized:
        raise ValueError(
            "Invalid mode. Supported values: "
            "many_to_many, per_packet."
        )
    return normalized


def _build_extraction_instruction(
    mode: str,
    instruction: str | None,
) -> str:
    _ = mode
    base_instruction = "Create one KMZ per packet from all attached packet files."

    extra_instruction = (instruction or "").strip()
    if not extra_instruction:
        return base_instruction

    return (
        f"{base_instruction}\n\nAdditional instruction:\n"
        f"{extra_instruction}"
    )


def _strip_data_uri_prefix(value: str) -> str:
    stripped = value.strip()
    if stripped.lower().startswith("data:") and "," in stripped:
        return stripped.split(",", 1)[1]
    return stripped


def _decode_base64_bytes(value: str) -> bytes:
    normalized = "".join(_strip_data_uri_prefix(value).split())
    padding = len(normalized) % 4
    if padding:
        normalized += "=" * (4 - padding)
    try:
        return base64.b64decode(normalized, validate=False)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"Invalid base64 payload: {e}") from e


def _extract_payload_json(preprocessing_context: str | None) -> dict[str, Any] | None:
    if not preprocessing_context:
        return None

    json_start = preprocessing_context.find("{")
    if json_start < 0:
        return None

    candidate = preprocessing_context[json_start:].strip()
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        json_end = candidate.rfind("}")
        if json_end < 0:
            return None
        try:
            payload = json.loads(candidate[: json_end + 1])
        except json.JSONDecodeError:
            return None

    if isinstance(payload, dict):
        return payload
    return None


def _build_runtime_files(
    files: list[dict[str, str]],
) -> tuple[list[InMemoryChatFile], list[str]]:
    runtime_files: list[InMemoryChatFile] = []
    validation_errors: list[str] = []

    for index, raw_file in enumerate(files, start=1):
        filename = str(raw_file.get("filename") or raw_file.get("name") or "").strip()
        if not filename:
            validation_errors.append(f"files[{index}] is missing filename")
            continue

        extension = Path(filename).suffix.lower()
        if extension not in SUPPORTED_PACKET_EXTENSIONS:
            validation_errors.append(
                f"files[{index}] has unsupported extension '{extension}'. "
                "Supported extensions: .pdf, .xlsx, .xls"
            )
            continue

        encoded_content = str(
            raw_file.get("content_base64") or raw_file.get("base64") or ""
        ).strip()
        if not encoded_content:
            validation_errors.append(
                f"files[{index}] ({filename}) is missing content_base64"
            )
            continue

        try:
            content = _decode_base64_bytes(encoded_content)
        except ValueError as e:
            validation_errors.append(f"files[{index}] ({filename}) decode error: {e}")
            continue

        runtime_files.append(
            InMemoryChatFile(
                file_id=str(uuid4()),
                filename=filename,
                file_type=ChatFileType.DOC,
                content=content,
                is_chat_file=True,
            )
        )

    return runtime_files, validation_errors


async def _build_runtime_files_from_codex_labs_paths(
    codex_labs_paths: list[str],
    access_token: AccessToken,
) -> tuple[list[InMemoryChatFile], list[str]]:
    runtime_files: list[InMemoryChatFile] = []
    validation_errors: list[str] = []
    api_base = build_api_server_url_for_http_requests(respect_env_override_if_set=True)

    for index, raw_path in enumerate(codex_labs_paths, start=1):
        relative_path = str(raw_path or "").strip().lstrip("/")
        if not relative_path:
            validation_errors.append(f"codex_labs_paths[{index}] is empty")
            continue

        filename = Path(relative_path).name
        extension = Path(filename).suffix.lower()
        if extension not in SUPPORTED_PACKET_EXTENSIONS:
            validation_errors.append(
                f"codex_labs_paths[{index}] has unsupported extension '{extension}'. "
                "Supported extensions: .pdf, .xlsx, .xls"
            )
            continue

        try:
            response = await get_http_client().get(
                f"{api_base}/codex-labs/files/content",
                params={"path": relative_path},
                headers={"Authorization": f"Bearer {access_token.token}"},
                timeout=120.0,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            validation_errors.append(
                f"codex_labs_paths[{index}] ({relative_path}) fetch failed with status "
                f"{e.response.status_code}"
            )
            continue
        except httpx.RequestError as e:
            validation_errors.append(
                f"codex_labs_paths[{index}] ({relative_path}) network error: {e}"
            )
            continue

        runtime_files.append(
            InMemoryChatFile(
                file_id=str(uuid4()),
                filename=filename,
                file_type=ChatFileType.DOC,
                content=response.content,
                is_chat_file=True,
            )
        )

    return runtime_files, validation_errors


def _ensure_db_engine_initialized() -> None:
    try:
        SqlEngine.get_engine()
        return
    except RuntimeError:
        # Engine is not initialized in the MCP server process yet.
        pass

    SqlEngine.set_app_name("mcp_server")
    SqlEngine.init_engine(
        pool_size=MCP_SERVER_DB_POOL_SIZE,
        max_overflow=MCP_SERVER_DB_POOL_OVERFLOW,
    )


def _anchor_has_coordinates(anchor: dict[str, Any]) -> bool:
    coordinates = anchor.get("coordinates") or {}
    lat = coordinates.get("lat")
    lon = coordinates.get("lon")
    return lat is not None and lon is not None


async def _enrich_payload_with_geocoded_anchors(
    packet_payload: dict[str, Any],
) -> dict[str, Any]:
    from onyx.mcp_server.tools.places import google_places_geocode_address

    geocoding_summary: dict[str, Any] = {
        "attempted": 0,
        "resolved": 0,
        "failed": 0,
        "skipped_with_existing_coordinates": 0,
        "provider": "google_places_geocode_address",
    }

    root_warnings = packet_payload.setdefault("warnings", [])
    if not isinstance(root_warnings, list):
        root_warnings = []
        packet_payload["warnings"] = root_warnings

    address_cache: dict[str, dict[str, Any]] = {}

    def _iter_anchor_refs() -> list[dict[str, Any]]:
        anchor_refs: list[dict[str, Any]] = []
        root_anchors = packet_payload.get("anchors")
        if isinstance(root_anchors, list):
            anchor_refs.extend(
                anchor for anchor in root_anchors if isinstance(anchor, dict)
            )

        packet_models = packet_payload.get("packet_models")
        if isinstance(packet_models, list):
            for packet_model in packet_models:
                if not isinstance(packet_model, dict):
                    continue
                model_anchors = packet_model.get("anchors")
                if isinstance(model_anchors, list):
                    anchor_refs.extend(
                        anchor for anchor in model_anchors if isinstance(anchor, dict)
                    )

        return anchor_refs

    for anchor in _iter_anchor_refs():
        if _anchor_has_coordinates(anchor):
            geocoding_summary["skipped_with_existing_coordinates"] += 1
            continue

        address = str(anchor.get("address") or "").strip()
        if not address:
            geocoding_summary["failed"] += 1
            continue

        geocoding_summary["attempted"] += 1
        cached = address_cache.get(address)
        if cached is None:
            try:
                cached = await google_places_geocode_address(address=address)
            except Exception as e:
                cached = {"error": str(e)}
            address_cache[address] = cached

        if cached.get("error"):
            geocoding_summary["failed"] += 1
            continue

        best_match = cached.get("best_match") if isinstance(cached, dict) else None
        if not isinstance(best_match, dict):
            geocoding_summary["failed"] += 1
            continue

        lat = best_match.get("latitude")
        lon = best_match.get("longitude")
        if lat is None or lon is None:
            geocoding_summary["failed"] += 1
            continue

        coordinates = anchor.get("coordinates")
        if not isinstance(coordinates, dict):
            coordinates = {}
        coordinates["lat"] = lat
        coordinates["lon"] = lon
        anchor["coordinates"] = coordinates

        confidence = str(anchor.get("confidence") or "").strip().lower()
        if confidence in {"", "missing"}:
            anchor["confidence"] = "approximate"

        note_prefix = "Geocoded via google_places_geocode_address."
        existing_notes = str(anchor.get("notes") or "").strip()
        if note_prefix not in existing_notes:
            anchor["notes"] = (
                f"{existing_notes} {note_prefix}".strip()
                if existing_notes
                else note_prefix
            )

        geocoding_summary["resolved"] += 1

    if geocoding_summary["failed"] > 0:
        warning = (
            "Some anchors could not be geocoded automatically and still require "
            "manual coordinate verification."
        )
        if warning not in root_warnings:
            root_warnings.append(warning)

    return geocoding_summary


@mcp_server.tool()
async def extract_kmz_packet_from_base64(
    files: list[dict[str, str]] | None = None,
    codex_labs_paths: list[str] | None = None,
    mode: str = DEFAULT_EXTRACTION_MODE,
    instruction: str | None = None,
    geocode_missing_anchors: bool = True,
) -> dict[str, Any]:
    """
    Extract structured KMZ packet facts from base64-encoded packet files.

    Use this tool for packet workflows before KMZ generation:
    provide packet files as base64 payloads (`.pdf`, optional `.xlsx/.xls`),
    and this tool returns structured packet JSON with anchors and point features.

    Input format for each `files` entry:
    - `filename` (or `name`): source file name with extension
    - `content_base64` (or `base64`): base64 file content (raw or data URI)

    Input format for `codex_labs_paths`:
    - list of Codex Labs relative paths (e.g. `Packets/packet.pdf`)
    - files are fetched server-side via `/codex-labs/files/content`
    - this avoids large base64 argument payloads and is preferred for bigger PDFs

    Notes:
    - Provide either `codex_labs_paths` or `files` (or both).
    - Provide at least one packet source file (`.pdf`, `.xlsx`, `.xls`).
    - Excel files can be used either as supplemental context or as the primary packet source.
    - `mode` is optional and normalized to per-packet output.
      Legacy aliases like `many_to_one`, `combined`, and `compiled` are accepted
      for backward compatibility and treated as per-packet mode.
    - When `geocode_missing_anchors=true`, missing anchor coordinates are enriched via
      `google_places_geocode_address` when possible.
    """
    access_token = require_access_token()

    try:
        normalized_mode = _normalize_mode(mode)
    except ValueError as e:
        return {"error": str(e)}

    runtime_files: list[InMemoryChatFile] = []
    validation_errors: list[str] = []

    if codex_labs_paths:
        path_runtime_files, path_validation_errors = (
            await _build_runtime_files_from_codex_labs_paths(
                codex_labs_paths=codex_labs_paths,
                access_token=access_token,
            )
        )
        runtime_files.extend(path_runtime_files)
        validation_errors.extend(path_validation_errors)

    if files:
        base64_runtime_files, base64_validation_errors = _build_runtime_files(files)
        runtime_files.extend(base64_runtime_files)
        validation_errors.extend(base64_validation_errors)

    if not runtime_files:
        return {
            "error": (
                "No valid packet files provided. Pass `codex_labs_paths` and/or "
                "`files` with at least one PDF."
            ),
            "validation_errors": validation_errors or None,
        }

    if validation_errors:
        logger.warning(
            "KMZ extractor accepted partial inputs with validation errors: %s",
            validation_errors,
        )

    pdf_files = [
        runtime_file
        for runtime_file in runtime_files
        if Path(runtime_file.filename or "").suffix.lower() == ".pdf"
    ]
    spreadsheet_files = [
        runtime_file
        for runtime_file in runtime_files
        if Path(runtime_file.filename or "").suffix.lower() in {".xlsx", ".xls"}
    ]

    user_message = _build_extraction_instruction(normalized_mode, instruction)
    try:
        _ensure_db_engine_initialized()
        llm = get_default_llm()
        token_counter = get_llm_token_counter(llm)
    except Exception as e:
        logger.exception("MCP KMZ packet extraction LLM bootstrap failed: %s", e)
        return {"error": f"Unable to initialize packet extraction model: {e}"}

    try:
        outcome = await asyncio.to_thread(
            run_kmz_batch_preprocessing,
            llm=llm,
            token_counter=token_counter,
            user_message=user_message,
            runtime_files=runtime_files,
            user_identity=None,
        )
    except Exception as e:
        logger.exception("MCP KMZ packet extraction failed: %s", e)
        return {
            "error": f"KMZ packet extraction failed: {e}",
            "mode": normalized_mode,
            "pdf_count": len(pdf_files),
            "spreadsheet_count": len(spreadsheet_files),
        }

    packet_payload = _extract_payload_json(outcome.additional_context_appendix)
    if isinstance(packet_payload, dict):
        packet_payload.pop("connections", None)
        packet_models = packet_payload.get("packet_models")
        if isinstance(packet_models, list):
            for packet_model in packet_models:
                if isinstance(packet_model, dict):
                    packet_model.pop("connections", None)
    response: dict[str, Any] = {
        "status": "ok",
        "mode": normalized_mode,
        "pdf_count": len(pdf_files),
        "spreadsheet_count": len(spreadsheet_files),
        "source_files": [runtime_file.filename for runtime_file in runtime_files],
        "packet_extraction": packet_payload,
        "validation_errors": validation_errors or [],
    }

    if packet_payload is None:
        response["warning"] = (
            "Structured payload could not be parsed from preprocessing context."
        )
        response["preprocessing_context"] = outcome.additional_context_appendix
    elif geocode_missing_anchors:
        response["geocoding"] = await _enrich_payload_with_geocoded_anchors(packet_payload)

    return response
