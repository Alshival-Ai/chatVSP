"""Tests for save_chat.py.

Covers _extract_referenced_file_descriptors and sanitization in save_chat_turn.
"""

from unittest.mock import MagicMock

from pytest import MonkeyPatch

from onyx.chat import save_chat
from onyx.chat.save_chat import _extract_referenced_file_descriptors
from onyx.chat.save_chat import _rewrite_generated_file_paths_to_links
from onyx.file_store.models import ChatFileType
from onyx.tools.models import PythonExecutionFile
from onyx.tools.models import ToolCallInfo


def _make_tool_call_info(
    generated_files: list[PythonExecutionFile] | None = None,
    tool_name: str = "python",
) -> ToolCallInfo:
    return ToolCallInfo(
        parent_tool_call_id=None,
        turn_index=0,
        tab_index=0,
        tool_name=tool_name,
        tool_call_id="tc_1",
        tool_id=1,
        reasoning_tokens=None,
        tool_call_arguments={"code": "print('hi')"},
        tool_call_response="{}",
        generated_files=generated_files,
    )


# ---- _extract_referenced_file_descriptors tests ----


def test_returns_empty_when_no_generated_files() -> None:
    tool_call = _make_tool_call_info(generated_files=None)
    result = _extract_referenced_file_descriptors([tool_call], "some message")
    assert result == []


def test_returns_empty_when_file_not_referenced() -> None:
    files = [
        PythonExecutionFile(
            filename="chart.png",
            file_link="http://localhost/api/chat/file/abc-123",
        )
    ]
    tool_call = _make_tool_call_info(generated_files=files)
    result = _extract_referenced_file_descriptors([tool_call], "Here is your answer.")
    assert result == []


def test_extracts_referenced_file() -> None:
    file_id = "abc-123-def"
    files = [
        PythonExecutionFile(
            filename="chart.png",
            file_link=f"http://localhost/api/chat/file/{file_id}",
        )
    ]
    tool_call = _make_tool_call_info(generated_files=files)
    message = (
        f"Here is the chart: [chart.png](http://localhost/api/chat/file/{file_id})"
    )

    result = _extract_referenced_file_descriptors([tool_call], message)

    assert len(result) == 1
    assert result[0]["id"] == file_id
    assert result[0]["type"] == ChatFileType.IMAGE
    assert result[0]["name"] == "chart.png"


def test_filters_unreferenced_files() -> None:
    referenced_id = "ref-111"
    unreferenced_id = "unref-222"
    files = [
        PythonExecutionFile(
            filename="chart.png",
            file_link=f"http://localhost/api/chat/file/{referenced_id}",
        ),
        PythonExecutionFile(
            filename="data.csv",
            file_link=f"http://localhost/api/chat/file/{unreferenced_id}",
        ),
    ]
    tool_call = _make_tool_call_info(generated_files=files)
    message = f"Here is the chart: [chart.png](http://localhost/api/chat/file/{referenced_id})"

    result = _extract_referenced_file_descriptors([tool_call], message)

    assert len(result) == 1
    assert result[0]["id"] == referenced_id
    assert result[0]["name"] == "chart.png"


def test_extracts_from_multiple_tool_calls() -> None:
    id_1 = "file-aaa"
    id_2 = "file-bbb"
    tc1 = _make_tool_call_info(
        generated_files=[
            PythonExecutionFile(
                filename="plot.png",
                file_link=f"http://localhost/api/chat/file/{id_1}",
            )
        ]
    )
    tc2 = _make_tool_call_info(
        generated_files=[
            PythonExecutionFile(
                filename="report.csv",
                file_link=f"http://localhost/api/chat/file/{id_2}",
            )
        ]
    )
    message = (
        f"[plot.png](http://localhost/api/chat/file/{id_1}) "
        f"and [report.csv](http://localhost/api/chat/file/{id_2})"
    )

    result = _extract_referenced_file_descriptors([tc1, tc2], message)

    assert len(result) == 2
    ids = {d["id"] for d in result}
    assert ids == {id_1, id_2}


def test_csv_file_type() -> None:
    file_id = "csv-123"
    files = [
        PythonExecutionFile(
            filename="data.csv",
            file_link=f"http://localhost/api/chat/file/{file_id}",
        )
    ]
    tool_call = _make_tool_call_info(generated_files=files)
    message = f"[data.csv](http://localhost/api/chat/file/{file_id})"

    result = _extract_referenced_file_descriptors([tool_call], message)

    assert len(result) == 1
    assert result[0]["type"] == ChatFileType.CSV


def test_unknown_extension_defaults_to_plain_text() -> None:
    file_id = "bin-456"
    files = [
        PythonExecutionFile(
            filename="output.xyz",
            file_link=f"http://localhost/api/chat/file/{file_id}",
        )
    ]
    tool_call = _make_tool_call_info(generated_files=files)
    message = f"[output.xyz](http://localhost/api/chat/file/{file_id})"

    result = _extract_referenced_file_descriptors([tool_call], message)

    assert len(result) == 1
    assert result[0]["type"] == ChatFileType.PLAIN_TEXT


def test_skips_tool_calls_without_generated_files() -> None:
    file_id = "img-789"
    tc_no_files = _make_tool_call_info(generated_files=None)
    tc_empty = _make_tool_call_info(generated_files=[])
    tc_with_files = _make_tool_call_info(
        generated_files=[
            PythonExecutionFile(
                filename="result.png",
                file_link=f"http://localhost/api/chat/file/{file_id}",
            )
        ]
    )
    message = f"[result.png](http://localhost/api/chat/file/{file_id})"

    result = _extract_referenced_file_descriptors(
        [tc_no_files, tc_empty, tc_with_files], message
    )

    assert len(result) == 1
    assert result[0]["id"] == file_id


def test_rewrite_generated_file_paths_to_links_replaces_sandbox_paths() -> None:
    file_id = "kmz-123"
    filename = "ward_packets_combined.kmz"
    files = [
        PythonExecutionFile(
            filename=filename,
            file_link=f"http://localhost/api/chat/file/{file_id}",
        )
    ]
    tool_call = _make_tool_call_info(generated_files=files)
    message = f"Download:\nKMZ\nsandbox:/mnt/data/{filename}"

    rewritten = _rewrite_generated_file_paths_to_links(message, [tool_call])

    assert f"sandbox:/mnt/data/{filename}" not in rewritten
    assert (
        f"[{filename}](http://localhost/api/chat/file/{file_id})" in rewritten
    )


def test_rewrite_generated_file_paths_to_links_replaces_mnt_data_markdown_url() -> None:
    file_id = "xlsx-456"
    filename = "ward_packets_combined.xlsx"
    files = [
        PythonExecutionFile(
            filename=filename,
            file_link=f"http://localhost/api/chat/file/{file_id}",
        )
    ]
    tool_call = _make_tool_call_info(generated_files=files)
    message = f"Download workbook: [file](/mnt/data/{filename})"

    rewritten = _rewrite_generated_file_paths_to_links(message, [tool_call])

    assert f"(/mnt/data/{filename})" not in rewritten
    assert (
        f"[file](http://localhost/api/chat/file/{file_id})" in rewritten
    )


def test_rewrite_generated_file_paths_to_links_replaces_filename_file_link_placeholder() -> None:
    file_id = "kmz-789"
    filename = "compiled_packets.kmz"
    tool_call = _make_tool_call_info(
        generated_files=[
            PythonExecutionFile(
                filename=filename,
                file_link=f"http://localhost/api/chat/file/{file_id}",
            )
        ]
    )
    message = f"Download here: [{filename}](https://file_link/)"

    rewritten = _rewrite_generated_file_paths_to_links(message, [tool_call])

    assert "https://file_link/" not in rewritten
    assert (
        f"[{filename}](http://localhost/api/chat/file/{file_id})" in rewritten
    )


def test_rewrite_generated_file_paths_to_links_replaces_generic_file_link_placeholders_by_order() -> None:
    kmz_id = "kmz-101"
    xlsx_id = "xlsx-202"
    tool_call = _make_tool_call_info(
        generated_files=[
            PythonExecutionFile(
                filename="compiled_packets.kmz",
                file_link=f"http://localhost/api/chat/file/{kmz_id}",
            ),
            PythonExecutionFile(
                filename="compiled_packets.xlsx",
                file_link=f"http://localhost/api/chat/file/{xlsx_id}",
            ),
        ]
    )
    message = (
        "KMZ: [Download](file_link)\n"
        "XLSX: [Download](https://file_link/)"
    )

    rewritten = _rewrite_generated_file_paths_to_links(message, [tool_call])

    assert f"(http://localhost/api/chat/file/{kmz_id})" in rewritten
    assert f"(http://localhost/api/chat/file/{xlsx_id})" in rewritten


def test_rewrite_generated_file_paths_to_links_uses_unresolved_file_for_generic_placeholder() -> None:
    kmz_id = "kmz-303"
    xlsx_id = "xlsx-404"
    tool_call = _make_tool_call_info(
        generated_files=[
            PythonExecutionFile(
                filename="compiled_packets.kmz",
                file_link=f"http://localhost/api/chat/file/{kmz_id}",
            ),
            PythonExecutionFile(
                filename="compiled_packets.xlsx",
                file_link=f"http://localhost/api/chat/file/{xlsx_id}",
            ),
        ]
    )
    message = (
        "KMZ: [compiled_packets.kmz](https://file_link/)\n"
        "XLSX: [Download](file_link)"
    )

    rewritten = _rewrite_generated_file_paths_to_links(message, [tool_call])

    assert f"[compiled_packets.kmz](http://localhost/api/chat/file/{kmz_id})" in rewritten
    assert f"(http://localhost/api/chat/file/{xlsx_id})" in rewritten


def test_rewrite_generated_file_paths_to_links_does_not_map_kmz_placeholder_to_xlsx() -> None:
    xlsx_id = "xlsx-only-1"
    tool_call = _make_tool_call_info(
        generated_files=[
            PythonExecutionFile(
                filename="compiled_packets.xlsx",
                file_link=f"http://localhost/api/chat/file/{xlsx_id}",
            )
        ]
    )
    message = (
        "KMZ: [Download](file_link)\n"
        "Filled template XLSX: [Download](https://file_link/)"
    )

    rewritten = _rewrite_generated_file_paths_to_links(message, [tool_call])

    assert f"[Download](http://localhost/api/chat/file/{xlsx_id})" not in rewritten
    assert "KMZ: [Download](file_link)" in rewritten
    assert (
        "Filled template XLSX: [compiled_packets.xlsx]"
        f"(http://localhost/api/chat/file/{xlsx_id})"
        in rewritten
    )


# ---- save_chat_turn sanitization test ----


def test_save_chat_turn_sanitizes_message_and_reasoning(
    monkeypatch: MonkeyPatch,
) -> None:
    mock_tokenizer = MagicMock()
    mock_tokenizer.encode.return_value = [1, 2, 3]
    monkeypatch.setattr(save_chat, "get_tokenizer", lambda *_a, **_kw: mock_tokenizer)

    mock_msg = MagicMock()
    mock_msg.id = 1
    mock_msg.chat_session_id = "test"
    mock_msg.files = None

    mock_session = MagicMock()

    save_chat.save_chat_turn(
        message_text="hello\x00world\ud800",
        reasoning_tokens="think\x00ing\udfff",
        tool_calls=[],
        citation_to_doc={},
        all_search_docs={},
        db_session=mock_session,
        assistant_message=mock_msg,
    )

    assert mock_msg.message == "helloworld"
    assert mock_msg.reasoning_tokens == "thinking"


def test_save_chat_turn_attaches_files_when_message_uses_sandbox_path(
    monkeypatch: MonkeyPatch,
) -> None:
    mock_tokenizer = MagicMock()
    mock_tokenizer.encode.return_value = [1, 2, 3]
    monkeypatch.setattr(save_chat, "get_tokenizer", lambda *_a, **_kw: mock_tokenizer)
    monkeypatch.setattr(
        save_chat, "_create_and_link_tool_calls", lambda *_a, **_kw: None
    )

    file_id = "kmz-file-id"
    filename = "ward_packets_combined.kmz"
    tool_calls = [
        _make_tool_call_info(
            generated_files=[
                PythonExecutionFile(
                    filename=filename,
                    file_link=f"http://localhost/api/chat/file/{file_id}",
                )
            ]
        )
    ]

    mock_msg = MagicMock()
    mock_msg.id = 1
    mock_msg.chat_session_id = "test"
    mock_msg.files = None

    mock_session = MagicMock()

    save_chat.save_chat_turn(
        message_text=f"Download file:\nsandbox:/mnt/data/{filename}",
        reasoning_tokens=None,
        tool_calls=tool_calls,
        citation_to_doc={},
        all_search_docs={},
        db_session=mock_session,
        assistant_message=mock_msg,
    )

    assert f"sandbox:/mnt/data/{filename}" not in mock_msg.message
    assert (
        f"[{filename}](http://localhost/api/chat/file/{file_id})"
        in mock_msg.message
    )
    assert len(mock_msg.files) == 1
    assert mock_msg.files[0]["id"] == file_id
