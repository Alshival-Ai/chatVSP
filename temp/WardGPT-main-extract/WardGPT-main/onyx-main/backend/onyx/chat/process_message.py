"""
IMPORTANT: familiarize yourself with the design concepts prior to contributing to this file.
An overview can be found in the README.md file in this directory.
"""

import io
import re
import traceback
import zipfile
import xml.etree.ElementTree as ET
from collections.abc import Callable
from collections.abc import Sequence
from contextvars import Token
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy.orm import Session

from onyx.cache.factory import get_cache_backend
from onyx.cache.interface import CacheBackend
from onyx.chat.chat_processing_checker import set_processing_status
from onyx.chat.chat_state import ChatStateContainer
from onyx.chat.chat_state import run_chat_loop_with_state_containers
from onyx.chat.chat_utils import convert_chat_history
from onyx.chat.chat_utils import create_chat_history_chain
from onyx.chat.chat_utils import create_chat_session_from_request
from onyx.chat.chat_utils import get_custom_agent_prompt
from onyx.chat.chat_utils import is_last_assistant_message_clarification
from onyx.chat.chat_utils import load_all_chat_files
from onyx.chat.compression import calculate_total_history_tokens
from onyx.chat.compression import compress_chat_history
from onyx.chat.compression import find_summary_for_branch
from onyx.chat.compression import get_compression_params
from onyx.chat.emitter import get_default_emitter
from onyx.chat.kmz_agent_parity import build_effective_kmz_persona
from onyx.chat.kmz_agent_parity import is_kmz_agent_name
from onyx.chat.llm_loop import run_llm_loop
from onyx.chat.kmz_batching import run_kmz_batch_preprocessing
from onyx.chat.kmz_batching import should_batch_kmz_pdfs
from onyx.chat.kmz_batching import validate_kmz_pdf_count_or_raise
from onyx.chat.models import AnswerStream
from onyx.chat.models import ChatBasicResponse
from onyx.chat.models import ChatFullResponse
from onyx.chat.models import ChatLoadedFile
from onyx.chat.models import ChatMessageSimple
from onyx.chat.models import ContextFileMetadata
from onyx.chat.models import CreateChatSessionID
from onyx.chat.models import ExtractedContextFiles
from onyx.chat.models import FileToolMetadata
from onyx.chat.models import SearchParams
from onyx.chat.models import StreamingError
from onyx.chat.models import ToolCallResponse
from onyx.chat.prompt_utils import calculate_reserved_tokens
from onyx.chat.save_chat import save_chat_turn
from onyx.chat.stop_signal_checker import is_connected as check_stop_signal
from onyx.chat.stop_signal_checker import reset_cancel_status
from onyx.configs.app_configs import DISABLE_VECTOR_DB
from onyx.configs.app_configs import INTEGRATION_TESTS_MODE
from onyx.configs.app_configs import PDF_MAX_INLINE_PAGES
from onyx.configs.app_configs import PDF_MAX_INLINE_TEXT_CHUNKS
from onyx.configs.app_configs import PDF_MAX_TEXT_CHARS_PER_CHUNK
from onyx.configs.constants import DEFAULT_PERSONA_ID
from onyx.configs.constants import DocumentSource
from onyx.configs.constants import MessageType
from onyx.configs.constants import MilestoneRecordType
from onyx.context.search.models import BaseFilters
from onyx.context.search.models import SearchDoc
from onyx.db.chat import create_new_chat_message
from onyx.db.chat import get_chat_session_by_id
from onyx.db.chat import get_or_create_root_message
from onyx.db.chat import reserve_message_id
from onyx.db.memory import get_memories
from onyx.db.models import ChatMessage
from onyx.db.models import ChatSession
from onyx.db.models import Persona
from onyx.db.models import User
from onyx.db.models import UserFile
from onyx.db.persona import get_default_assistant
from onyx.db.projects import get_user_files_from_project
from onyx.db.tools import get_tools
from onyx.deep_research.dr_loop import run_deep_research_llm_loop
from onyx.file_processing.extract_file_text import extract_file_text
from onyx.file_store.models import ChatFileType
from onyx.file_store.models import FileDescriptor
from onyx.file_store.models import InMemoryChatFile
from onyx.file_store.utils import load_chat_files_by_ids
from onyx.file_store.utils import load_in_memory_chat_files
from onyx.file_store.utils import verify_user_files
from onyx.llm.factory import get_llm_for_persona
from onyx.llm.factory import get_llm_token_counter
from onyx.llm.interfaces import LLM
from onyx.llm.interfaces import LLMUserIdentity
from onyx.llm.request_context import reset_llm_mock_response
from onyx.llm.request_context import set_llm_mock_response
from onyx.llm.utils import litellm_exception_to_error_msg
from onyx.onyxbot.slack.models import SlackContext
from onyx.server.query_and_chat.models import AUTO_PLACE_AFTER_LATEST_MESSAGE
from onyx.server.query_and_chat.models import MessageResponseIDInfo
from onyx.server.query_and_chat.models import SendMessageRequest
from onyx.server.query_and_chat.streaming_models import AgentResponseDelta
from onyx.server.query_and_chat.streaming_models import AgentResponseStart
from onyx.server.query_and_chat.streaming_models import CitationInfo
from onyx.server.query_and_chat.streaming_models import Packet
from onyx.server.usage_limits import check_llm_cost_limit_for_provider
from onyx.tools.constants import KMZ_PROCESSING_TOOL_ID
from onyx.tools.constants import SEARCH_TOOL_ID
from onyx.tools.interface import Tool
from onyx.tools.models import ChatFile
from onyx.tools.models import SearchToolUsage
from onyx.tools.tool_constructor import construct_tools
from onyx.tools.tool_constructor import CustomToolConfig
from onyx.tools.tool_constructor import FileReaderToolConfig
from onyx.tools.tool_constructor import SearchToolConfig
from onyx.tools.tool_implementations.file_reader.file_reader_tool import (
    FileReaderTool,
)
from onyx.utils.logger import setup_logger
from onyx.utils.telemetry import mt_cloud_telemetry
from onyx.utils.timing import log_function_time
from shared_configs.contextvars import get_current_tenant_id

logger = setup_logger()
ERROR_TYPE_CANCELLED = "cancelled"
KMZ_REQUIRED_MCP_TOOL_NAMES = (
    "google_places_geocode_address",
    "google_places_search_text",
    "google_places_get_place_details",
)
KMZ_WORKBOOK_TEMPLATE_FILENAME = "P1_NWF_3.4.26_KMZ_Input_ALL_P1.xlsx"
KMZ_WORKBOOK_TEMPLATE_ASSETS_SUBDIR = Path("assets/kmz")
KMZ_WORKBOOK_TEMPLATE_RUNTIME_FILE_ID = "__kmz_workbook_template__"
KMZ_WORKBOOK_TEMPLATE_MAX_ROWS = 10


class _AvailableFiles(BaseModel):
    """Separated file IDs for the FileReaderTool so it knows which loader to use."""

    # IDs from the ``user_file`` table (project / persona-attached files).
    user_file_ids: list[UUID] = []
    # IDs from the ``file_record`` table (chat-attached files).
    chat_file_ids: list[str] = []


def _file_descriptor_has_filename(
    file_descriptors: Sequence[FileDescriptor],
    *,
    filename: str,
) -> bool:
    target = filename.strip().lower()
    return any((fd.get("name") or "").strip().lower() == target for fd in file_descriptors)


def _split_runtime_descriptor_ids(
    file_descriptors: Sequence[FileDescriptor],
) -> tuple[list[UUID], list[str]]:
    user_file_ids: list[UUID] = []
    chat_file_ids: list[str] = []

    for descriptor in file_descriptors:
        descriptor_id = descriptor.get("id")
        if descriptor.get("is_chat_file") and descriptor_id:
            # Synthetic KMZ template descriptors are provided directly from
            # in-memory bytes and are not persisted chat files in DB.
            if descriptor_id == KMZ_WORKBOOK_TEMPLATE_RUNTIME_FILE_ID:
                continue
            chat_file_ids.append(descriptor_id)
            continue

        user_file_id = descriptor.get("user_file_id")
        if not user_file_id:
            continue
        try:
            user_file_ids.append(UUID(user_file_id))
        except (TypeError, ValueError):
            continue

    return user_file_ids, chat_file_ids


def _resolve_kmz_template_path() -> Path | None:
    process_message_path = Path(__file__).resolve()
    candidate_roots = [Path.cwd()]

    # Support both the monorepo layout and backend-only runtime layouts.
    for parent_index in (3, 4):
        if len(process_message_path.parents) > parent_index:
            candidate_roots.append(process_message_path.parents[parent_index])

    seen_roots: set[str] = set()
    for root in candidate_roots:
        root_str = str(root)
        if root_str in seen_roots:
            continue
        seen_roots.add(root_str)
        for candidate in (
            root / KMZ_WORKBOOK_TEMPLATE_ASSETS_SUBDIR / KMZ_WORKBOOK_TEMPLATE_FILENAME,
            root / KMZ_WORKBOOK_TEMPLATE_FILENAME,
        ):
            if candidate.is_file():
                return candidate

    return None


def _load_kmz_template_runtime_file() -> ChatLoadedFile | None:
    template_path = _resolve_kmz_template_path()
    if template_path is None:
        return None

    try:
        content = template_path.read_bytes()
    except OSError:
        logger.exception(
            "Failed reading KMZ workbook template from path: %s",
            template_path,
        )
        return None

    truncated_content = _truncate_xlsx_content_to_row_limit(
        content=content,
        max_rows=KMZ_WORKBOOK_TEMPLATE_MAX_ROWS,
    )

    return ChatLoadedFile(
        file_id=KMZ_WORKBOOK_TEMPLATE_RUNTIME_FILE_ID,
        content=truncated_content,
        file_type=ChatFileType.DOC,
        filename=KMZ_WORKBOOK_TEMPLATE_FILENAME,
        is_chat_file=True,
        content_text=None,
        token_count=0,
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
            "KMZ workbook template is not parseable as XLSX; using unmodified content."
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

    out = io.BytesIO()
    with zipfile.ZipFile(out, mode="w", compression=zipfile.ZIP_DEFLATED) as target_zip:
        for path, payload in zip_entries.items():
            target_zip.writestr(path, payload)
    return out.getvalue()


_A1_REF_ROW_RE = re.compile(r"^([A-Za-z]+)(\d+)$")


def _truncate_sheet_dimension_ref(*, dimension_ref: str, max_rows: int) -> str:
    """Clamp sheet dimension refs such as A1:AZ56 to max_rows."""
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


def _append_runtime_file_if_missing(
    runtime_files: list[InMemoryChatFile],
    file: InMemoryChatFile | None,
) -> None:
    if file is None:
        return

    if any(str(existing.file_id) == str(file.file_id) for existing in runtime_files):
        return

    filename = (file.filename or "").strip().lower()
    if filename and any((existing.filename or "").strip().lower() == filename for existing in runtime_files):
        return

    runtime_files.append(file)


def _collect_available_file_ids(
    chat_history: list[ChatMessage],
    project_id: int | None,
    user_id: UUID | None,
    db_session: Session,
) -> _AvailableFiles:
    """Collect all file IDs the FileReaderTool should be allowed to access.

    Returns *separate* lists for chat-attached files (``file_record`` IDs) and
    project/user files (``user_file`` IDs) so the tool can pick the right
    loader without a try/except fallback."""
    chat_file_ids: set[str] = set()
    user_file_ids: set[UUID] = set()

    for msg in chat_history:
        if not msg.files:
            continue
        for fd in msg.files:
            file_id = fd.get("id")
            if file_id and fd.get("is_chat_file"):
                chat_file_ids.add(file_id)
                continue

            user_file_id = fd.get("user_file_id")
            if not user_file_id:
                continue
            try:
                user_file_ids.add(UUID(user_file_id))
            except (TypeError, ValueError):
                continue

    if project_id:
        user_files = get_user_files_from_project(
            project_id=project_id,
            user_id=user_id,
            db_session=db_session,
        )
        for uf in user_files:
            user_file_ids.add(uf.id)

    return _AvailableFiles(
        user_file_ids=list(user_file_ids),
        chat_file_ids=list(chat_file_ids),
    )


def _should_enable_slack_search(
    persona: Persona,
    filters: BaseFilters | None,
) -> bool:
    """Determine if Slack search should be enabled.

    Returns True if:
    - Source type filter exists and includes Slack, OR
    - Default persona with no source type filter
    """
    source_types = filters.source_type if filters else None
    return (source_types is not None and DocumentSource.SLACK in source_types) or (
        persona.id == DEFAULT_PERSONA_ID and source_types is None
    )


def _convert_loaded_files_to_chat_files(
    loaded_files: list[ChatLoadedFile],
) -> list[ChatFile]:
    """Convert ChatLoadedFile objects to ChatFile for tool usage (e.g., PythonTool).

    Args:
        loaded_files: List of ChatLoadedFile objects from the chat history

    Returns:
        List of ChatFile objects that can be passed to tools
    """
    chat_files = []
    for loaded_file in loaded_files:
        if len(loaded_file.content) > 0:
            chat_files.append(
                ChatFile(
                    filename=loaded_file.filename or f"file_{loaded_file.file_id}",
                    content=loaded_file.content,
                )
            )
    return chat_files


def resolve_context_user_files(
    persona: Persona,
    project_id: int | None,
    user_id: UUID | None,
    db_session: Session,
) -> list[UserFile]:
    """Apply the precedence rule to decide which user files to load.

    A custom persona fully supersedes the project.  When a chat uses a
    custom persona, the project is purely organisational — its files are
    never loaded and never made searchable.

    Custom persona with document sets → do not inline persona user_files.
    Custom persona without document sets → persona's own user_files (may be empty).
    Default persona inside a project → project files.
    Otherwise → empty list.
    """
    if persona.id != DEFAULT_PERSONA_ID:
        if persona.document_sets:
            # For document-set assistants, avoid inlining persona files so the
            # model uses internal_search over the connected corpus.
            return []
        return list(persona.user_files) if persona.user_files else []
    if project_id:
        return get_user_files_from_project(
            project_id=project_id,
            user_id=user_id,
            db_session=db_session,
        )
    return []


def _empty_extracted_context_files() -> ExtractedContextFiles:
    return ExtractedContextFiles(
        file_texts=[],
        image_files=[],
        use_as_search_filter=False,
        total_token_count=0,
        file_metadata=[],
        uncapped_token_count=None,
    )


def _extract_text_from_in_memory_file(f: InMemoryChatFile) -> str | None:
    """Extract text content from an InMemoryChatFile.

    PLAIN_TEXT: the content is pre-extracted UTF-8 plaintext stored during
    ingestion — decode directly.
    DOC / CSV / other text types: the content is the original file bytes —
    use extract_file_text which handles encoding detection and format parsing.
    """
    try:
        if f.file_type == ChatFileType.PLAIN_TEXT:
            return f.content.decode("utf-8", errors="ignore").replace("\x00", "")
        return extract_file_text(
            file=io.BytesIO(f.content),
            file_name=f.filename or "",
            break_on_unprocessable=False,
        )
    except Exception:
        logger.warning(f"Failed to extract text from file {f.file_id}", exc_info=True)
        return None


def _is_pdf_user_file(
    in_memory_file: InMemoryChatFile,
    user_file: UserFile | None,
) -> bool:
    if in_memory_file.filename and in_memory_file.filename.lower().endswith(".pdf"):
        return True

    if user_file and user_file.content_type:
        return user_file.content_type.lower() == "application/pdf"

    return False

_COMMON_QUERY_STOPWORDS = {
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "from",
    "at",
    "by",
    "is",
    "are",
    "be",
    "as",
    "that",
    "this",
    "it",
    "we",
    "you",
    "i",
}


def _extract_query_terms(user_query: str | None) -> list[str]:
    if not user_query:
        return []
    terms = [
        t
        for t in re.findall(r"[a-z0-9]{3,}", user_query.lower())
        if t not in _COMMON_QUERY_STOPWORDS
    ]
    # Keep deterministic ordering while dropping duplicates.
    seen: set[str] = set()
    deduped: list[str] = []
    for term in terms:
        if term in seen:
            continue
        seen.add(term)
        deduped.append(term)
    return deduped


def _score_page_text(page_text: str, query_terms: Sequence[str]) -> int:
    if not page_text:
        return 0
    text = page_text.lower()
    if not query_terms:
        return 1 if text.strip() else 0
    return sum(text.count(term) for term in query_terms)


def _estimate_text_tokens_for_context(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // APPROX_CHARS_PER_TOKEN)


def _select_relevant_pages_with_neighbors(
    page_scores: list[int],
    max_pages: int,
) -> list[int]:
    if not page_scores or max_pages <= 0:
        return []

    ranked_pages = sorted(
        range(1, len(page_scores) + 1),
        key=lambda page_num: (page_scores[page_num - 1], -page_num),
        reverse=True,
    )

    selected: list[int] = []
    for seed_page in ranked_pages:
        for page in (seed_page - 1, seed_page, seed_page + 1):
            if page < 1 or page > len(page_scores):
                continue
            if page in selected:
                continue
            selected.append(page)
            if len(selected) >= max_pages:
                return sorted(selected)
    return sorted(selected[:max_pages])


def _build_targeted_pdf_context_for_file(
    in_memory_file: InMemoryChatFile,
    user_file: UserFile | None,
    query_terms: Sequence[str],
    remaining_text_budget_tokens: int,
    remaining_text_chunks: int,
) -> tuple[list[ContextFileMetadata], list[str], int]:
    """Build a capped page-aware text context slice for one PDF."""
    if remaining_text_chunks <= 0:
        return [], [], 0

    try:
        from pypdf import PdfReader
    except Exception:
        logger.warning("pypdf unavailable; skipping targeted PDF multimodal selection")
        return [], [], 0

    try:
        pdf_reader = PdfReader(io.BytesIO(in_memory_file.content))
    except Exception:
        logger.warning(
            f"Failed to open PDF for targeted selection: {in_memory_file.file_id}",
            exc_info=True,
        )
        return [], [], 0

    page_texts: list[str] = []
    for page in pdf_reader.pages:
        try:
            page_texts.append((page.extract_text() or "").replace("\x00", ""))
        except Exception:
            page_texts.append("")

    if not page_texts:
        return [], [], 0

    page_scores = [_score_page_text(text, query_terms) for text in page_texts]
    selected_pages = _select_relevant_pages_with_neighbors(
        page_scores=page_scores,
        max_pages=PDF_MAX_INLINE_PAGES,
    )

    if not selected_pages:
        selected_pages = list(range(1, min(len(page_texts), PDF_MAX_INLINE_PAGES) + 1))

    text_meta: list[ContextFileMetadata] = []
    text_snippets: list[str] = []
    consumed_text_tokens = 0
    for page_num in sorted(selected_pages, key=lambda n: page_scores[n - 1], reverse=True):
        if remaining_text_chunks <= 0:
            break
        raw = page_texts[page_num - 1].strip()
        if not raw:
            continue
        snippet = raw[:PDF_MAX_TEXT_CHARS_PER_CHUNK]
        est_tokens = _estimate_text_tokens_for_context(snippet)
        if est_tokens > remaining_text_budget_tokens:
            continue

        remaining_text_budget_tokens -= est_tokens
        remaining_text_chunks -= 1
        consumed_text_tokens += est_tokens

        file_name = user_file.name if user_file and user_file.name else (in_memory_file.filename or f"file_{in_memory_file.file_id}")
        labeled = f"[{file_name} page {page_num}]\n{snippet}"
        text_snippets.append(labeled)
        text_meta.append(
            ContextFileMetadata(
                file_id=str(in_memory_file.file_id),
                filename=f"{file_name} (page {page_num})",
                file_content=snippet,
            )
        )

    return text_meta, text_snippets, consumed_text_tokens


def _build_targeted_overflow_context(
    in_memory_files: list[InMemoryChatFile],
    user_file_map_by_id: dict[str, UserFile],
    user_file_map_by_file_id: dict[str, UserFile],
    user_query: str | None,
    llm_max_context_window: int,
    reserved_token_count: int,
) -> tuple[list[str], list[ChatLoadedFile], list[ContextFileMetadata], int]:
    query_terms = _extract_query_terms(user_query)
    available = max(0, llm_max_context_window - reserved_token_count)
    text_budget = max(0, int(available * 0.2))

    remaining_text_chunks = PDF_MAX_INLINE_TEXT_CHUNKS
    all_texts: list[str] = []
    all_meta: list[ContextFileMetadata] = []
    total_tokens = 0

    for f in in_memory_files:
        if remaining_text_chunks <= 0:
            break
        uf = user_file_map_by_id.get(str(f.file_id)) or user_file_map_by_file_id.get(
            str(f.file_id)
        )
        if not _is_pdf_user_file(f, uf):
            continue

        meta, texts, text_tokens = _build_targeted_pdf_context_for_file(
            in_memory_file=f,
            user_file=uf,
            query_terms=query_terms,
            remaining_text_budget_tokens=text_budget,
            remaining_text_chunks=remaining_text_chunks,
        )
        if texts:
            all_meta.extend(meta)
            all_texts.extend(texts)
            total_tokens += text_tokens
            text_budget = max(0, text_budget - text_tokens)
            remaining_text_chunks = max(0, remaining_text_chunks - len(texts))

    return all_texts, [], all_meta, total_tokens


def extract_context_files(
    user_files: list[UserFile],
    llm_max_context_window: int,
    reserved_token_count: int,
    db_session: Session,
    user_query: str | None = None,
    # Because the tokenizer is a generic tokenizer, the token count may be incorrect.
    # to account for this, the maximum context that is allowed for this function is
    # 60% of the LLM's max context window. The other benefit is that for projects with
    # more files, this makes it so that we don't throw away the history too quickly every time.
    max_llm_context_percentage: float = 0.6,
) -> ExtractedContextFiles:
    """Load user files into context if they fit; otherwise flag for search.

    The caller is responsible for deciding *which* user files to pass in
    (project files, persona files, etc.).  This function only cares about
    the all-or-nothing fit check and the actual content loading.

    Args:
        project_id: The project ID to load files from
        user_id: The user ID for authorization
        llm_max_context_window: Maximum tokens allowed in the LLM context window
        reserved_token_count: Number of tokens to reserve for other content
        db_session: Database session
        max_llm_context_percentage: Maximum percentage of the LLM context window to use.
    Returns:
        ExtractedContextFiles containing:
        - List of text content strings from context files (text files only)
        - List of image files from context (ChatLoadedFile objects)
        - Total token count of all extracted files
        - File metadata for context files
        - Uncapped token count of all extracted files
        - File metadata for files that don't fit in context and vector DB is disabled
    """
    # TODO(yuhong): I believe this is not handling all file types correctly.

    if not user_files:
        return _empty_extracted_context_files()

    aggregate_tokens = sum(uf.token_count or 0 for uf in user_files)
    max_actual_tokens = (
        llm_max_context_window - reserved_token_count
    ) * max_llm_context_percentage

    if aggregate_tokens >= max_actual_tokens:
        # Files exceed full-inline budget. Build a small, query-relevant
        # multimodal slice for PDFs while still enabling search fallback.
        user_file_map_by_id = {str(uf.id): uf for uf in user_files}
        user_file_map_by_file_id = {str(uf.file_id): uf for uf in user_files}
        in_memory_files = load_in_memory_chat_files(
            user_file_ids=[uf.id for uf in user_files],
            db_session=db_session,
        )
        (
            targeted_texts,
            targeted_images,
            targeted_meta,
            targeted_tokens,
        ) = _build_targeted_overflow_context(
            in_memory_files=in_memory_files,
            user_file_map_by_id=user_file_map_by_id,
            user_file_map_by_file_id=user_file_map_by_file_id,
            user_query=user_query,
            llm_max_context_window=llm_max_context_window,
            reserved_token_count=reserved_token_count,
        )
        tool_metadata = []
        use_as_search_filter = not DISABLE_VECTOR_DB
        if DISABLE_VECTOR_DB:
            tool_metadata = _build_file_tool_metadata_for_user_files(user_files)
        return ExtractedContextFiles(
            file_texts=targeted_texts,
            image_files=targeted_images,
            use_as_search_filter=use_as_search_filter,
            total_token_count=targeted_tokens,
            file_metadata=targeted_meta,
            uncapped_token_count=aggregate_tokens,
            file_metadata_for_tool=tool_metadata,
        )

    # Files fit — load them into context
    user_file_map_by_id = {str(uf.id): uf for uf in user_files}
    user_file_map_by_file_id = {str(uf.file_id): uf for uf in user_files}
    in_memory_files = load_in_memory_chat_files(
        user_file_ids=[uf.id for uf in user_files],
        db_session=db_session,
    )

    file_texts: list[str] = []
    image_files: list[ChatLoadedFile] = []
    file_metadata: list[ContextFileMetadata] = []
    total_token_count = 0

    for f in in_memory_files:
        uf = user_file_map_by_id.get(str(f.file_id)) or user_file_map_by_file_id.get(
            str(f.file_id)
        )
        if f.file_type.is_text_file():
            text_content = _extract_text_from_in_memory_file(f)
            if not text_content:
                continue
            file_texts.append(text_content)
            file_metadata.append(
                ContextFileMetadata(
                    file_id=str(f.file_id),
                    filename=f.filename or f"file_{f.file_id}",
                    file_content=text_content,
                )
            )
            if uf and uf.token_count:
                total_token_count += uf.token_count
        elif f.file_type == ChatFileType.IMAGE:
            token_count = uf.token_count if uf and uf.token_count else 0
            total_token_count += token_count
            image_files.append(
                ChatLoadedFile(
                    file_id=f.file_id,
                    content=f.content,
                    file_type=f.file_type,
                    filename=f.filename,
                    content_text=None,
                    token_count=token_count,
                )
            )

    return ExtractedContextFiles(
        file_texts=file_texts,
        image_files=image_files,
        use_as_search_filter=False,
        total_token_count=total_token_count,
        file_metadata=file_metadata,
        uncapped_token_count=aggregate_tokens,
    )


APPROX_CHARS_PER_TOKEN = 4


def _build_file_tool_metadata_for_user_files(
    user_files: list[UserFile],
) -> list[FileToolMetadata]:
    """Build lightweight FileToolMetadata from a list of UserFile records."""
    return [
        FileToolMetadata(
            file_id=str(uf.id),
            filename=uf.name,
            approx_char_count=(uf.token_count or 0) * APPROX_CHARS_PER_TOKEN,
        )
        for uf in user_files
    ]


def determine_search_params(
    persona_id: int,
    project_id: int | None,
    extracted_context_files: ExtractedContextFiles,
    persona_has_document_sets: bool = False,
) -> SearchParams:
    """Decide which search filter IDs and search-tool usage apply for a chat turn.

    A custom persona fully supersedes the project — project files are never
    searchable and the search tool config is entirely controlled by the
    persona.  The project_id filter is only set for the default persona.

    For the default persona inside a project:
      - Files overflow  → ENABLED  (vector DB scopes to these files)
      - Files fit       → DISABLED (content already in prompt)
      - No files at all → DISABLED (nothing to search)
    """
    is_custom_persona = persona_id != DEFAULT_PERSONA_ID

    search_project_id: int | None = None
    search_persona_id: int | None = None
    if extracted_context_files.use_as_search_filter:
        if is_custom_persona:
            search_persona_id = persona_id
        else:
            search_project_id = project_id

    search_usage = SearchToolUsage.AUTO
    if is_custom_persona and persona_has_document_sets:
        # Ensure internal search is available for document-set assistants even
        # when no overflow-based search filter is being applied.
        search_usage = SearchToolUsage.ENABLED
    if not is_custom_persona and project_id:
        has_context_files = bool(extracted_context_files.uncapped_token_count)
        files_loaded_in_context = bool(extracted_context_files.file_texts)

        if extracted_context_files.use_as_search_filter:
            search_usage = SearchToolUsage.ENABLED
        elif files_loaded_in_context or not has_context_files:
            search_usage = SearchToolUsage.DISABLED

    return SearchParams(
        search_project_id=search_project_id,
        search_persona_id=search_persona_id,
        search_usage=search_usage,
    )


def handle_stream_message_objects(
    new_msg_req: SendMessageRequest,
    user: User,
    db_session: Session,
    # if specified, uses the last user message and does not create a new user message based
    # on the `new_msg_req.message`. Currently, requires a state where the last message is a
    litellm_additional_headers: dict[str, str] | None = None,
    custom_tool_additional_headers: dict[str, str] | None = None,
    mcp_headers: dict[str, str] | None = None,
    bypass_acl: bool = False,
    # Additional context that should be included in the chat history, for example:
    # Slack threads where the conversation cannot be represented by a chain of User/Assistant
    # messages. Both of the below are used for Slack
    # NOTE: is not stored in the database, only passed in to the LLM as context
    additional_context: str | None = None,
    # Slack context for federated Slack search
    slack_context: SlackContext | None = None,
    # Optional external state container for non-streaming access to accumulated state
    external_state_container: ChatStateContainer | None = None,
) -> AnswerStream:
    tenant_id = get_current_tenant_id()
    mock_response_token: Token[str | None] | None = None

    llm: LLM | None = None
    chat_session: ChatSession | None = None
    cache: CacheBackend | None = None

    user_id = user.id
    if user.is_anonymous:
        llm_user_identifier = "anonymous_user"
    else:
        llm_user_identifier = user.email or str(user_id)

    if new_msg_req.mock_llm_response is not None and not INTEGRATION_TESTS_MODE:
        raise ValueError(
            "mock_llm_response can only be used when INTEGRATION_TESTS_MODE=true"
        )

    try:
        if not new_msg_req.chat_session_id:
            if not new_msg_req.chat_session_info:
                raise RuntimeError(
                    "Must specify a chat session id or chat session info"
                )
            chat_session = create_chat_session_from_request(
                chat_session_request=new_msg_req.chat_session_info,
                user_id=user_id,
                db_session=db_session,
            )
            yield CreateChatSessionID(chat_session_id=chat_session.id)
        else:
            chat_session = get_chat_session_by_id(
                chat_session_id=new_msg_req.chat_session_id,
                user_id=user_id,
                db_session=db_session,
            )

        persona = chat_session.persona

        message_text = new_msg_req.message
        user_identity = LLMUserIdentity(
            user_id=llm_user_identifier, session_id=str(chat_session.id)
        )

        # Milestone tracking, most devs using the API don't need to understand this
        mt_cloud_telemetry(
            tenant_id=tenant_id,
            distinct_id=user.email if not user.is_anonymous else tenant_id,
            event=MilestoneRecordType.MULTIPLE_ASSISTANTS,
        )

        mt_cloud_telemetry(
            tenant_id=tenant_id,
            distinct_id=user.email if not user.is_anonymous else tenant_id,
            event=MilestoneRecordType.USER_MESSAGE_SENT,
            properties={
                "origin": new_msg_req.origin.value,
                "has_files": len(new_msg_req.file_descriptors) > 0,
                "has_project": chat_session.project_id is not None,
                "has_persona": persona is not None and persona.id != DEFAULT_PERSONA_ID,
                "deep_research": new_msg_req.deep_research,
            },
        )

        llm = get_llm_for_persona(
            persona=persona,
            user=user,
            llm_override=new_msg_req.llm_override or chat_session.llm_override,
            additional_headers=litellm_additional_headers,
        )
        token_counter = get_llm_token_counter(llm)

        # Check LLM cost limits before using the LLM (only for Onyx-managed keys)

        check_llm_cost_limit_for_provider(
            db_session=db_session,
            tenant_id=tenant_id,
            llm_provider_api_key=llm.config.api_key,
        )

        # Verify that the user specified files actually belong to the user
        verify_user_files(
            user_files=new_msg_req.file_descriptors,
            user_id=user_id,
            db_session=db_session,
            project_id=chat_session.project_id,
        )

        # re-create linear history of messages
        chat_history = create_chat_history_chain(
            chat_session_id=chat_session.id, db_session=db_session
        )

        # Determine the parent message based on the request:
        # - -1: auto-place after latest message in chain
        # - None: regeneration from root (first message)
        # - positive int: place after that specific parent message
        root_message = get_or_create_root_message(
            chat_session_id=chat_session.id, db_session=db_session
        )

        if new_msg_req.parent_message_id == AUTO_PLACE_AFTER_LATEST_MESSAGE:
            # Auto-place after the latest message in the chain
            parent_message = chat_history[-1] if chat_history else root_message
        elif (
            new_msg_req.parent_message_id is None
            or new_msg_req.parent_message_id == root_message.id
        ):
            # None = regeneration from root
            parent_message = root_message
            # Truncate history since we're starting from root
            chat_history = []
        else:
            # Specific parent message ID provided, find parent in chat_history
            parent_message = None
            for i in range(len(chat_history) - 1, -1, -1):
                if chat_history[i].id == new_msg_req.parent_message_id:
                    parent_message = chat_history[i]
                    # Truncate history to only include messages up to and including parent
                    chat_history = chat_history[: i + 1]
                    break

        if parent_message is None:
            raise ValueError(
                "The new message sent is not on the latest mainline of messages"
            )

        # If the parent message is a user message, it's a regeneration and we use the existing user message.
        if parent_message.message_type == MessageType.USER:
            user_message = parent_message
        else:
            user_message = create_new_chat_message(
                chat_session_id=chat_session.id,
                parent_message=parent_message,
                message=message_text,
                token_count=token_counter(message_text),
                message_type=MessageType.USER,
                files=new_msg_req.file_descriptors,
                db_session=db_session,
                commit=True,
            )

            chat_history.append(user_message)

        # Reserve a message id for the assistant response and emit it early so
        # the HTTP stream is not idle during heavy pre-answer preprocessing
        # such as KMZ batch extraction.
        assistant_response = reserve_message_id(
            db_session=db_session,
            chat_session_id=chat_session.id,
            parent_message=user_message.id,
            message_type=MessageType.ASSISTANT,
        )

        yield MessageResponseIDInfo(
            user_message_id=user_message.id,
            reserved_assistant_message_id=assistant_response.id,
        )

        # Collect file IDs for the file reader tool *before* summary
        # truncation so that files attached to older (summarized-away)
        # messages are still accessible via the FileReaderTool.
        available_files = _collect_available_file_ids(
            chat_history=chat_history,
            project_id=chat_session.project_id,
            user_id=user_id,
            db_session=db_session,
        )

        # Find applicable summary for the current branch
        # Summary applies if its parent_message_id is in current chat_history
        summary_message = find_summary_for_branch(db_session, chat_history)
        # Collect file metadata from messages that will be dropped by
        # summary truncation.  These become "pre-summarized" file metadata
        # so the forgotten-file mechanism can still tell the LLM about them.
        summarized_file_metadata: dict[str, FileToolMetadata] = {}
        if summary_message and summary_message.last_summarized_message_id:
            cutoff_id = summary_message.last_summarized_message_id
            for msg in chat_history:
                if msg.id > cutoff_id or not msg.files:
                    continue
                for fd in msg.files:
                    file_id = fd.get("id")
                    if not file_id:
                        continue
                    summarized_file_metadata[file_id] = FileToolMetadata(
                        file_id=file_id,
                        filename=fd.get("name") or "unknown",
                        # We don't know the exact size without loading the
                        # file, but 0 signals "unknown" to the LLM.
                        approx_char_count=0,
                    )
            # Filter chat_history to only messages after the cutoff
            chat_history = [m for m in chat_history if m.id > cutoff_id]

        user_memory_context = get_memories(user, db_session)

        # This is the custom prompt which may come from the Agent or Project. We fetch it earlier because the inner loop
        # (run_llm_loop and run_deep_research_llm_loop) should not need to be aware of the Chat History in the DB form processed
        # here, however we need this early for token reservation.
        custom_agent_prompt = get_custom_agent_prompt(persona, chat_session)
        all_tools = get_tools(db_session)
        default_assistant = get_default_assistant(db_session)
        kmz_required_tools = (
            [
                tool
                for tool in all_tools
                if (
                    tool.in_code_tool_id == KMZ_PROCESSING_TOOL_ID
                    or (
                        tool.name in KMZ_REQUIRED_MCP_TOOL_NAMES
                        and tool.enabled
                        and tool.mcp_server_id is not None
                    )
                )
            ]
            if is_kmz_agent_name(persona.name)
            else None
        )
        effective_persona = build_effective_kmz_persona(
            persona=persona,
            default_persona=default_assistant,
            required_tools=kmz_required_tools,
        )

        runtime_file_descriptors = list(new_msg_req.file_descriptors)
        runtime_additional_context = additional_context
        kmz_template_runtime_file: ChatLoadedFile | None = None

        if is_kmz_agent_name(getattr(persona, "name", None)):
            kmz_template_runtime_file = _load_kmz_template_runtime_file()
            if kmz_template_runtime_file is not None and not _file_descriptor_has_filename(
                runtime_file_descriptors,
                filename=KMZ_WORKBOOK_TEMPLATE_FILENAME,
            ):
                runtime_file_descriptors.append(
                    kmz_template_runtime_file.to_file_descriptor()
                )

        if runtime_file_descriptors:
            runtime_user_file_ids, runtime_chat_file_ids = _split_runtime_descriptor_ids(
                runtime_file_descriptors
            )

            runtime_files: list[InMemoryChatFile] = []
            if runtime_user_file_ids:
                runtime_files.extend(
                    load_in_memory_chat_files(
                        user_file_ids=runtime_user_file_ids,
                        db_session=db_session,
                    )
                )
            if runtime_chat_file_ids:
                runtime_files.extend(load_chat_files_by_ids(runtime_chat_file_ids))

            _append_runtime_file_if_missing(runtime_files, kmz_template_runtime_file)

            if runtime_files:
                validate_kmz_pdf_count_or_raise(
                    message=message_text,
                    files=runtime_files,
                )
                if should_batch_kmz_pdfs(
                    message=message_text,
                    llm_provider=llm.config.model_provider,
                    files=runtime_files,
                ):
                    batching_outcome = run_kmz_batch_preprocessing(
                        llm=llm,
                        token_counter=token_counter,
                        user_message=message_text,
                        runtime_files=runtime_files,
                        user_identity=user_identity,
                    )
                    runtime_file_descriptors = batching_outcome.runtime_file_descriptors
                    if batching_outcome.additional_context_appendix:
                        runtime_additional_context = (
                            additional_context
                            + "\n\n"
                            + batching_outcome.additional_context_appendix
                            if additional_context
                            else batching_outcome.additional_context_appendix
                        )

        # When use_memories is disabled, strip memories from the prompt context
        # but keep user info/preferences. The full context is still passed
        # to the LLM loop for memory tool persistence.
        prompt_memory_context = (
            user_memory_context
            if user.use_memories
            else user_memory_context.without_memories()
        )

        max_reserved_system_prompt_tokens_str = (
            effective_persona.system_prompt or ""
        ) + (
            custom_agent_prompt or ""
        )

        reserved_token_count = calculate_reserved_tokens(
            db_session=db_session,
            persona_system_prompt=max_reserved_system_prompt_tokens_str,
            token_counter=token_counter,
            files=runtime_file_descriptors,
            user_memory_context=prompt_memory_context,
        )
        if runtime_additional_context:
            reserved_token_count += token_counter(runtime_additional_context)

        # Determine which user files to use.  A custom persona fully
        # supersedes the project — project files are never loaded or
        # searchable when a custom persona is in play.  Only the default
        # persona inside a project uses the project's files.
        context_user_files = resolve_context_user_files(
            persona=persona,
            project_id=chat_session.project_id,
            user_id=user_id,
            db_session=db_session,
        )

        extracted_context_files = extract_context_files(
            user_files=context_user_files,
            llm_max_context_window=llm.config.max_input_tokens,
            reserved_token_count=reserved_token_count,
            db_session=db_session,
            user_query=new_msg_req.message,
        )

        search_params = determine_search_params(
            persona_id=persona.id,
            project_id=chat_session.project_id,
            extracted_context_files=extracted_context_files,
            persona_has_document_sets=bool(persona.document_sets),
        )

        # Also grant access to persona-attached user files for FileReaderTool
        if persona.user_files:
            existing = set(available_files.user_file_ids)
            for uf in persona.user_files:
                if uf.id not in existing:
                    available_files.user_file_ids.append(uf.id)

        tool_id_to_name_map = {tool.id: tool.name for tool in all_tools}

        search_tool_id = next(
            (tool.id for tool in all_tools if tool.in_code_tool_id == SEARCH_TOOL_ID),
            None,
        )

        forced_tool_id = new_msg_req.forced_tool_id
        if (
            persona.id != DEFAULT_PERSONA_ID
            and persona.document_sets
            and forced_tool_id is None
            and search_tool_id is not None
        ):
            # For document-set assistants, require an initial retrieval pass
            # before free-form answering so connector knowledge is always consulted.
            forced_tool_id = search_tool_id
        if (
            search_params.search_usage == SearchToolUsage.DISABLED
            and forced_tool_id is not None
            and search_tool_id is not None
            and forced_tool_id == search_tool_id
        ):
            forced_tool_id = None

        emitter = get_default_emitter()

        # Construct tools based on the persona configurations
        tool_dict = construct_tools(
            persona=effective_persona,
            db_session=db_session,
            emitter=emitter,
            user=user,
            llm=llm,
            search_tool_config=SearchToolConfig(
                user_selected_filters=new_msg_req.internal_search_filters,
                project_id=search_params.search_project_id,
                persona_id=search_params.search_persona_id,
                bypass_acl=bypass_acl,
                slack_context=slack_context,
                enable_slack_search=_should_enable_slack_search(
                    persona, new_msg_req.internal_search_filters
                ),
            ),
            custom_tool_config=CustomToolConfig(
                chat_session_id=chat_session.id,
                message_id=user_message.id if user_message else None,
                additional_headers=custom_tool_additional_headers,
                mcp_headers=mcp_headers,
            ),
            file_reader_tool_config=FileReaderToolConfig(
                user_file_ids=available_files.user_file_ids,
                chat_file_ids=available_files.chat_file_ids,
            ),
            allowed_tool_ids=new_msg_req.allowed_tool_ids,
            search_usage_forcing_setting=search_params.search_usage,
        )
        tools: list[Tool] = []
        for tool_list in tool_dict.values():
            tools.extend(tool_list)

        if forced_tool_id and forced_tool_id not in [tool.id for tool in tools]:
            raise ValueError(f"Forced tool {forced_tool_id} not found in tools")

        # TODO Once summarization is done, we don't need to load all the files from the beginning anymore.
        # load all files needed for this chat chain in memory
        files = load_all_chat_files(chat_history, db_session)
        _append_runtime_file_if_missing(files, kmz_template_runtime_file)

        # Convert loaded files to ChatFile format for tools like PythonTool
        chat_files_for_tools = _convert_loaded_files_to_chat_files(files)

        # TODO Need to think of some way to support selected docs from the sidebar

        # Check whether the FileReaderTool is among the constructed tools.
        has_file_reader_tool = any(isinstance(t, FileReaderTool) for t in tools)

        # Convert the chat history into a simple format that is free of any DB objects
        # and is easy to parse for the agent loop
        runtime_chat_history: list[ChatMessage | SimpleNamespace] = []
        for msg in chat_history:
            msg_files = msg.files
            if msg.id == user_message.id and msg.message_type == MessageType.USER:
                msg_files = runtime_file_descriptors
            runtime_chat_history.append(
                SimpleNamespace(
                    message_type=msg.message_type,
                    files=msg_files,
                    message=msg.message,
                    token_count=msg.token_count,
                    tool_calls=msg.tool_calls,
                )
            )

        chat_history_result = convert_chat_history(
            chat_history=runtime_chat_history,
            files=files,
            context_image_files=extracted_context_files.image_files,
            additional_context=runtime_additional_context,
            token_counter=token_counter,
            tool_id_to_name_map=tool_id_to_name_map,
            llm_model_provider=llm.config.model_provider,
            disable_openai_input_file_parts=is_kmz_agent_name(
                getattr(persona, "name", None)
            ),
        )
        simple_chat_history = chat_history_result.simple_messages

        # Metadata for every text file injected into the history.  After
        # context-window truncation drops older messages, the LLM loop
        # compares surviving file_id tags against this map to discover
        # "forgotten" files and provide their metadata to FileReaderTool.
        all_injected_file_metadata: dict[str, FileToolMetadata] = (
            chat_history_result.all_injected_file_metadata
            if has_file_reader_tool
            else {}
        )

        # Merge in file metadata from messages dropped by summary
        # truncation.  These files are no longer in simple_chat_history
        # so they would otherwise be invisible to the forgotten-file
        # mechanism.  They will always appear as "forgotten" since no
        # surviving message carries their file_id tag.
        if summarized_file_metadata:
            for fid, meta in summarized_file_metadata.items():
                all_injected_file_metadata.setdefault(fid, meta)

        if all_injected_file_metadata:
            logger.debug(
                "FileReader: file metadata for LLM: "
                f"{[(fid, m.filename) for fid, m in all_injected_file_metadata.items()]}"
            )

        # Prepend summary message if compression exists
        if summary_message is not None:
            summary_simple = ChatMessageSimple(
                message=summary_message.message,
                token_count=summary_message.token_count,
                message_type=MessageType.ASSISTANT,
            )
            simple_chat_history.insert(0, summary_simple)

        cache = get_cache_backend()

        reset_cancel_status(
            chat_session.id,
            cache,
        )

        def check_is_connected() -> bool:
            return check_stop_signal(chat_session.id, cache)

        set_processing_status(
            chat_session_id=chat_session.id,
            cache=cache,
            value=True,
        )

        # Use external state container if provided, otherwise create internal one
        # External container allows non-streaming callers to access accumulated state
        state_container = external_state_container or ChatStateContainer()

        def llm_loop_completion_callback(
            state_container: ChatStateContainer,
        ) -> None:
            llm_loop_completion_handle(
                state_container=state_container,
                is_connected=check_is_connected,
                db_session=db_session,
                assistant_message=assistant_response,
                llm=llm,
                reserved_tokens=reserved_token_count,
            )

        # Release any read transaction before entering the long-running LLM stream.
        # Without this, the request-scoped session can keep a connection checked out
        # for the full stream duration.
        db_session.commit()

        # The stream generator can resume on a different worker thread after early yields.
        # Set this right before launching the LLM loop so run_in_background copies the right context.
        if new_msg_req.mock_llm_response is not None:
            mock_response_token = set_llm_mock_response(new_msg_req.mock_llm_response)

        # Run the LLM loop with explicit wrapper for stop signal handling
        # The wrapper runs run_llm_loop in a background thread and polls every 300ms
        # for stop signals. run_llm_loop itself doesn't know about stopping.
        # Note: DB session is not thread safe but nothing else uses it and the
        # reference is passed directly so it's ok.
        if new_msg_req.deep_research:
            if chat_session.project_id:
                raise RuntimeError("Deep research is not supported for projects")

            # Skip clarification if the last assistant message was a clarification
            # (user has already responded to a clarification question)
            skip_clarification = is_last_assistant_message_clarification(chat_history)

            # NOTE: we _could_ pass in a zero argument function since emitter and state_container
            # are just passed in immediately anyways, but the abstraction is cleaner this way.
            yield from run_chat_loop_with_state_containers(
                lambda emitter, state_container: run_deep_research_llm_loop(
                    emitter=emitter,
                    state_container=state_container,
                    simple_chat_history=simple_chat_history,
                    tools=tools,
                    custom_agent_prompt=custom_agent_prompt,
                    llm=llm,
                    token_counter=token_counter,
                    db_session=db_session,
                    skip_clarification=skip_clarification,
                    user_identity=user_identity,
                    chat_session_id=str(chat_session.id),
                    all_injected_file_metadata=all_injected_file_metadata,
                ),
                llm_loop_completion_callback,
                is_connected=check_is_connected,
                emitter=emitter,
                state_container=state_container,
            )
        else:
            yield from run_chat_loop_with_state_containers(
                lambda emitter, state_container: run_llm_loop(
                    emitter=emitter,
                    state_container=state_container,
                    simple_chat_history=simple_chat_history,
                    tools=tools,
                    custom_agent_prompt=custom_agent_prompt,
                    context_files=extracted_context_files,
                    persona=effective_persona,
                    user_memory_context=user_memory_context,
                    llm=llm,
                    token_counter=token_counter,
                    db_session=db_session,
                    forced_tool_id=forced_tool_id,
                    user_identity=user_identity,
                    chat_session_id=str(chat_session.id),
                    chat_files=chat_files_for_tools,
                    include_citations=new_msg_req.include_citations,
                    all_injected_file_metadata=all_injected_file_metadata,
                    inject_memories_in_prompt=user.use_memories,
                ),
                llm_loop_completion_callback,
                is_connected=check_is_connected,  # Not passed through to run_llm_loop
                emitter=emitter,
                state_container=state_container,
            )

    except ValueError as e:
        logger.exception("Failed to process chat message.")

        error_msg = str(e)
        yield StreamingError(
            error=error_msg,
            error_code="VALIDATION_ERROR",
            is_retryable=True,
        )
        db_session.rollback()
        return

    except Exception as e:
        logger.exception(f"Failed to process chat message due to {e}")
        error_msg = str(e)
        stack_trace = traceback.format_exc()

        if llm:
            client_error_msg, error_code, is_retryable = litellm_exception_to_error_msg(
                e, llm
            )
            if llm.config.api_key and len(llm.config.api_key) > 2:
                client_error_msg = client_error_msg.replace(
                    llm.config.api_key, "[REDACTED_API_KEY]"
                )
                stack_trace = stack_trace.replace(
                    llm.config.api_key, "[REDACTED_API_KEY]"
                )

            yield StreamingError(
                error=client_error_msg,
                stack_trace=stack_trace,
                error_code=error_code,
                is_retryable=is_retryable,
                details={
                    "model": llm.config.model_name,
                    "provider": llm.config.model_provider,
                },
            )
        else:
            # LLM was never initialized - early failure
            yield StreamingError(
                error="Failed to initialize the chat. Please check your configuration and try again.",
                stack_trace=stack_trace,
                error_code="INIT_FAILED",
                is_retryable=True,
            )

        db_session.rollback()
    finally:
        if mock_response_token is not None:
            reset_llm_mock_response(mock_response_token)

        try:
            if cache is not None and chat_session is not None:
                set_processing_status(
                    chat_session_id=chat_session.id,
                    cache=cache,
                    value=False,
                )
        except Exception:
            logger.exception("Error in setting processing status")


def llm_loop_completion_handle(
    state_container: ChatStateContainer,
    is_connected: Callable[[], bool],
    db_session: Session,
    assistant_message: ChatMessage,
    llm: LLM,
    reserved_tokens: int,
) -> None:
    chat_session_id = assistant_message.chat_session_id

    # Determine if stopped by user
    completed_normally = is_connected()
    # Build final answer based on completion status
    if completed_normally:
        if state_container.answer_tokens is None:
            raise RuntimeError(
                "LLM run completed normally but did not return an answer."
            )
        final_answer = state_container.answer_tokens
    else:
        # Stopped by user - append stop message
        logger.debug(f"Chat session {chat_session_id} stopped by user")
        if state_container.answer_tokens:
            final_answer = (
                state_container.answer_tokens
                + " ... \n\nGeneration was stopped by the user."
            )
        else:
            final_answer = "The generation was stopped by the user."

    save_chat_turn(
        message_text=final_answer,
        reasoning_tokens=state_container.reasoning_tokens,
        citation_to_doc=state_container.citation_to_doc,
        tool_calls=state_container.tool_calls,
        all_search_docs=state_container.get_all_search_docs(),
        db_session=db_session,
        assistant_message=assistant_message,
        is_clarification=state_container.is_clarification,
        emitted_citations=state_container.get_emitted_citations(),
        pre_answer_processing_time=state_container.get_pre_answer_processing_time(),
    )

    # Check if compression is needed after saving the message
    updated_chat_history = create_chat_history_chain(
        chat_session_id=chat_session_id,
        db_session=db_session,
    )
    total_tokens = calculate_total_history_tokens(updated_chat_history)

    compression_params = get_compression_params(
        max_input_tokens=llm.config.max_input_tokens,
        current_history_tokens=total_tokens,
        reserved_tokens=reserved_tokens,
    )
    if compression_params.should_compress:
        # Build tool mapping for formatting messages
        all_tools = get_tools(db_session)
        tool_id_to_name = {tool.id: tool.name for tool in all_tools}

        compress_chat_history(
            db_session=db_session,
            chat_history=updated_chat_history,
            llm=llm,
            compression_params=compression_params,
            tool_id_to_name=tool_id_to_name,
        )


def remove_answer_citations(answer: str) -> str:
    pattern = r"\s*\[\[\d+\]\]\(http[s]?://[^\s]+\)"

    return re.sub(pattern, "", answer)


@log_function_time()
def gather_stream(
    packets: AnswerStream,
) -> ChatBasicResponse:
    answer: str | None = None
    citations: list[CitationInfo] = []
    error_msg: str | None = None
    message_id: int | None = None
    top_documents: list[SearchDoc] = []

    for packet in packets:
        if isinstance(packet, Packet):
            # Handle the different packet object types
            if isinstance(packet.obj, AgentResponseStart):
                # AgentResponseStart contains the final documents
                if packet.obj.final_documents:
                    top_documents = packet.obj.final_documents
            elif isinstance(packet.obj, AgentResponseDelta):
                # AgentResponseDelta contains incremental content updates
                if answer is None:
                    answer = ""
                if packet.obj.content:
                    answer += packet.obj.content
            elif isinstance(packet.obj, CitationInfo):
                # CitationInfo contains citation information
                citations.append(packet.obj)
        elif isinstance(packet, StreamingError):
            error_msg = packet.error
        elif isinstance(packet, MessageResponseIDInfo):
            message_id = packet.reserved_assistant_message_id

    if message_id is None:
        raise ValueError("Message ID is required")

    if answer is None:
        # This should never be the case as these non-streamed flows do not have a stop-generation signal
        raise RuntimeError("Answer was not generated")

    return ChatBasicResponse(
        answer=answer,
        answer_citationless=remove_answer_citations(answer),
        citation_info=citations,
        message_id=message_id,
        error_msg=error_msg,
        top_documents=top_documents,
    )


@log_function_time()
def gather_stream_full(
    packets: AnswerStream,
    state_container: ChatStateContainer,
) -> ChatFullResponse:
    """
    Aggregate streaming packets and state container into a complete ChatFullResponse.

    This function consumes all packets from the stream and combines them with
    the accumulated state from the ChatStateContainer to build a complete response
    including answer, reasoning, citations, and tool calls.

    Args:
        packets: The stream of packets from handle_stream_message_objects
        state_container: The state container that accumulates tool calls, reasoning, etc.

    Returns:
        ChatFullResponse with all available data
    """
    answer: str | None = None
    citations: list[CitationInfo] = []
    error_msg: str | None = None
    message_id: int | None = None
    top_documents: list[SearchDoc] = []
    chat_session_id: UUID | None = None

    for packet in packets:
        if isinstance(packet, Packet):
            if isinstance(packet.obj, AgentResponseStart):
                if packet.obj.final_documents:
                    top_documents = packet.obj.final_documents
            elif isinstance(packet.obj, AgentResponseDelta):
                if answer is None:
                    answer = ""
                if packet.obj.content:
                    answer += packet.obj.content
            elif isinstance(packet.obj, CitationInfo):
                citations.append(packet.obj)
        elif isinstance(packet, StreamingError):
            error_msg = packet.error
        elif isinstance(packet, MessageResponseIDInfo):
            message_id = packet.reserved_assistant_message_id
        elif isinstance(packet, CreateChatSessionID):
            chat_session_id = packet.chat_session_id

    if message_id is None:
        raise ValueError("Message ID is required")

    # Use state_container for complete answer (handles edge cases gracefully)
    final_answer = state_container.get_answer_tokens() or answer or ""

    # Get reasoning from state container (None when model doesn't produce reasoning)
    reasoning = state_container.get_reasoning_tokens()

    # Convert ToolCallInfo list to ToolCallResponse list
    tool_call_responses = [
        ToolCallResponse(
            tool_name=tc.tool_name,
            tool_arguments=tc.tool_call_arguments,
            tool_result=tc.tool_call_response,
            search_docs=tc.search_docs,
            generated_images=tc.generated_images,
            pre_reasoning=tc.reasoning_tokens,
        )
        for tc in state_container.get_tool_calls()
    ]

    return ChatFullResponse(
        answer=final_answer,
        answer_citationless=remove_answer_citations(final_answer),
        pre_answer_reasoning=reasoning,
        tool_calls=tool_call_responses,
        top_documents=top_documents,
        citation_info=citations,
        message_id=message_id,
        chat_session_id=chat_session_id,
        error_msg=error_msg,
    )
