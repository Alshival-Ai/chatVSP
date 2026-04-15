from queue import Queue

import pytest

from onyx.chat.emitter import Emitter
from onyx.tools.models import ToolCallException
from onyx.tools.tool_implementations.kmz.kmz_processing_tool import KMZProcessingTool
from onyx.tools.tool_implementations.kmz.kmz_processing_tool import MANY_TO_MANY_MODE


def _build_tool() -> KMZProcessingTool:
    return KMZProcessingTool(
        tool_id=1,
        emitter=Emitter(Queue()),
        user_file_ids=[],
        chat_file_ids=[],
        llm=object(),  # type: ignore[arg-type]
    )


def test_tool_definition_exposes_instruction_only() -> None:
    tool = _build_tool()

    definition = tool.tool_definition()
    parameters = definition["function"]["parameters"]
    properties = parameters["properties"]

    assert "instruction" in properties
    assert "mode" not in properties
    assert parameters["required"] == []


def test_resolve_mode_defaults_to_many_to_many() -> None:
    tool = _build_tool()

    assert tool._resolve_mode(None) == MANY_TO_MANY_MODE


def test_resolve_mode_normalizes_legacy_many_to_one_aliases() -> None:
    tool = _build_tool()

    assert tool._resolve_mode("many_to_one") == MANY_TO_MANY_MODE
    assert tool._resolve_mode("compiled") == MANY_TO_MANY_MODE
    assert tool._resolve_mode("combined") == MANY_TO_MANY_MODE


def test_resolve_mode_rejects_invalid_values() -> None:
    tool = _build_tool()

    with pytest.raises(ToolCallException) as exc_info:
        tool._resolve_mode("unsupported_mode")

    assert "per-packet mode only" in str(exc_info.value.llm_facing_message)
