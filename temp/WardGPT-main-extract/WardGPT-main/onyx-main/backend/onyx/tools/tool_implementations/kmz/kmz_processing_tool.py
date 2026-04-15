from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session
from typing_extensions import override

from onyx.chat.emitter import Emitter
from onyx.chat.kmz_batching import run_kmz_batch_preprocessing
from onyx.chat.kmz_batching import validate_kmz_pdf_count_or_raise
from onyx.db.engine.sql_engine import get_session_with_current_tenant
from onyx.file_store.models import InMemoryChatFile
from onyx.file_store.utils import load_chat_file_by_id
from onyx.file_store.utils import load_user_file
from onyx.llm.factory import get_llm_token_counter
from onyx.llm.interfaces import LLM
from onyx.server.query_and_chat.placement import Placement
from onyx.server.query_and_chat.streaming_models import CustomToolDelta
from onyx.server.query_and_chat.streaming_models import CustomToolStart
from onyx.server.query_and_chat.streaming_models import Packet
from onyx.tools.constants import KMZ_PROCESSING_TOOL_NAME
from onyx.tools.interface import Tool
from onyx.tools.models import CustomToolCallSummary
from onyx.tools.models import ToolCallException
from onyx.tools.models import ToolResponse

MODE_FIELD = "mode"
INSTRUCTION_FIELD = "instruction"

MANY_TO_MANY_MODE = "many_to_many"


class KMZProcessingTool(Tool[None]):
    NAME = KMZ_PROCESSING_TOOL_NAME
    DISPLAY_NAME = "KMZ Packet Processor"
    DESCRIPTION = (
        "Preprocess packet files for KMZ generation. "
        "Returns per-packet preprocessing context for one KMZ per packet output."
    )

    def __init__(
        self,
        tool_id: int,
        emitter: Emitter,
        user_file_ids: list[UUID],
        chat_file_ids: list[str],
        llm: LLM,
    ) -> None:
        super().__init__(emitter=emitter)
        self._id = tool_id
        self._user_file_ids = set(user_file_ids)
        self._chat_file_ids = set(chat_file_ids)
        self._llm = llm

    @property
    def id(self) -> int:
        return self._id

    @property
    def name(self) -> str:
        return self.NAME

    @property
    def description(self) -> str:
        return self.DESCRIPTION

    @property
    def display_name(self) -> str:
        return self.DISPLAY_NAME

    @override
    @classmethod
    def is_available(cls, db_session: Session) -> bool:  # noqa: ARG003
        return True

    def tool_definition(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.DESCRIPTION,
                "parameters": {
                    "type": "object",
                    "properties": {
                        INSTRUCTION_FIELD: {
                            "type": "string",
                            "description": "Optional operator instruction for KMZ generation.",
                        },
                    },
                    "required": [],
                },
            },
        }

    def emit_start(self, placement: Placement) -> None:
        self.emitter.emit(
            Packet(
                placement=placement,
                obj=CustomToolStart(tool_name=self.display_name),
            )
        )

    def _resolve_mode(self, mode_value: Any) -> str:
        raw_mode = str(mode_value or "").strip().lower()
        if not raw_mode:
            return MANY_TO_MANY_MODE

        aliases = {
            MANY_TO_MANY_MODE: MANY_TO_MANY_MODE,
            "per_packet": MANY_TO_MANY_MODE,
            "one_per_packet": MANY_TO_MANY_MODE,
            "individual": MANY_TO_MANY_MODE,
            # Backward compatibility: compiled/single modes are now normalized to per-packet.
            "many_to_one": MANY_TO_MANY_MODE,
            "single": MANY_TO_MANY_MODE,
            "compiled": MANY_TO_MANY_MODE,
            "combined": MANY_TO_MANY_MODE,
        }

        normalized = aliases.get(raw_mode)
        if normalized:
            return normalized

        raise ToolCallException(
            message=f"Invalid mode for KMZ processor: {raw_mode}",
            llm_facing_message=(
                "KMZ packet processing now supports per-packet mode only. "
                "Use mode='many_to_many' (or omit mode) to continue."
            ),
        )

    def _load_runtime_files(self) -> list[InMemoryChatFile]:
        runtime_files: list[InMemoryChatFile] = []

        with get_session_with_current_tenant() as db_session:
            for user_file_id in self._user_file_ids:
                runtime_files.append(
                    load_user_file(
                        user_file_id=user_file_id,
                        db_session=db_session,
                    )
                )

        for chat_file_id in self._chat_file_ids:
            runtime_files.append(load_chat_file_by_id(chat_file_id))

        return runtime_files

    def _build_mode_prompt(self) -> str:
        return "Create one KMZ per packet from all attached packet files."

    def run(
        self,
        placement: Placement,
        override_kwargs: None,  # noqa: ARG002
        **llm_kwargs: Any,
    ) -> ToolResponse:
        mode = self._resolve_mode(llm_kwargs.get(MODE_FIELD))
        operator_instruction = str(llm_kwargs.get(INSTRUCTION_FIELD) or "").strip()

        runtime_files = self._load_runtime_files()
        pdf_files = [
            file
            for file in runtime_files
            if file.filename and Path(file.filename).suffix.lower() == ".pdf"
        ]

        if not pdf_files:
            raise ToolCallException(
                message="KMZ processing tool invoked without packet PDFs",
                llm_facing_message=(
                    "No packet PDFs were available to process. "
                    "Ask the user to attach/select packet files and try again."
                ),
            )

        user_message = self._build_mode_prompt()
        if operator_instruction:
            user_message = (
                f"{user_message}\n\nAdditional instruction:\n"
                f"{operator_instruction}"
            )

        validate_kmz_pdf_count_or_raise(message=user_message, files=runtime_files)

        batching_outcome = run_kmz_batch_preprocessing(
            llm=self._llm,
            token_counter=get_llm_token_counter(self._llm),
            user_message=user_message,
            runtime_files=runtime_files,
            user_identity=None,
        )

        non_pdf_names = [
            descriptor.name or descriptor.id
            for descriptor in batching_outcome.runtime_file_descriptors
            if descriptor.name or descriptor.id
        ]

        tool_result_payload = {
            "mode": mode,
            "pdf_count": len(pdf_files),
            "source_files": [file.filename or str(file.file_id) for file in pdf_files],
            "non_pdf_files_retained": non_pdf_names,
            "preprocessing_context": batching_outcome.additional_context_appendix,
        }

        self.emitter.emit(
            Packet(
                placement=placement,
                obj=CustomToolDelta(
                    tool_name=self.display_name,
                    response_type="json",
                    data=tool_result_payload,
                ),
            )
        )

        mode_instruction = "Return one KMZ per packet/source file."
        llm_response = (
            f"KMZ packet processing complete. mode={mode}.\n"
            f"Processed {len(pdf_files)} packet PDF(s).\n"
            f"{mode_instruction}\n\n"
            "Use the preprocessing context below as canonical extraction guidance for final KMZ output:\n\n"
            f"{batching_outcome.additional_context_appendix or ''}"
        )

        return ToolResponse(
            rich_response=CustomToolCallSummary(
                tool_name=self.name,
                response_type="json",
                tool_result=tool_result_payload,
            ),
            llm_facing_response=llm_response,
        )
