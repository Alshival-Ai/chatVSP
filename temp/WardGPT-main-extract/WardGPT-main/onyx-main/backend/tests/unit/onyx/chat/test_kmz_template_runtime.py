from io import BytesIO
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

from onyx.chat.process_message import _append_runtime_file_if_missing
from onyx.chat.process_message import _file_descriptor_has_filename
from onyx.chat.process_message import _load_kmz_template_runtime_file
from onyx.chat.process_message import _split_runtime_descriptor_ids
from onyx.chat.process_message import _truncate_xlsx_content_to_row_limit
from onyx.chat.process_message import KMZ_WORKBOOK_TEMPLATE_FILENAME
from onyx.chat.process_message import KMZ_WORKBOOK_TEMPLATE_MAX_ROWS
from onyx.chat.process_message import KMZ_WORKBOOK_TEMPLATE_RUNTIME_FILE_ID
from onyx.file_store.models import ChatFileType
from onyx.file_store.models import InMemoryChatFile


def _make_file(
    *,
    file_id: str,
    filename: str,
) -> InMemoryChatFile:
    return InMemoryChatFile(
        file_id=file_id,
        content=b"data",
        file_type=ChatFileType.DOC,
        filename=filename,
        is_chat_file=True,
    )


def _make_workbook_bytes(total_rows: int) -> bytes:
    rows_xml = "".join(
        [
            (
                f'<row r="{row_num}">'
                f'<c r="A{row_num}" t="inlineStr"><is><t>row-{row_num}</t></is></c>'
                "</row>"
            )
            for row_num in range(1, total_rows + 1)
        ]
    )
    sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<dimension ref="A1:A{total_rows}"/>'
        f"<sheetData>{rows_xml}</sheetData>"
        "</worksheet>"
    )
    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        "<sheets>"
        '<sheet name="KMZ_INPUT" sheetId="1" r:id="rId1"/>'
        "</sheets>"
        "</workbook>"
    )
    workbook_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    root_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    content_types_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>"
    )

    out = BytesIO()
    with zipfile.ZipFile(out, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types_xml)
        archive.writestr("_rels/.rels", root_rels_xml)
        archive.writestr("xl/workbook.xml", workbook_xml)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml)
        archive.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return out.getvalue()


def _count_rows_in_workbook(content: bytes) -> int:
    ns_uri = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    row_tag = f"{{{ns_uri}}}row"
    with zipfile.ZipFile(BytesIO(content), mode="r") as archive:
        sheet_xml = archive.read("xl/worksheets/sheet1.xml")
    root = ET.fromstring(sheet_xml)
    return len(root.findall(f".//{row_tag}"))


def test_file_descriptor_has_filename_case_insensitive() -> None:
    descriptors = [
        {
            "id": "1",
            "type": ChatFileType.DOC,
            "name": "My_Template.XLSX",
            "is_chat_file": True,
        }
    ]

    assert _file_descriptor_has_filename(
        descriptors,
        filename="my_template.xlsx",
    )


def test_split_runtime_descriptor_ids_skips_synthetic_kmz_template_chat_id() -> None:
    descriptors = [
        {
            "id": KMZ_WORKBOOK_TEMPLATE_RUNTIME_FILE_ID,
            "type": ChatFileType.DOC,
            "name": KMZ_WORKBOOK_TEMPLATE_FILENAME,
            "is_chat_file": True,
        },
        {
            "id": "real-chat-file-id",
            "type": ChatFileType.DOC,
            "name": "packet.pdf",
            "is_chat_file": True,
        },
        {
            "id": "user-file-descriptor",
            "type": ChatFileType.DOC,
            "name": "uploaded.pdf",
            "is_chat_file": False,
            "user_file_id": "4d6f12d3-7a5a-4d90-b8f9-7b5956f7a9d3",
        },
        {
            "id": "bad-user-file",
            "type": ChatFileType.DOC,
            "name": "invalid.pdf",
            "is_chat_file": False,
            "user_file_id": "not-a-uuid",
        },
    ]

    user_file_ids, chat_file_ids = _split_runtime_descriptor_ids(descriptors)

    assert chat_file_ids == ["real-chat-file-id"]
    assert [str(user_file_id) for user_file_id in user_file_ids] == [
        "4d6f12d3-7a5a-4d90-b8f9-7b5956f7a9d3"
    ]


def test_append_runtime_file_if_missing_prevents_duplicate_by_id() -> None:
    existing = _make_file(file_id="same-id", filename="a.xlsx")
    runtime_files = [existing]

    _append_runtime_file_if_missing(
        runtime_files,
        _make_file(file_id="same-id", filename="different.xlsx"),
    )

    assert len(runtime_files) == 1


def test_append_runtime_file_if_missing_prevents_duplicate_by_filename() -> None:
    existing = _make_file(file_id="id-1", filename="Template.xlsx")
    runtime_files = [existing]

    _append_runtime_file_if_missing(
        runtime_files,
        _make_file(file_id="id-2", filename="template.xlsx"),
    )

    assert len(runtime_files) == 1


def test_append_runtime_file_if_missing_adds_new_file() -> None:
    runtime_files = [_make_file(file_id="id-1", filename="a.xlsx")]

    _append_runtime_file_if_missing(
        runtime_files,
        _make_file(file_id="id-2", filename="b.xlsx"),
    )

    assert len(runtime_files) == 2


@patch("onyx.chat.process_message._resolve_kmz_template_path")
def test_load_kmz_template_runtime_file_returns_expected_model(mock_resolve, tmp_path) -> None:
    template_path = tmp_path / KMZ_WORKBOOK_TEMPLATE_FILENAME
    template_path.write_bytes(_make_workbook_bytes(total_rows=25))
    mock_resolve.return_value = template_path

    runtime_file = _load_kmz_template_runtime_file()

    assert runtime_file is not None
    assert runtime_file.file_id == KMZ_WORKBOOK_TEMPLATE_RUNTIME_FILE_ID
    assert runtime_file.filename == KMZ_WORKBOOK_TEMPLATE_FILENAME
    assert runtime_file.file_type == ChatFileType.DOC
    assert runtime_file.is_chat_file is True
    assert _count_rows_in_workbook(runtime_file.content) == KMZ_WORKBOOK_TEMPLATE_MAX_ROWS


def test_truncate_xlsx_content_to_row_limit_preserves_first_rows_only() -> None:
    original = _make_workbook_bytes(total_rows=30)
    truncated = _truncate_xlsx_content_to_row_limit(
        content=original,
        max_rows=10,
    )

    assert _count_rows_in_workbook(truncated) == 10


def test_truncate_xlsx_content_to_row_limit_invalid_content_falls_back() -> None:
    raw = b"not-an-xlsx"
    assert _truncate_xlsx_content_to_row_limit(content=raw, max_rows=10) == raw
