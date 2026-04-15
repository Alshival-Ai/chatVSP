import base64
import json
import mimetypes
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import BaseModel
from pydantic import Field

from onyx.chat.llm_step import translate_history_to_llm_format
from onyx.chat.models import ChatLoadedFile
from onyx.chat.models import ChatMessageSimple
from onyx.configs.constants import MessageType
from onyx.file_store.file_store import get_default_file_store
from onyx.file_store.models import FileDescriptor
from onyx.file_store.models import InMemoryChatFile
from onyx.llm.constants import LlmProviderNames
from onyx.llm.interfaces import LLM
from onyx.llm.interfaces import LLMUserIdentity
from onyx.llm.models import ReasoningEffort
from onyx.utils.logger import setup_logger

OPENAI_HARD_FILE_LIMIT_BYTES = 50 * 1024 * 1024
OPENAI_BATCH_TARGET_BYTES = 45 * 1024 * 1024
KMZ_PACKET_MAX_PDFS = 100
KMZ_EXTRACTION_TOOL_MAX_CYCLES = 6
_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{.*\})\s*```", re.DOTALL)
_JSON_OBJECT_RE = re.compile(r"(\{.*\})", re.DOTALL)
_PDF_MAGIC_PREFIX = b"%PDF-"
_FILENAME_ADDRESS_SEGMENT_RE = re.compile(r"^\d{1,6}\s+[A-Za-z0-9].*")
_GOOGLE_PLACES_BASE_URL = "https://places.googleapis.com/v1"
_DEFAULT_SEARCH_FIELD_MASK = ",".join(
    [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.types",
        "places.googleMapsUri",
    ]
)
_DEFAULT_PLACE_DETAIL_FIELD_MASK = ",".join(
    [
        "id",
        "displayName",
        "formattedAddress",
        "location",
        "types",
        "googleMapsUri",
    ]
)

_CITY_CODE_TO_NAME = {
    "BOU": "Boulder",
    "SUP": "Superior",
    "LAF": "Lafayette",
    "LON": "Longmont",
    "ERI": "Erie",
    "NED": "Nederland",
    "LOU": "Louisville",
}

logger = setup_logger()


class KmzBatch(BaseModel):
    batch_index: int
    file_ids: list[str]
    filenames: list[str]
    total_bytes: int


class KmzBatchPlan(BaseModel):
    batches: list[KmzBatch]
    oversized_files: list[str]
    total_pdf_bytes: int


class KmzBatchExtractionResult(BaseModel):
    source_files: list[str] = Field(default_factory=list)
    anchors: list[dict] = Field(default_factory=list)
    features: list[dict] = Field(default_factory=list)
    connections: list[dict] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class KmzPacketModel(BaseModel):
    source_file: str
    anchors: list[dict] = Field(default_factory=list)
    features: list[dict] = Field(default_factory=list)
    connections: list[dict] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class KmzMergedPacketModel(BaseModel):
    requested_output_mode: str
    source_files: list[str]
    packet_models: list[KmzPacketModel]
    anchors: list[dict]
    features: list[dict]
    connections: list[dict]
    warnings: list[str]
    skipped_files: list[str]
    failed_batches: list[str]


class KmzBatchingOutcome(BaseModel):
    runtime_file_descriptors: list[FileDescriptor]
    additional_context_appendix: str | None


def _strip_connections_from_packet_payload(payload: dict[str, Any]) -> dict[str, Any]:
    sanitized = json.loads(json.dumps(payload))
    if isinstance(sanitized, dict):
        sanitized.pop("connections", None)
        packet_models = sanitized.get("packet_models")
        if isinstance(packet_models, list):
            for packet_model in packet_models:
                if isinstance(packet_model, dict):
                    packet_model.pop("connections", None)
    return sanitized


def _is_pdf_file(file: InMemoryChatFile) -> bool:
    return bool(file.filename and Path(file.filename).suffix.lower() == ".pdf")


def _has_pdf_magic(content: bytes) -> bool:
    return content.startswith(_PDF_MAGIC_PREFIX)


def _rehydrate_pdf_binary_if_needed(file: InMemoryChatFile) -> InMemoryChatFile:
    if not _is_pdf_file(file):
        return file
    if _has_pdf_magic(file.content):
        return file

    try:
        file_store = get_default_file_store()
        original_binary = file_store.read_file(str(file.file_id), mode="b").read()
    except Exception as e:
        logger.warning(
            "KMZ preprocessing could not reload binary PDF for file_id=%s filename=%s: %s",
            file.file_id,
            file.filename,
            e,
        )
        return file

    if not original_binary:
        return file

    if _has_pdf_magic(original_binary):
        logger.info(
            "KMZ preprocessing reloaded binary PDF bytes for file_id=%s filename=%s",
            file.file_id,
            file.filename,
        )

    return InMemoryChatFile(
        file_id=file.file_id,
        content=original_binary,
        file_type=file.file_type,
        filename=file.filename,
        user_file_id=file.user_file_id,
        is_chat_file=file.is_chat_file,
    )


def _normalize_runtime_files_for_kmz(
    runtime_files: list[InMemoryChatFile],
) -> list[InMemoryChatFile]:
    return [_rehydrate_pdf_binary_if_needed(file) for file in runtime_files]


def _looks_like_kmz_request(message: str) -> bool:
    lower = message.lower()
    return "kmz" in lower or "kml" in lower


def detect_kmz_output_mode(message: str) -> str:
    lower = message.lower()
    per_packet_signals = (
        "per packet",
        "for each packet",
        "each packet",
        "one kmz per packet",
        "separate kmz",
        "separate kmzs",
        "individual kmz",
        "individual kmzs",
    )
    if any(signal in lower for signal in per_packet_signals):
        return "per_packet"
    return "combined"


def should_batch_kmz_pdfs(
    message: str,
    llm_provider: str | None,
    files: list[InMemoryChatFile],
) -> bool:
    if llm_provider not in {LlmProviderNames.OPENAI, LlmProviderNames.AZURE}:
        return False
    if not _looks_like_kmz_request(message):
        return False

    pdf_files = [file for file in files if _is_pdf_file(file)]
    if not pdf_files:
        return False

    total_pdf_bytes = sum(len(file.content) for file in pdf_files)
    if any(len(file.content) > OPENAI_HARD_FILE_LIMIT_BYTES for file in pdf_files):
        return True

    # Trigger hidden KMZ preprocessing before hitting the hard file ceiling to
    # keep attachment payloads safely under provider limits.
    return len(pdf_files) > 1 and total_pdf_bytes > OPENAI_BATCH_TARGET_BYTES


def validate_kmz_pdf_count_or_raise(
    *,
    message: str,
    files: list[InMemoryChatFile],
) -> None:
    """Enforce a hard safety cap on KMZ packet PDF count.

    We only validate when the user is asking for KMZ/KML output.
    """
    if not _looks_like_kmz_request(message):
        return

    pdf_count = sum(1 for file in files if _is_pdf_file(file))
    if pdf_count <= KMZ_PACKET_MAX_PDFS:
        return

    raise RuntimeError(
        "KMZ packet preprocessing supports up to "
        f"{KMZ_PACKET_MAX_PDFS} PDF files per request. "
        f"Received {pdf_count} PDFs."
    )


def plan_kmz_pdf_batches(
    files: list[InMemoryChatFile],
    batch_target_bytes: int = OPENAI_BATCH_TARGET_BYTES,
    hard_file_limit_bytes: int = OPENAI_HARD_FILE_LIMIT_BYTES,
) -> KmzBatchPlan:
    pdf_files = [file for file in files if _is_pdf_file(file)]
    oversized_files: list[str] = []
    batches: list[KmzBatch] = []
    current_files: list[InMemoryChatFile] = []
    current_bytes = 0

    for file in pdf_files:
        file_size = len(file.content)
        if file_size > hard_file_limit_bytes:
            oversized_files.append(file.filename or str(file.file_id))
            continue

        if current_files and current_bytes + file_size > batch_target_bytes:
            batches.append(
                KmzBatch(
                    batch_index=len(batches) + 1,
                    file_ids=[str(item.file_id) for item in current_files],
                    filenames=[item.filename or str(item.file_id) for item in current_files],
                    total_bytes=current_bytes,
                )
            )
            current_files = []
            current_bytes = 0

        current_files.append(file)
        current_bytes += file_size

    if current_files:
        batches.append(
            KmzBatch(
                batch_index=len(batches) + 1,
                file_ids=[str(item.file_id) for item in current_files],
                filenames=[item.filename or str(item.file_id) for item in current_files],
                total_bytes=current_bytes,
            )
        )

    return KmzBatchPlan(
        batches=batches,
        oversized_files=oversized_files,
        total_pdf_bytes=sum(len(file.content) for file in pdf_files),
    )


def _strip_json_wrappers(text: str) -> str:
    block_match = _JSON_BLOCK_RE.search(text)
    if block_match:
        return block_match.group(1).strip()

    object_match = _JSON_OBJECT_RE.search(text)
    if object_match:
        return object_match.group(1).strip()

    return text.strip()


def _chat_loaded_file(file: InMemoryChatFile) -> ChatLoadedFile:
    return ChatLoadedFile(
        file_id=file.file_id,
        content=file.content,
        file_type=file.file_type,
        filename=file.filename,
        content_text=None,
        token_count=0,
    )


def _build_openai_file_data_uri(filename: str, file_bytes_b64: str) -> str:
    mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return f"data:{mime_type};base64,{file_bytes_b64}"


def _extract_responses_output_text(response: Any) -> str:
    output_text = getattr(response, "output_text", None)
    if isinstance(output_text, str) and output_text.strip():
        return output_text

    if isinstance(response, dict):
        raw_text = response.get("output_text")
        if isinstance(raw_text, str) and raw_text.strip():
            return raw_text
        output_items = response.get("output") or []
    else:
        output_items = getattr(response, "output", None) or []

    text_fragments: list[str] = []
    for item in output_items:
        if isinstance(item, dict):
            content = item.get("content") or []
        else:
            content = getattr(item, "content", None) or []
        for content_item in content:
            if isinstance(content_item, dict):
                content_type = content_item.get("type")
                if content_type in {"output_text", "text"}:
                    text_value = content_item.get("text")
                    if isinstance(text_value, str):
                        text_fragments.append(text_value)
            else:
                content_type = getattr(content_item, "type", None)
                if content_type in {"output_text", "text"}:
                    text_value = getattr(content_item, "text", None)
                    if isinstance(text_value, str):
                        text_fragments.append(text_value)

    return "".join(text_fragments)


def _responses_reasoning_effort(
    *,
    model_name: str,
    deployment_name: str | None,
) -> str:
    model_ref = f"{deployment_name or ''} {model_name}".lower()
    # Azure GPT-5.3 chat currently requires "medium" and rejects "low".
    if "gpt-5.3-chat" in model_ref or "gpt-5-3-chat" in model_ref:
        return "medium"
    return "low"


def _responses_supports_temperature(
    *,
    model_name: str,
    deployment_name: str | None,
) -> bool:
    model_ref = f"{deployment_name or ''} {model_name}".lower()
    if "gpt-5.3-chat" in model_ref or "gpt-5-3-chat" in model_ref:
        return False
    return True


def _google_api_key() -> str | None:
    key = os.environ.get("GOOGLE_API_KEY", "").strip()
    return key or None


def _build_google_headers(field_mask: str) -> dict[str, str] | None:
    api_key = _google_api_key()
    if not api_key:
        return None
    return {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": field_mask,
    }


def _google_places_post_local(
    endpoint: str,
    payload: dict[str, Any],
    field_mask: str,
) -> dict[str, Any]:
    headers = _build_google_headers(field_mask)
    if not headers:
        return {
            "error": (
                "GOOGLE_API_KEY is not configured on the server environment. "
                "Set GOOGLE_API_KEY before KMZ extraction."
            ),
        }

    try:
        response = httpx.post(
            f"{_GOOGLE_PLACES_BASE_URL}{endpoint}",
            headers=headers,
            json=payload,
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as e:
        try:
            detail: Any = e.response.json()
        except Exception:
            detail = e.response.text
        return {"error": "Google Places request failed", "details": detail}
    except httpx.RequestError as e:
        return {"error": f"Google Places network request failed: {e}"}


def _normalize_place(place: dict[str, Any]) -> dict[str, Any]:
    location = place.get("location") or {}
    return {
        "id": place.get("id"),
        "name": (place.get("displayName") or {}).get("text"),
        "formatted_address": place.get("formattedAddress"),
        "latitude": location.get("latitude"),
        "longitude": location.get("longitude"),
        "types": place.get("types", []),
        "google_maps_uri": place.get("googleMapsUri"),
    }


def _hidden_google_places_search_text(
    query: str,
    limit: int = 5,
    language_code: str | None = None,
    region_code: str | None = None,
    location_bias_latitude: float | None = None,
    location_bias_longitude: float | None = None,
    location_bias_radius_meters: float | None = None,
) -> dict[str, Any]:
    max_result_count = max(1, min(limit, 20))
    payload: dict[str, Any] = {
        "textQuery": query,
        "maxResultCount": max_result_count,
    }
    if language_code:
        payload["languageCode"] = language_code
    if region_code:
        payload["regionCode"] = region_code
    has_bias_center = (
        location_bias_latitude is not None and location_bias_longitude is not None
    )
    if has_bias_center:
        payload["locationBias"] = {
            "circle": {
                "center": {
                    "latitude": location_bias_latitude,
                    "longitude": location_bias_longitude,
                },
                "radius": location_bias_radius_meters or 5000.0,
            }
        }

    result = _google_places_post_local(
        endpoint="/places:searchText",
        payload=payload,
        field_mask=_DEFAULT_SEARCH_FIELD_MASK,
    )
    if result.get("error"):
        return {"query": query, "places": [], "total_results": 0, **result}

    places = [_normalize_place(place) for place in result.get("places", [])]
    return {
        "query": query,
        "total_results": len(places),
        "places": places,
    }


def _hidden_google_places_geocode_address(
    address: str,
    region_code: str | None = None,
) -> dict[str, Any]:
    result = _hidden_google_places_search_text(
        query=address,
        limit=5,
        region_code=region_code,
    )
    if result.get("error"):
        return {"address": address, "best_match": None, "alternatives": [], **result}

    places = result.get("places", [])
    best_match = places[0] if places else None
    return {
        "address": address,
        "best_match": best_match,
        "alternatives": places[1:] if len(places) > 1 else [],
        "total_results": result.get("total_results", 0),
    }


def _hidden_google_places_get_place_details(
    place_id: str,
    language_code: str | None = None,
) -> dict[str, Any]:
    headers = _build_google_headers(_DEFAULT_PLACE_DETAIL_FIELD_MASK)
    if not headers:
        return {
            "error": (
                "GOOGLE_API_KEY is not configured on the server environment. "
                "Set GOOGLE_API_KEY before KMZ extraction."
            ),
            "place": None,
        }

    params: dict[str, str] = {}
    if language_code:
        params["languageCode"] = language_code

    try:
        response = httpx.get(
            f"{_GOOGLE_PLACES_BASE_URL}/places/{quote(place_id, safe='')}",
            headers=headers,
            params=params or None,
            timeout=30.0,
        )
        response.raise_for_status()
        return {"place": _normalize_place(response.json())}
    except httpx.HTTPStatusError as e:
        try:
            detail: Any = e.response.json()
        except Exception:
            detail = e.response.text
        return {"error": "Google Place details request failed", "details": detail}
    except httpx.RequestError as e:
        return {"error": f"Google Place details network request failed: {e}"}


def _kmz_hidden_tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": "google_places_geocode_address",
            "description": (
                "Resolve an address or intersection-like text into a best coordinate "
                "candidate with alternatives."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "address": {"type": "string"},
                    "region_code": {"type": "string"},
                },
                "required": ["address"],
                "additionalProperties": False,
            },
        },
        {
            "type": "function",
            "name": "google_places_search_text",
            "description": (
                "Search Google Places for address-like or landmark text and return "
                "candidate places with coordinates."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"},
                    "language_code": {"type": "string"},
                    "region_code": {"type": "string"},
                    "location_bias_latitude": {"type": "number"},
                    "location_bias_longitude": {"type": "number"},
                    "location_bias_radius_meters": {"type": "number"},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
        {
            "type": "function",
            "name": "google_places_get_place_details",
            "description": "Resolve canonical details for a specific place ID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "place_id": {"type": "string"},
                    "language_code": {"type": "string"},
                },
                "required": ["place_id"],
                "additionalProperties": False,
            },
        },
    ]


def _kmz_hidden_tool_handlers() -> dict[str, Callable[..., dict[str, Any]]]:
    return {
        "google_places_geocode_address": _hidden_google_places_geocode_address,
        "google_places_search_text": _hidden_google_places_search_text,
        "google_places_get_place_details": _hidden_google_places_get_place_details,
    }


def _extract_responses_tool_calls(response: Any) -> list[dict[str, str]]:
    output_items: list[Any]
    if isinstance(response, dict):
        output_items = response.get("output") or []
    else:
        output_items = getattr(response, "output", None) or []

    calls: list[dict[str, str]] = []
    for item in output_items:
        if isinstance(item, dict):
            item_type = item.get("type")
            call_id = item.get("call_id")
            tool_name = item.get("name")
            arguments = item.get("arguments")
        else:
            item_type = getattr(item, "type", None)
            call_id = getattr(item, "call_id", None)
            tool_name = getattr(item, "name", None)
            arguments = getattr(item, "arguments", None)

        if item_type != "function_call":
            continue
        if not isinstance(call_id, str) or not call_id:
            continue
        if not isinstance(tool_name, str) or not tool_name:
            continue
        if not isinstance(arguments, str):
            arguments = "{}"
        calls.append(
            {"call_id": call_id, "name": tool_name, "arguments": arguments}
        )

    return calls


def _response_id(response: Any) -> str | None:
    if isinstance(response, dict):
        value = response.get("id")
    else:
        value = getattr(response, "id", None)
    return value if isinstance(value, str) and value else None


def _build_batch_prompt(
    *,
    user_message: str,
    batch_index: int,
    total_batches: int,
    filenames: list[str],
) -> str:
    return f"""
You are performing hidden preprocessing for a packet-to-KMZ workflow.

Original user request:
{user_message}

You are only looking at batch {batch_index} of {total_batches}.
Source packet files in this batch:
{json.dumps(filenames, indent=2)}

Extract only the structured packet facts needed for final KMZ generation.
Return JSON only. Do not include markdown fences or prose.

JSON schema:
{{
  "source_files": ["string"],
  "anchors": [
    {{
      "source_file": "string",
      "address": "string",
      "coordinates": {{"lat": 0.0, "lon": 0.0}},
      "confidence": "exact|approximate|missing",
      "notes": "string"
    }}
  ],
  "features": [
    {{
      "source_file": "string",
      "name": "string",
      "feature_type": "string",
      "address": "string",
      "geometry_hint": {{"point": {{"lat": 0.0, "lon": 0.0}}}},
      "provenance": "exact|inferred",
      "notes": "string"
    }}
  ],
  "warnings": ["string"]
}}

Rules:
- Preserve uncertainty instead of inventing certainty.
- If coordinates are unavailable, include addresses / geometry hints / notes.
- Use the available geocoding tools to resolve any anchor or feature address that
  lacks coordinates. Populate coordinates when a tool returns a best match.
- Prioritize extraction of electric distribution assets from packet maps:
  - poles / pole tags,
  - transformers,
  - service points and other point assets that should appear as placemarks.
- For pole labels shown on the map (for example `P1`, `P2`, `P3`), emit one
  separate `pole` feature per label. Do not collapse multiple labeled poles
  into a single feature.
- Treat common pole-label variants as the same label family, including
  `P1`, `P 1`, `P-1`, and `P - 1` (and equivalent numbering).
- Normalize marker naming to `Pole P<number>` while preserving the original map
  label text in `notes`.
- Preserve map pole labels in `name` (for example `Pole P1`) and include label
  evidence in `notes`.
- For each labeled pole, include pole-specific work scope in `notes` when
  present (for example `DEMO:` and `INSTALL:` items, quantities, pole class,
  transformer size, guy/anchor, and hardware notes).
- If equipment/work items are tied to a specific pole label, attach them to
  that pole feature's `notes` so the marker description carries the full pole
  context.
- When exact pole GPS is unavailable, still return planning-grade approximate
  pole coordinates. Use nearest geocoded anchors/intersections/service
  addresses and map-relative placement cues to place distinct pole points.
- If multiple poles are near the same anchor, give each pole a distinct
  approximate point (small spatial offsets are acceptable) and document this
  in `notes` with `provenance`=`inferred`.
- Do not model linework, spans, or conductor connections in the output.
- Use `feature_type` values that are explicit (`pole`, `transformer`, `service_point`, etc.).
- When map drawings imply asset placement but exact coordinates are missing, still emit `features`
  with planning-grade approximate geometry hints and clear provenance notes.
- If a source is spreadsheet-like (xlsx/xls), extract structured asset rows and map them into
  anchors/features using the closest schema-aligned interpretation.
- Only keep coordinates as missing if tool calls fail to find a credible location.
- Prefer empty arrays over omitted fields.
- Include every warning that may affect final KMZ quality.
""".strip()


def _build_single_file_prompt(
    *,
    user_message: str,
    source_filename: str,
) -> str:
    return f"""
You are performing hidden preprocessing for a packet-to-KMZ workflow.

Original user request:
{user_message}

You are only looking at this single source file:
{source_filename}

Extract only the structured packet facts needed for final KMZ generation.
Return JSON only. Do not include markdown fences or prose.

JSON schema:
{{
  "source_files": ["string"],
  "anchors": [
    {{
      "source_file": "string",
      "address": "string",
      "coordinates": {{"lat": 0.0, "lon": 0.0}},
      "confidence": "exact|approximate|missing",
      "notes": "string"
    }}
  ],
  "features": [
    {{
      "source_file": "string",
      "name": "string",
      "feature_type": "string",
      "address": "string",
      "geometry_hint": {{"point": {{"lat": 0.0, "lon": 0.0}}}},
      "provenance": "exact|inferred",
      "notes": "string"
    }}
  ],
  "warnings": ["string"]
}}

Rules:
- Preserve uncertainty instead of inventing certainty.
- If coordinates are unavailable, include addresses / geometry hints / notes.
- Use the available geocoding tools to resolve any anchor or feature address that
  lacks coordinates. Populate coordinates when a tool returns a best match.
- Prioritize extraction of electric distribution assets from packet maps:
  - poles / pole tags,
  - transformers,
  - service points and other point assets that should appear as placemarks.
- For pole labels shown on the map (for example `P1`, `P2`, `P3`), emit one
  separate `pole` feature per label. Do not collapse multiple labeled poles
  into a single feature.
- Treat common pole-label variants as the same label family, including
  `P1`, `P 1`, `P-1`, and `P - 1` (and equivalent numbering).
- Normalize marker naming to `Pole P<number>` while preserving the original map
  label text in `notes`.
- Preserve map pole labels in `name` (for example `Pole P1`) and include label
  evidence in `notes`.
- For each labeled pole, include pole-specific work scope in `notes` when
  present (for example `DEMO:` and `INSTALL:` items, quantities, pole class,
  transformer size, guy/anchor, and hardware notes).
- If equipment/work items are tied to a specific pole label, attach them to
  that pole feature's `notes` so the marker description carries the full pole
  context.
- When exact pole GPS is unavailable, still return planning-grade approximate
  pole coordinates. Use nearest geocoded anchors/intersections/service
  addresses and map-relative placement cues to place distinct pole points.
- If multiple poles are near the same anchor, give each pole a distinct
  approximate point (small spatial offsets are acceptable) and document this
  in `notes` with `provenance`=`inferred`.
- Do not model linework, spans, or conductor connections in the output.
- Use `feature_type` values that are explicit (`pole`, `transformer`, `service_point`, etc.).
- When map drawings imply asset placement but exact coordinates are missing, still emit `features`
  with planning-grade approximate geometry hints and clear provenance notes.
- If this source is spreadsheet-like (xlsx/xls), extract structured asset rows and map them into
  anchors/features using the closest schema-aligned interpretation.
- Only keep coordinates as missing if tool calls fail to find a credible location.
- If extraction is limited, include a warning explaining why.
- Prefer empty arrays over omitted fields.
""".strip()


def _parse_batch_extraction_response(response_text: str) -> KmzBatchExtractionResult:
    parsed = json.loads(_strip_json_wrappers(response_text))
    return KmzBatchExtractionResult.model_validate(parsed)


def _stable_dict_key(payload: dict) -> str:
    normalized = {
        key: value
        for key, value in payload.items()
        if value not in (None, "", [], {})
    }
    return json.dumps(normalized, sort_keys=True, separators=(",", ":"))


def merge_kmz_batch_results(
    batch_results: list[KmzBatchExtractionResult],
    *,
    requested_output_mode: str,
    skipped_files: list[str],
    failed_batches: list[str],
) -> KmzMergedPacketModel:
    seen_anchors: set[str] = set()
    seen_features: set[str] = set()
    seen_connections: set[str] = set()
    anchors: list[dict] = []
    features: list[dict] = []
    connections: list[dict] = []
    warnings: list[str] = []
    warning_set: set[str] = set()
    source_files: list[str] = []
    source_file_set: set[str] = set()
    packet_model_map: dict[str, KmzPacketModel] = {}
    packet_seen_anchors: dict[str, set[str]] = {}
    packet_seen_features: dict[str, set[str]] = {}
    packet_seen_connections: dict[str, set[str]] = {}

    def _get_packet_model(source_file: str) -> KmzPacketModel:
        model = packet_model_map.get(source_file)
        if model is None:
            model = KmzPacketModel(source_file=source_file)
            packet_model_map[source_file] = model
            packet_seen_anchors[source_file] = set()
            packet_seen_features[source_file] = set()
            packet_seen_connections[source_file] = set()
        return model

    for result in batch_results:
        for source_file in result.source_files:
            if source_file not in source_file_set:
                source_file_set.add(source_file)
                source_files.append(source_file)
            _get_packet_model(source_file)

        for anchor in result.anchors:
            key = _stable_dict_key(anchor)
            if key not in seen_anchors:
                seen_anchors.add(key)
                anchors.append(anchor)
            source_file = str(anchor.get("source_file") or "unknown")
            packet_model = _get_packet_model(source_file)
            packet_key = _stable_dict_key(anchor)
            if packet_key not in packet_seen_anchors[source_file]:
                packet_seen_anchors[source_file].add(packet_key)
                packet_model.anchors.append(anchor)

        for feature in result.features:
            key = _stable_dict_key(feature)
            if key not in seen_features:
                seen_features.add(key)
                features.append(feature)
            source_file = str(feature.get("source_file") or "unknown")
            packet_model = _get_packet_model(source_file)
            packet_key = _stable_dict_key(feature)
            if packet_key not in packet_seen_features[source_file]:
                packet_seen_features[source_file].add(packet_key)
                packet_model.features.append(feature)

        for connection in result.connections:
            key = _stable_dict_key(connection)
            if key not in seen_connections:
                seen_connections.add(key)
                connections.append(connection)
            source_file = str(connection.get("source_file") or "unknown")
            packet_model = _get_packet_model(source_file)
            packet_key = _stable_dict_key(connection)
            if packet_key not in packet_seen_connections[source_file]:
                packet_seen_connections[source_file].add(packet_key)
                packet_model.connections.append(connection)

        for warning in result.warnings:
            if warning not in warning_set:
                warning_set.add(warning)
                warnings.append(warning)
            for source_file in result.source_files:
                packet_model = _get_packet_model(source_file)
                if warning not in packet_model.warnings:
                    packet_model.warnings.append(warning)

    return KmzMergedPacketModel(
        requested_output_mode=requested_output_mode,
        source_files=source_files,
        packet_models=[packet_model_map[source_file] for source_file in source_files],
        anchors=anchors,
        features=features,
        connections=connections,
        warnings=warnings,
        skipped_files=skipped_files,
        failed_batches=failed_batches,
    )


def build_kmz_batch_additional_context(merged: KmzMergedPacketModel) -> str:
    payload = _strip_connections_from_packet_payload(merged.model_dump(mode="json"))
    return (
        "KMZ packet preprocessing summary:\n"
        "- The attached packet PDFs were preprocessed in hidden batches because the raw "
        "OpenAI attachment payload would exceed file limits.\n"
        "- Use the structured packet data below as the canonical source for final KMZ/KML generation.\n"
        "- Respect requested_output_mode exactly:\n"
        "  - combined: create one combined KMZ across all packets.\n"
        "  - per_packet: create one KMZ per packet/source_file using packet_models.\n"
        "- Do not claim every source PDF was processed successfully if skipped_files or failed_batches are present.\n"
        "- If skipped_files or failed_batches are non-empty, explicitly state that the KMZ is partial/best-effort.\n\n"
        f"{json.dumps(payload, indent=2, sort_keys=True)}"
    )


def _result_has_structured_content(result: KmzBatchExtractionResult) -> bool:
    return bool(result.anchors or result.features)


def _provider_name(provider: str | Any) -> str:
    """Normalize provider values that may arrive as enums or plain strings."""
    if hasattr(provider, "value"):
        value = getattr(provider, "value")
        if isinstance(value, str):
            return value.lower()
    return str(provider).lower()


def _invoke_extraction_llm(
    *,
    llm: LLM,
    token_counter: Callable[[str], int],
    prompt_text: str,
    loaded_files: list[ChatLoadedFile],
    user_identity: LLMUserIdentity | None,
) -> str:
    system_text = (
        "You are a deterministic packet extraction assistant. "
        "Return only valid JSON matching the requested schema. "
        "Use geocoding tools to resolve missing coordinates when possible. "
        "Prioritize extracting every mapped electric pole as a separate feature."
    )

    provider = _provider_name(llm.config.model_provider)
    if provider in {
        LlmProviderNames.OPENAI.value,
        LlmProviderNames.AZURE.value,
    }:
        from onyx.llm.litellm_singleton import litellm

        response_input_content: list[dict[str, str]] = [
            {"type": "input_text", "text": prompt_text}
        ]
        for loaded_file in loaded_files:
            filename = loaded_file.filename or f"packet-{loaded_file.file_id}.bin"
            response_input_content.append(
                {
                    "type": "input_file",
                    "filename": filename,
                    "file_data": _build_openai_file_data_uri(
                        filename=filename,
                        file_bytes_b64=base64.b64encode(loaded_file.content).decode(
                            "utf-8"
                        ),
                    ),
                }
            )

        responses_model = (
            f"{llm.config.model_provider}/"
            f"{llm.config.deployment_name or llm.config.model_name}"
        )
        reasoning_effort = _responses_reasoning_effort(
            model_name=llm.config.model_name,
            deployment_name=llm.config.deployment_name,
        )
        responses_kwargs: dict[str, Any] = {
            "model": responses_model,
            "input": [{"role": "user", "content": response_input_content}],
            "instructions": system_text,
            "max_output_tokens": 10000,
            "reasoning": {"effort": reasoning_effort},
            "api_key": llm.config.api_key or None,
            "api_base": llm.config.api_base or None,
            "api_version": llm.config.api_version or None,
        }
        if _responses_supports_temperature(
            model_name=llm.config.model_name,
            deployment_name=llm.config.deployment_name,
        ):
            responses_kwargs["temperature"] = llm.config.temperature

        tool_definitions = _kmz_hidden_tool_definitions()
        tool_handlers = _kmz_hidden_tool_handlers()
        current_input: list[dict[str, Any]] = [
            {"role": "user", "content": response_input_content}
        ]
        previous_response_id: str | None = None

        for cycle_index in range(KMZ_EXTRACTION_TOOL_MAX_CYCLES):
            cycle_kwargs = dict(responses_kwargs)
            cycle_kwargs["input"] = current_input
            cycle_kwargs["tools"] = tool_definitions
            cycle_kwargs["tool_choice"] = (
                "auto"
                if cycle_index < KMZ_EXTRACTION_TOOL_MAX_CYCLES - 1
                else "none"
            )
            if previous_response_id:
                cycle_kwargs["previous_response_id"] = previous_response_id

            responses_result = litellm.responses(**cycle_kwargs)
            previous_response_id = _response_id(responses_result)

            tool_calls = _extract_responses_tool_calls(responses_result)
            if not tool_calls:
                extracted_text = _extract_responses_output_text(responses_result).strip()
                if extracted_text:
                    return extracted_text
                break

            tool_outputs: list[dict[str, str]] = []
            for tool_call in tool_calls:
                handler = tool_handlers.get(tool_call["name"])
                if handler is None:
                    output_payload: dict[str, Any] = {
                        "error": f"Unknown tool: {tool_call['name']}"
                    }
                else:
                    try:
                        parsed_args = json.loads(tool_call["arguments"] or "{}")
                        if not isinstance(parsed_args, dict):
                            parsed_args = {}
                    except json.JSONDecodeError:
                        parsed_args = {}
                    try:
                        output_payload = handler(**parsed_args)
                    except Exception as e:
                        output_payload = {
                            "error": f"Tool execution failed: {tool_call['name']}: {e}"
                        }

                tool_outputs.append(
                    {
                        "type": "function_call_output",
                        "call_id": tool_call["call_id"],
                        "output": json.dumps(output_payload),
                    }
                )

            current_input = tool_outputs

        raise RuntimeError(
            "Responses API extraction ended without a final JSON answer."
        )

    system_prompt = ChatMessageSimple(
        message=system_text,
        token_count=token_counter(system_text),
        message_type=MessageType.SYSTEM,
    )
    user_msg = ChatMessageSimple(
        message=prompt_text,
        token_count=token_counter(prompt_text),
        message_type=MessageType.USER,
        non_image_files=loaded_files,
    )
    llm_input = translate_history_to_llm_format([system_prompt, user_msg], llm.config)
    response = llm.invoke(
        prompt=llm_input,
        tools=None,
        tool_choice=None,
        max_tokens=10000,
        reasoning_effort=ReasoningEffort.LOW,
        user_identity=user_identity,
    )
    return response.choice.message.content or ""


def _extract_anchor_from_filename(filename: str) -> dict | None:
    stem = Path(filename).stem
    parts = [part.strip() for part in stem.split("_") if part.strip()]
    if not parts:
        return None

    address_segment: str | None = None
    city_code: str | None = None
    for index, part in enumerate(parts):
        if _FILENAME_ADDRESS_SEGMENT_RE.match(part):
            address_segment = part
            if index > 0:
                prev = parts[index - 1].upper()
                if prev in _CITY_CODE_TO_NAME:
                    city_code = prev
            break

    if not address_segment:
        return None

    # Normalize duplicate whitespace and preserve address token fidelity.
    normalized_address = " ".join(address_segment.split())
    city_name = _CITY_CODE_TO_NAME.get(city_code or "")
    full_address = (
        f"{normalized_address}, {city_name}, CO" if city_name else normalized_address
    )

    return {
        "source_file": filename,
        "address": full_address,
        "coordinates": {"lat": None, "lon": None},
        "confidence": "missing",
        "notes": "Derived from source filename; requires geocoding for placement.",
    }


def _inject_filename_anchor_fallbacks(
    merged: KmzMergedPacketModel,
    runtime_files: list[InMemoryChatFile],
) -> None:
    pdf_filenames = [
        file.filename or str(file.file_id)
        for file in runtime_files
        if _is_pdf_file(file)
    ]
    if not pdf_filenames:
        return

    packet_model_by_source = {
        packet.source_file: packet for packet in merged.packet_models
    }
    seen_anchor_keys = {_stable_dict_key(anchor) for anchor in merged.anchors}
    fallback_added = False

    for filename in pdf_filenames:
        fallback_anchor = _extract_anchor_from_filename(filename)
        if not fallback_anchor:
            continue

        key = _stable_dict_key(fallback_anchor)
        if key in seen_anchor_keys:
            continue

        seen_anchor_keys.add(key)
        merged.anchors.append(fallback_anchor)
        fallback_added = True

        if filename not in merged.source_files:
            merged.source_files.append(filename)
        packet_model = packet_model_by_source.get(filename)
        if packet_model is None:
            packet_model = KmzPacketModel(source_file=filename)
            merged.packet_models.append(packet_model)
            packet_model_by_source[filename] = packet_model
        packet_model.anchors.append(fallback_anchor)

    if fallback_added:
        warning = (
            "Some packet anchors were inferred from source filenames because "
            "structured map extraction was incomplete."
        )
        if warning not in merged.warnings:
            merged.warnings.append(warning)
        for packet_model in merged.packet_models:
            if warning not in packet_model.warnings:
                packet_model.warnings.append(warning)


def run_kmz_batch_preprocessing(
    *,
    llm: LLM,
    token_counter: Callable[[str], int],
    user_message: str,
    runtime_files: list[InMemoryChatFile],
    user_identity: LLMUserIdentity | None = None,
) -> KmzBatchingOutcome:
    normalized_runtime_files = _normalize_runtime_files_for_kmz(runtime_files)
    validate_kmz_pdf_count_or_raise(message=user_message, files=normalized_runtime_files)
    plan = plan_kmz_pdf_batches(normalized_runtime_files)
    requested_output_mode = detect_kmz_output_mode(user_message)
    pdf_file_ids = {
        str(file.file_id) for file in normalized_runtime_files if _is_pdf_file(file)
    }
    non_pdf_descriptors: list[FileDescriptor] = [
        file.to_file_descriptor()
        for file in normalized_runtime_files
        if str(file.file_id) not in pdf_file_ids
    ]

    if not plan.batches and plan.oversized_files:
        raise RuntimeError(
            "Unable to process KMZ packet PDFs because every PDF exceeded the 50MB OpenAI attachment limit: "
            + ", ".join(plan.oversized_files)
        )

    batch_results: list[KmzBatchExtractionResult] = []
    failed_batches: list[str] = []
    file_map = {str(file.file_id): file for file in normalized_runtime_files}
    batches_to_process: list[KmzBatch] = list(plan.batches)

    # XLSX/XLS-only workflows have no PDF batches; run one synthetic extraction
    # batch over non-PDF packet files so spreadsheet-driven KMZ flows are supported.
    if not batches_to_process:
        non_pdf_file_ids = [
            str(file.file_id)
            for file in normalized_runtime_files
            if str(file.file_id) not in pdf_file_ids
        ]
        if non_pdf_file_ids:
            batches_to_process = [
                KmzBatch(
                    batch_index=1,
                    file_ids=non_pdf_file_ids,
                    filenames=[
                        file_map[file_id].filename or file_id
                        for file_id in non_pdf_file_ids
                    ],
                    total_bytes=sum(len(file_map[file_id].content) for file_id in non_pdf_file_ids),
                )
            ]

    for batch in batches_to_process:
        batch_files = [_chat_loaded_file(file_map[file_id]) for file_id in batch.file_ids]
        batch_prompt = _build_batch_prompt(
            user_message=user_message,
            batch_index=batch.batch_index,
            total_batches=len(batches_to_process),
            filenames=batch.filenames,
        )
        response_text = _invoke_extraction_llm(
            llm=llm,
            token_counter=token_counter,
            prompt_text=batch_prompt,
            loaded_files=batch_files,
            user_identity=user_identity,
        )
        batch_result: KmzBatchExtractionResult | None = None
        batch_parse_error: str | None = None
        try:
            batch_result = _parse_batch_extraction_response(response_text)
        except Exception as e:
            batch_parse_error = str(e)

        if batch_result is not None and _result_has_structured_content(batch_result):
            batch_results.append(batch_result)
            continue

        # Secondary extraction pass: process each source file independently so one noisy
        # packet does not suppress extraction for the entire batch.
        per_file_results: list[KmzBatchExtractionResult] = []
        per_file_errors: list[str] = []
        for file_id, filename in zip(batch.file_ids, batch.filenames):
            single_file_prompt = _build_single_file_prompt(
                user_message=user_message,
                source_filename=filename,
            )
            single_file = [_chat_loaded_file(file_map[file_id])]
            try:
                single_file_response = _invoke_extraction_llm(
                    llm=llm,
                    token_counter=token_counter,
                    prompt_text=single_file_prompt,
                    loaded_files=single_file,
                    user_identity=user_identity,
                )
                parsed_single = _parse_batch_extraction_response(single_file_response)
                per_file_results.append(parsed_single)
            except Exception as e:
                per_file_errors.append(f"{filename}: {e}")

        if per_file_results:
            batch_results.extend(per_file_results)
            if per_file_errors:
                failed_batches.append(
                    f"Batch {batch.batch_index} per-file fallback failures: "
                    + "; ".join(per_file_errors)
                )
            continue

        failure_reason = (
            batch_parse_error
            if batch_parse_error
            else (
                "batch extraction returned no anchors/features and "
                "per-file fallback returned no parseable extraction."
            )
        )
        failed_batches.append(
            f"Batch {batch.batch_index} ({', '.join(batch.filenames)}): {failure_reason}"
        )

    if not batch_results:
        details = plan.oversized_files + failed_batches
        raise RuntimeError(
            "KMZ packet preprocessing failed for all packet batches. "
            + "; ".join(details)
        )

    merged = merge_kmz_batch_results(
        batch_results,
        requested_output_mode=requested_output_mode,
        skipped_files=plan.oversized_files,
        failed_batches=failed_batches,
    )
    _inject_filename_anchor_fallbacks(merged, normalized_runtime_files)
    return KmzBatchingOutcome(
        runtime_file_descriptors=non_pdf_descriptors,
        additional_context_appendix=build_kmz_batch_additional_context(merged),
    )
