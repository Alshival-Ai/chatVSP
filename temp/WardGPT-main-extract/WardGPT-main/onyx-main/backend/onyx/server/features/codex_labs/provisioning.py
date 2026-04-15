from __future__ import annotations

import io
import os
import re
from pathlib import Path
from urllib.parse import unquote
from urllib.parse import urlsplit
from urllib.parse import urlunsplit
import xml.etree.ElementTree as ET
import zipfile

from sqlalchemy import select
from sqlalchemy.orm import Session

from onyx.configs.app_configs import LOCAL_MCP_SERVER_ACTION_NAME
from onyx.configs.app_configs import LOCAL_MCP_SERVER_URL
from onyx.configs.app_configs import LOCAL_MCP_STATIC_API_KEY
from onyx.db.llm import fetch_default_llm_model
from onyx.db.mcp import extract_connection_data
from onyx.db.models import MCPServer
from onyx.llm.constants import LlmProviderNames
from onyx.utils.logger import setup_logger

logger = setup_logger()

CODEX_CONFIG_DIR_NAME = ".codex"
CODEX_CONFIG_FILE_NAME = "config.toml"
CODEX_SKILLS_DIR_NAME = "skills"
CODEX_AZURE_API_KEY_ENV_VAR = "AZURE_OPENAI_API_KEY"
CODEX_LABS_AZURE_MODEL_ENV_VAR = "CODEX_LABS_AZURE_MODEL"
CODEX_LABS_AZURE_BASE_URL_ENV_VAR = "CODEX_LABS_AZURE_BASE_URL"
CODEX_LABS_AZURE_API_KEY_ENV_VAR = "CODEX_LABS_AZURE_API_KEY"
CODEX_WARDGPT_MCP_BEARER_TOKEN_ENV_VAR = "WARDGPT_MCP_BEARER_TOKEN"
CODEX_WARDGPT_MCP_SERVER_KEY = "wardgpt"
DEFAULT_AZURE_CODEX_MODEL = "gpt-5.3-codex"
KMZ_SKILL_DIR_NAME = "kmz"
KMZ_SKILL_FILE_NAME = "SKILL.md"
KMZ_WORKBOOK_TEMPLATE_FILENAME = "P1_NWF_3.4.26_KMZ_Input_ALL_P1.xlsx"
KMZ_WORKBOOK_TEMPLATE_ASSETS_SUBDIR = Path("assets/kmz")
KMZ_USER_TEMPLATE_DIR_NAME = ".wardGPT"
KMZ_USER_TEMPLATE_FILENAME = "kmz-excel-template.xlsx"
KMZ_USER_TEMPLATE_MAX_ROWS = 10
SHELL_BASHRC_FILENAME = ".bashrc"
SHELL_BASH_PROFILE_FILENAME = ".bash_profile"
SHELL_BANNER_BLOCK_START = "# >>> codex-labs-banner >>>"
SHELL_BANNER_BLOCK_END = "# <<< codex-labs-banner <<<"
SHELL_BASH_PROFILE_BLOCK_START = "# >>> codex-labs-bash-profile >>>"
SHELL_BASH_PROFILE_BLOCK_END = "# <<< codex-labs-bash-profile <<<"


def provision_codex_home(home_dir: Path, db_session: Session) -> dict[str, str]:
    """Write Codex config for a user's home and return shell env overrides."""
    provision_codex_home_managed_files(home_dir=home_dir)

    azure_model, azure_base_url, azure_api_key = _resolve_azure_codex_settings(db_session)
    mcp_server_url, mcp_bearer_token = _resolve_local_mcp_settings(db_session)

    env_overrides: dict[str, str] = {}
    if azure_api_key:
        env_overrides[CODEX_AZURE_API_KEY_ENV_VAR] = azure_api_key
    if mcp_bearer_token:
        env_overrides[CODEX_WARDGPT_MCP_BEARER_TOKEN_ENV_VAR] = mcp_bearer_token

    config_text = _build_codex_config_toml(
        azure_model=azure_model,
        azure_base_url=azure_base_url,
        mcp_server_url=mcp_server_url,
        include_mcp_token_env=bool(mcp_bearer_token),
    )
    if config_text is None:
        return env_overrides

    codex_dir = home_dir / CODEX_CONFIG_DIR_NAME
    codex_dir.mkdir(parents=True, exist_ok=True)
    (codex_dir / CODEX_CONFIG_FILE_NAME).write_text(config_text, encoding="utf-8")

    return env_overrides


def provision_codex_home_managed_files(home_dir: Path) -> None:
    """Provision user-home files managed by Codex Labs."""
    _provision_kmz_template(home_dir=home_dir)
    _provision_kmz_skill(home_dir=home_dir)
    _provision_shell_profile_banner(home_dir=home_dir)
    _provision_bash_profile(home_dir=home_dir)


def _resolve_azure_codex_settings(
    db_session: Session,
) -> tuple[str | None, str | None, str | None]:
    env_model_name = os.environ.get(CODEX_LABS_AZURE_MODEL_ENV_VAR, "").strip()
    env_api_base_raw = os.environ.get(CODEX_LABS_AZURE_BASE_URL_ENV_VAR, "").strip()
    env_api_key = os.environ.get(CODEX_LABS_AZURE_API_KEY_ENV_VAR, "").strip() or None
    env_api_base = _normalize_azure_base_url_for_codex(env_api_base_raw)

    default_model = fetch_default_llm_model(db_session)
    if not default_model:
        if env_api_base and env_api_key:
            return (
                env_model_name or DEFAULT_AZURE_CODEX_MODEL,
                env_api_base,
                env_api_key,
            )
        return None, None, None

    provider = default_model.llm_provider
    api_base = provider.api_base or ""
    normalized_api_base = api_base.lower()
    is_azure_provider = provider.provider == str(LlmProviderNames.AZURE) or (
        ".openai.azure.com" in normalized_api_base
    ) or (".cognitiveservices.azure.com" in normalized_api_base)
    if not is_azure_provider:
        if env_api_base and env_api_key:
            return (
                env_model_name or DEFAULT_AZURE_CODEX_MODEL,
                env_api_base,
                env_api_key,
            )
        return None, None, None

    deployment_name = (provider.deployment_name or "").strip() or (
        _extract_azure_deployment_name_from_api_base(api_base) or ""
    )

    derived_base_url = _normalize_azure_base_url_for_codex(api_base)
    derived_api_key = (
        provider.api_key.get_value(apply_mask=False) if provider.api_key else None
    )
    derived_model_name = (
        deployment_name
        or (default_model.name or "").strip()
        or DEFAULT_AZURE_CODEX_MODEL
    )
    azure_base_url = env_api_base or derived_base_url
    azure_api_key = env_api_key or derived_api_key
    model_name = env_model_name or derived_model_name

    if not azure_base_url or not azure_api_key:
        logger.warning(
            "Codex Labs Azure bootstrap skipped due to missing Azure api_base or api_key. "
            "Checked dedicated Codex Labs overrides first, then default Azure provider."
        )
        return None, None, None

    return model_name, azure_base_url, azure_api_key


def _provision_kmz_template(home_dir: Path) -> None:
    wardgpt_dir = home_dir / KMZ_USER_TEMPLATE_DIR_NAME
    destination = wardgpt_dir / KMZ_USER_TEMPLATE_FILENAME

    source = _resolve_kmz_workbook_template_path()
    if source is None:
        logger.warning(
            "Codex Labs KMZ template bootstrap skipped; source file not found: %s",
            KMZ_WORKBOOK_TEMPLATE_FILENAME,
        )
        return

    try:
        source_content = source.read_bytes()
    except OSError:
        logger.exception(
            "Codex Labs KMZ template bootstrap failed reading source: %s",
            source,
        )
        return

    truncated_content = _truncate_xlsx_content_to_row_limit(
        content=source_content,
        max_rows=KMZ_USER_TEMPLATE_MAX_ROWS,
    )

    try:
        wardgpt_dir.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(truncated_content)
    except OSError:
        logger.exception(
            "Codex Labs KMZ template bootstrap failed from %s to %s",
            source,
            destination,
        )


def _truncate_xlsx_content_to_row_limit(
    *,
    content: bytes,
    max_rows: int,
) -> bytes:
    if max_rows <= 0:
        return content

    try:
        with zipfile.ZipFile(io.BytesIO(content), mode="r") as source_zip:
            zip_entries = {
                info.filename: source_zip.read(info.filename)
                for info in source_zip.infolist()
            }
    except Exception:
        logger.warning(
            "Codex Labs KMZ template is not parseable as XLSX; using unmodified content."
        )
        return content

    mutated = False
    ns_uri = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    row_tag = f"{{{ns_uri}}}row"
    dimension_tag = f"{{{ns_uri}}}dimension"
    sheetdata_tag = f"{{{ns_uri}}}sheetData"

    worksheet_paths = [
        path
        for path in zip_entries
        if path.startswith("xl/worksheets/") and path.endswith(".xml")
    ]

    for worksheet_path in worksheet_paths:
        worksheet_bytes = zip_entries.get(worksheet_path)
        if not worksheet_bytes:
            continue
        try:
            root = ET.fromstring(worksheet_bytes)
        except ET.ParseError:
            continue

        sheet_data = root.find(f".//{sheetdata_tag}")
        if sheet_data is None:
            continue

        rows = list(sheet_data.findall(row_tag))
        if not rows:
            continue

        rows_removed = False
        sequential_row = 1
        for row in rows:
            row_attr = row.attrib.get("r")
            if row_attr and row_attr.isdigit():
                row_index = int(row_attr)
            else:
                row_index = sequential_row
            sequential_row += 1

            if row_index > max_rows:
                sheet_data.remove(row)
                rows_removed = True

        if not rows_removed:
            continue

        mutated = True

        dimension = root.find(dimension_tag)
        if dimension is not None:
            ref = dimension.attrib.get("ref")
            if ref:
                dimension.attrib["ref"] = _truncate_sheet_dimension_ref(
                    dimension_ref=ref,
                    max_rows=max_rows,
                )

        zip_entries[worksheet_path] = ET.tostring(
            root,
            encoding="utf-8",
            xml_declaration=True,
        )

    if not mutated:
        return content

    output = io.BytesIO()
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as target:
        for path, payload in zip_entries.items():
            target.writestr(path, payload)
    return output.getvalue()


_A1_REF_ROW_RE = re.compile(r"^([A-Za-z]+)(\d+)$")


def _truncate_sheet_dimension_ref(*, dimension_ref: str, max_rows: int) -> str:
    parts = dimension_ref.split(":", 1)
    if len(parts) != 2:
        return dimension_ref

    start_cell, end_cell = parts
    end_match = _A1_REF_ROW_RE.match(end_cell)
    if not end_match:
        return dimension_ref

    end_col, end_row_str = end_match.groups()
    end_row = int(end_row_str)
    if end_row <= max_rows:
        return dimension_ref

    return f"{start_cell}:{end_col}{max_rows}"


def _resolve_kmz_workbook_template_path() -> Path | None:
    provisioning_path = Path(__file__).resolve()
    candidate_roots = [Path.cwd()]

    # Support both monorepo and runtime layouts.
    for parent_index in (4, 5, 6):
        if len(provisioning_path.parents) > parent_index:
            candidate_roots.append(provisioning_path.parents[parent_index])

    seen_roots: set[str] = set()
    for root in candidate_roots:
        root_key = str(root)
        if root_key in seen_roots:
            continue
        seen_roots.add(root_key)

        for candidate in (
            root / KMZ_WORKBOOK_TEMPLATE_ASSETS_SUBDIR / KMZ_WORKBOOK_TEMPLATE_FILENAME,
            root / KMZ_WORKBOOK_TEMPLATE_FILENAME,
        ):
            if candidate.is_file():
                return candidate

    return None


def _provision_kmz_skill(home_dir: Path) -> None:
    skill_text = _build_kmz_skill_markdown()
    skill_path = (
        home_dir
        / CODEX_CONFIG_DIR_NAME
        / CODEX_SKILLS_DIR_NAME
        / KMZ_SKILL_DIR_NAME
        / KMZ_SKILL_FILE_NAME
    )

    try:
        skill_path.parent.mkdir(parents=True, exist_ok=True)
        # Intentionally overwrite to keep guidance managed and current.
        skill_path.write_text(skill_text, encoding="utf-8")
    except OSError:
        logger.exception(
            "Codex Labs KMZ skill provisioning failed for home directory: %s",
            home_dir,
        )


def _build_kmz_skill_markdown() -> str:
    lines = [
        "---",
        'name: "kmz"',
        (
            'description: "Use for KMZ/KML workflows requiring geocoding, '
            'KMZ generation, and companion XLSX output."'
        ),
        "---",
        "",
        "# KMZ Skill",
        "",
        "Use this skill when the user asks to work with KMZ or KML data.",
        "",
        "## Core workflow",
        "",
        "- Treat KMZ/KML tasks as geospatial workflows.",
        (
            "- Do not write intermediate files next to the source packet PDFs "
            "(avoid clutter in user project folders)."
        ),
        (
            "- MANDATORY for packet PDFs: call MCP tool "
            "`extract_kmz_packet_from_base64` as the first extraction step. "
            "Do this before any manual parsing/geocoding workflow."
        ),
        (
            "- Preferred input to that tool is `codex_labs_paths` (relative paths like "
            "`Packets/file.pdf`) so large files are fetched server-side without giant "
            "base64 tool arguments."
        ),
        (
            "- Excel-driven KMZ workflows are supported: pass `.xlsx`/`.xls` packet "
            "files to the same extractor tool (with or without PDFs)."
        ),
        (
            "- Use `files[{ filename, content_base64 }]` only when path-based input "
            "is unavailable or the file is small enough for tool-argument limits."
        ),
        (
            "- Do not print full base64 blobs to terminal output. Read/store base64 "
            "in-memory or in temporary files and pass it directly to tool calls."
        ),
        (
            "- Keep `geocode_missing_anchors=true` in the extractor call unless the "
            "user explicitly asks not to geocode."
        ),
        (
            "- Treat coordinates returned by `extract_kmz_packet_from_base64` as "
            "authoritative for that run. Do not re-geocode those same assets."
        ),
        (
            "- Only call geocoding tools after extraction when an anchor/feature "
            "still has missing or invalid coordinates (`null`, `0.0/0.0`, or absent) "
            "or when the user explicitly asks for additional geocoding refinement."
        ),
        (
            "- Never geocode extra addresses just because they are mentioned in notes "
            "if extractor coordinates already exist for the mapped assets."
        ),
        (
            "- Include `.xlsx` templates as supplemental context when relevant."
        ),
        (
            "- Do NOT skip the extractor and jump directly to `pdftotext`, "
            "`pdftoppm`, or manual geocoding while the extractor tool is available."
        ),
        (
            "- There are maps within the packets that you must use to estimate pole "
            "and asset positions. Do not rely only on address geocoding, because "
            "geocoding may be incomplete or inaccurate."
        ),
        (
            "- Parse packet PDFs for addresses, pole labels, transformer references, "
            "span notes, and map/layout context before placing assets."
        ),
        (
            "- Preserve coordinate ordering (`lon,lat[,alt]`) and avoid silently "
            "dropping placemarks/styles."
        ),
        (
            "- Prefer dedicated geocoding tools when available: "
            "`google_places_geocode_address`, "
            "`google_places_search_text`, "
            "`google_places_get_place_details`."
        ),
        (
            "- If geocoding tools are unavailable, use internet-search geocoding "
            "fallbacks when possible."
        ),
        (
            "- If no geocoding capability is available, ask the user for at least "
            "one anchor coordinate or map pin."
        ),
        (
            "- Approximate electric pole positions from packet map context using a "
            "deterministic approach: (1) use extractor-provided coordinates first, "
            "(2) geocode only unresolved anchors/features, "
            "(3) infer relative offsets/topology from map drawings, "
            "(4) place poles/transformers/spans, "
            "(5) mark coordinates as planning-grade estimates, "
            "(6) provide detailed notes in KMZ file/object descriptions."
        ),
        "",
        "## Deliverables",
        "",
        (
            "- When generating a KMZ deliverable, also generate a companion `.xlsx` "
            "deliverable in the same response."
        ),
        (
            "- Prefer template-first XLSX generation using "
            "`~/.wardGPT/kmz-excel-template.xlsx` when present."
        ),
        (
            "- Treat that workbook as a schema/template reference only. "
            "Its existing sample/example rows are placeholders and must not be "
            "copied into final output unless the user explicitly asks to keep them."
        ),
        (
            "- If that file is unavailable, look for "
            "`P1_NWF_3.4.26_KMZ_Input_ALL_P1.xlsx` in runtime files."
        ),
        (
            "- If no template workbook is available, clearly state that and request "
            "it before finalizing template-based output."
        ),
        (
            "- Preserve template sheet layout and formulas; only populate the "
            "required row data."
        ),
        "",
        "## Output formatting",
        "",
        (
            "- Share generated files using exact markdown link format: "
            "`[filename](file_link)`."
        ),
        "",
    ]
    return "\n".join(lines)


def _provision_shell_profile_banner(home_dir: Path) -> None:
    bashrc_path = home_dir / SHELL_BASHRC_FILENAME
    managed_block = _build_shell_banner_block()
    try:
        existing = (
            bashrc_path.read_text(encoding="utf-8") if bashrc_path.exists() else ""
        )
    except OSError:
        logger.exception("Codex Labs failed reading shell profile: %s", bashrc_path)
        return

    sanitized_existing = _strip_legacy_shell_banner_lines(existing)
    next_text = _upsert_managed_bashrc_block(
        existing_text=sanitized_existing,
        managed_block=managed_block,
    )
    if next_text == existing:
        return

    try:
        bashrc_path.write_text(next_text, encoding="utf-8")
    except OSError:
        logger.exception("Codex Labs failed writing shell profile: %s", bashrc_path)


def _upsert_managed_bashrc_block(existing_text: str, managed_block: str) -> str:
    block_pattern = re.compile(
        rf"{re.escape(SHELL_BANNER_BLOCK_START)}\n.*?{re.escape(SHELL_BANNER_BLOCK_END)}\n?",
        flags=re.DOTALL,
    )
    if block_pattern.search(existing_text):
        return block_pattern.sub(managed_block, existing_text, count=1)

    trimmed = existing_text.rstrip("\n")
    if not trimmed:
        return managed_block
    return f"{trimmed}\n\n{managed_block}"


def _provision_bash_profile(home_dir: Path) -> None:
    bash_profile_path = home_dir / SHELL_BASH_PROFILE_FILENAME
    managed_block = _build_bash_profile_block()
    try:
        existing = (
            bash_profile_path.read_text(encoding="utf-8")
            if bash_profile_path.exists()
            else ""
        )
    except OSError:
        logger.exception(
            "Codex Labs failed reading login shell profile: %s", bash_profile_path
        )
        return

    next_text = _upsert_managed_profile_block(
        existing_text=existing,
        managed_block=managed_block,
        block_start=SHELL_BASH_PROFILE_BLOCK_START,
        block_end=SHELL_BASH_PROFILE_BLOCK_END,
    )
    if next_text == existing:
        return

    try:
        bash_profile_path.write_text(next_text, encoding="utf-8")
    except OSError:
        logger.exception(
            "Codex Labs failed writing login shell profile: %s", bash_profile_path
        )


def _upsert_managed_profile_block(
    existing_text: str,
    managed_block: str,
    block_start: str,
    block_end: str,
) -> str:
    block_pattern = re.compile(
        rf"{re.escape(block_start)}\n.*?{re.escape(block_end)}\n?",
        flags=re.DOTALL,
    )
    if block_pattern.search(existing_text):
        return block_pattern.sub(managed_block, existing_text, count=1)

    trimmed = existing_text.rstrip("\n")
    if not trimmed:
        return managed_block
    return f"{trimmed}\n\n{managed_block}"


def _build_bash_profile_block() -> str:
    lines = [
        SHELL_BASH_PROFILE_BLOCK_START,
        'if [ -f "$HOME/.bashrc" ]; then',
        '  . "$HOME/.bashrc"',
        "fi",
        SHELL_BASH_PROFILE_BLOCK_END,
        "",
    ]
    return "\n".join(lines)


def _strip_legacy_shell_banner_lines(existing_text: str) -> str:
    if not existing_text:
        return existing_text

    legacy_substrings = (
        "Codex Labs CLI initialized",
        "Codex Labs by Alshival.Ai",
        "[Connecting to Codex Labs shell...]",
        "[Codex Labs environment ready]",
        "printf '\\r\\n[Codex Labs environment ready]\\r\\n'",
    )
    filtered_lines: list[str] = []
    removed_any = False
    for line in existing_text.splitlines():
        if "████" in line or any(token in line for token in legacy_substrings):
            removed_any = True
            continue
        filtered_lines.append(line)

    if not removed_any:
        return existing_text

    cleaned = "\n".join(filtered_lines).rstrip("\n")
    if not cleaned:
        return ""
    return f"{cleaned}\n"


def _build_shell_banner_block() -> str:
    banner_lines = _build_codex_labs_banner_lines()
    lines = [
        SHELL_BANNER_BLOCK_START,
        'if [[ $- == *i* ]] && [[ -z "${CODEX_LABS_BANNER_SHOWN:-}" ]]; then',
        "  export CODEX_LABS_BANNER_SHOWN=1",
        "  cat <<'CODEX_LABS_BANNER'",
        *banner_lines,
        "CODEX_LABS_BANNER",
        "fi",
        SHELL_BANNER_BLOCK_END,
        "",
    ]
    return "\n".join(lines)


def _build_codex_labs_banner_lines() -> list[str]:
    return [
        "",
        "   ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗    ██╗      █████╗ ██████╗ ███████╗",
        "  ██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝    ██║     ██╔══██╗██╔══██╗██╔════╝",
        "  ██║     ██║   ██║██║  ██║█████╗   ╚███╔╝     ██║     ███████║██████╔╝███████╗",
        "  ██║     ██║   ██║██║  ██║██╔══╝   ██╔██╗     ██║     ██╔══██║██╔══██╗╚════██║",
        "  ╚██████╗╚██████╔╝██████╔╝███████╗██╔╝ ██╗    ███████╗██║  ██║██████╔╝███████║",
        "   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝    ╚══════╝╚═╝  ╚═╝╚════╝ ╚══════╝",
        "",
        ""
    ]


def _extract_azure_deployment_name_from_api_base(api_base: str) -> str | None:
    cleaned_api_base = api_base.strip()
    if not cleaned_api_base:
        return None

    parsed = urlsplit(cleaned_api_base)
    if not parsed.scheme or not parsed.netloc:
        return None

    path_parts = [part for part in parsed.path.split("/") if part]
    for i, part in enumerate(path_parts):
        if part.lower() == "deployments" and i + 1 < len(path_parts):
            deployment = unquote(path_parts[i + 1]).strip()
            return deployment or None

    return None


def _resolve_local_mcp_settings(db_session: Session) -> tuple[str | None, str | None]:
    mcp_server = db_session.scalar(
        select(MCPServer).where(MCPServer.name == LOCAL_MCP_SERVER_ACTION_NAME)
    )

    mcp_server_url = (
        mcp_server.server_url.strip()
        if mcp_server and mcp_server.server_url
        else LOCAL_MCP_SERVER_URL.strip()
    )
    if not mcp_server_url:
        mcp_server_url = None

    if LOCAL_MCP_STATIC_API_KEY:
        return mcp_server_url, LOCAL_MCP_STATIC_API_KEY

    if not mcp_server or mcp_server.admin_connection_config is None:
        return mcp_server_url, None

    connection_data = extract_connection_data(
        mcp_server.admin_connection_config, apply_mask=False
    )
    return mcp_server_url, _extract_bearer_token(connection_data.get("headers") or {})


def _extract_bearer_token(headers: dict[str, str]) -> str | None:
    authorization = headers.get("Authorization") or headers.get("authorization")
    if not authorization:
        return None

    prefix = "bearer "
    if authorization.lower().startswith(prefix):
        token = authorization[len(prefix) :].strip()
        return token or None

    return authorization.strip() or None


def _normalize_azure_base_url_for_codex(api_base: str) -> str | None:
    cleaned_api_base = api_base.strip()
    if not cleaned_api_base:
        return None

    parsed = urlsplit(cleaned_api_base)
    if not parsed.scheme or not parsed.netloc:
        return None

    base_path = parsed.path.rstrip("/")
    deployment_split = "/openai/deployments/"
    if deployment_split in base_path:
        base_path = base_path.split(deployment_split)[0]
    elif base_path.endswith("/openai/v1/responses"):
        base_path = base_path[: -len("/openai/v1/responses")]
    elif base_path.endswith("/openai/responses"):
        base_path = base_path[: -len("/openai/responses")]
    elif base_path.endswith("/openai/v1"):
        base_path = base_path[: -len("/openai/v1")]
    elif base_path.endswith("/openai"):
        base_path = base_path[: -len("/openai")]
    elif base_path.endswith("/v1"):
        base_path = base_path[: -len("/v1")]

    normalized_path = f"{base_path.rstrip('/')}/openai/v1"
    return urlunsplit((parsed.scheme, parsed.netloc, normalized_path, "", ""))


def _build_codex_config_toml(
    azure_model: str | None,
    azure_base_url: str | None,
    mcp_server_url: str | None,
    include_mcp_token_env: bool,
) -> str | None:
    lines: list[str] = [
        "# Managed by WardGPT Codex Labs. Manual edits may be overwritten.",
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        "",
    ]

    if azure_model and azure_base_url:
        lines.extend(
            [
                f"model = {_toml_quote(azure_model)}",
                'model_provider = "azure"',
                'model_reasoning_effort = "medium"',
                "",
                "[model_providers.azure]",
                'name = "Azure OpenAI"',
                f"base_url = {_toml_quote(azure_base_url)}",
                f"env_key = {_toml_quote(CODEX_AZURE_API_KEY_ENV_VAR)}",
                'wire_api = "responses"',
                "",
            ]
        )

    if mcp_server_url:
        lines.extend(
            [
                f"[mcp_servers.{CODEX_WARDGPT_MCP_SERVER_KEY}]",
                f"url = {_toml_quote(mcp_server_url)}",
            ]
        )
        if include_mcp_token_env:
            lines.append(
                "bearer_token_env_var = "
                f"{_toml_quote(CODEX_WARDGPT_MCP_BEARER_TOKEN_ENV_VAR)}"
            )
        lines.append("")

    if len(lines) <= 2:
        return None

    return "\n".join(lines).rstrip() + "\n"


def _toml_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
