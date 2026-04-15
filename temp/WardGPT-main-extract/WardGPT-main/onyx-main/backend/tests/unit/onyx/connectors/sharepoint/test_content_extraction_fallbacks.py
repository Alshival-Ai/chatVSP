from __future__ import annotations

from collections import deque
from datetime import datetime
from datetime import timezone
from types import SimpleNamespace
from typing import Any

import pytest

from onyx.connectors.models import Document
from onyx.connectors.models import DocumentSource
from onyx.connectors.models import TextSection
from onyx.connectors.sharepoint.connector import (
    _convert_driveitem_to_document_with_permissions,
)
from onyx.connectors.sharepoint.connector import DriveItemData
from onyx.connectors.sharepoint.connector import SharepointConnector
from onyx.connectors.sharepoint.connector import SharepointConnectorCheckpoint
from onyx.connectors.sharepoint.connector import SiteDescriptor


def _consume_generator(gen: Any) -> tuple[list[Any], SharepointConnectorCheckpoint]:
    yielded: list[Any] = []
    try:
        while True:
            yielded.append(next(gen))
    except StopIteration as e:
        return yielded, e.value


def test_convert_driveitem_without_mime_type_uses_content_extraction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driveitem = DriveItemData(
        id="file-1",
        name="notes.docx",
        web_url="https://example.sharepoint.com/sites/sample/notes.docx",
        size=8,
        mime_type=None,
        download_url=None,
        drive_id="drive-1",
    )

    def fake_download_via_graph_api(
        access_token: str,  # noqa: ARG001
        drive_id: str,  # noqa: ARG001
        item_id: str,  # noqa: ARG001
        bytes_allowed: int,  # noqa: ARG001
        graph_api_base: str,  # noqa: ARG001
    ) -> bytes:
        return b"hello"

    def fake_extract_text_and_images(
        file: Any,  # noqa: ARG001
        file_name: str,  # noqa: ARG001
        image_callback: Any = None,  # noqa: ARG001
    ) -> SimpleNamespace:
        return SimpleNamespace(text_content="extracted")

    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._download_via_graph_api",
        fake_download_via_graph_api,
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector.extract_text_and_images",
        fake_extract_text_and_images,
    )

    doc = _convert_driveitem_to_document_with_permissions(
        driveitem=driveitem,
        drive_name="Shared Documents",
        ctx=None,
        graph_client=object(),  # type: ignore[arg-type]
        graph_api_base="https://graph.microsoft.com/v1.0",
        include_permissions=False,
        parent_hierarchy_raw_node_id=None,
        access_token="token",
    )

    assert isinstance(doc, Document)
    assert doc.sections
    assert isinstance(doc.sections[0], TextSection)
    assert doc.sections[0].text == "extracted"


def test_load_from_checkpoint_backfills_missing_drive_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connector = SharepointConnector()
    connector._graph_client = object()
    connector.include_site_pages = False

    def fake_resolve_drive(
        self: SharepointConnector,  # noqa: ARG001
        site_descriptor: SiteDescriptor,  # noqa: ARG001
        drive_name: str,  # noqa: ARG001
    ) -> tuple[str, str | None]:
        return (
            "fake-drive-id",
            "https://example.sharepoint.com/sites/sample/Documents",
        )

    item_without_drive_id = DriveItemData(
        id="doc-1",
        name="report.pdf",
        web_url="https://example.sharepoint.com/sites/sample/report.pdf",
        parent_reference_path="/drives/fake-drive-id/root:",
        drive_id=None,
    )

    def fake_fetch_one_delta_page(
        self: SharepointConnector,  # noqa: ARG001
        page_url: str,  # noqa: ARG001
        drive_id: str,  # noqa: ARG001
        start: datetime | None = None,  # noqa: ARG001
        end: datetime | None = None,  # noqa: ARG001
        page_size: int = 200,  # noqa: ARG001
    ) -> tuple[list[DriveItemData], str | None]:
        return [item_without_drive_id], None

    captured_drive_ids: list[str | None] = []

    def fake_convert(
        driveitem: DriveItemData,
        drive_name: str,  # noqa: ARG001
        ctx: Any,  # noqa: ARG001
        graph_client: Any,  # noqa: ARG001
        graph_api_base: str,  # noqa: ARG001
        include_permissions: bool,  # noqa: ARG001
        parent_hierarchy_raw_node_id: str | None = None,  # noqa: ARG001
        access_token: str | None = None,  # noqa: ARG001
    ) -> Document:
        captured_drive_ids.append(driveitem.drive_id)
        return Document(
            id="doc-1",
            source=DocumentSource.SHAREPOINT,
            semantic_identifier="report.pdf",
            metadata={},
            sections=[TextSection(link="https://example.com", text="content")],
        )

    def fake_get_access_token(self: SharepointConnector) -> str:  # noqa: ARG001
        return "fake-access-token"

    monkeypatch.setattr(SharepointConnector, "_resolve_drive", fake_resolve_drive)
    monkeypatch.setattr(
        SharepointConnector, "_fetch_one_delta_page", fake_fetch_one_delta_page
    )
    monkeypatch.setattr(
        SharepointConnector, "_get_graph_access_token", fake_get_access_token
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._convert_driveitem_to_document_with_permissions",
        fake_convert,
    )

    checkpoint = SharepointConnectorCheckpoint(has_more=True)
    checkpoint.cached_site_descriptors = deque()
    checkpoint.current_site_descriptor = SiteDescriptor(
        url="https://example.sharepoint.com/sites/sample",
        drive_name=None,
        folder_path=None,
    )
    checkpoint.cached_drive_names = deque(["Documents"])
    checkpoint.process_site_pages = False

    gen = connector._load_from_checkpoint(
        start=0,
        end=datetime.now(timezone.utc).timestamp(),
        checkpoint=checkpoint,
        include_permissions=False,
    )
    yielded, _final_checkpoint = _consume_generator(gen)
    docs = [item for item in yielded if isinstance(item, Document)]

    assert len(docs) == 1
    assert captured_drive_ids == ["fake-drive-id"]


def test_convert_large_xlsx_over_row_limit_uses_profile_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driveitem = DriveItemData(
        id="xlsx-1",
        name="large.xlsx",
        web_url="https://example.sharepoint.com/sites/sample/large.xlsx",
        size=5_000,
        mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        download_url=None,
        drive_id="drive-1",
    )

    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector.SHAREPOINT_XLSX_MAX_FILE_SIZE_FOR_INDEXING",
        1_000,
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector.SHAREPOINT_XLSX_MAX_ROWS_FOR_INDEXING",
        1_000,
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._download_via_graph_api",
        lambda *args, **kwargs: b"fake-xlsx-bytes",
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._count_non_empty_xlsx_rows",
        lambda *args, **kwargs: 1_001,
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._build_xlsx_profile_sections",
        lambda *args, **kwargs: ["profile text", "sheet profile text"],
    )

    extraction_called = False

    def fake_extract_text_and_images(
        file: Any,  # noqa: ARG001
        file_name: str,  # noqa: ARG001
        image_callback: Any = None,  # noqa: ARG001
    ) -> SimpleNamespace:
        nonlocal extraction_called
        extraction_called = True
        return SimpleNamespace(text_content="should-not-be-used")

    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector.extract_text_and_images",
        fake_extract_text_and_images,
    )

    doc = _convert_driveitem_to_document_with_permissions(
        driveitem=driveitem,
        drive_name="Shared Documents",
        ctx=None,
        graph_client=object(),  # type: ignore[arg-type]
        graph_api_base="https://graph.microsoft.com/v1.0",
        include_permissions=False,
        parent_hierarchy_raw_node_id=None,
        access_token="token",
    )

    assert isinstance(doc, Document)
    assert doc.sections
    assert isinstance(doc.sections[0], TextSection)
    assert doc.sections[0].text == "profile text"
    assert isinstance(doc.sections[1], TextSection)
    assert doc.sections[1].text == "sheet profile text"
    assert extraction_called is False


def test_convert_large_xlsx_under_row_limit_is_indexed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driveitem = DriveItemData(
        id="xlsx-2",
        name="reasonable.xlsx",
        web_url="https://example.sharepoint.com/sites/sample/reasonable.xlsx",
        size=5_000,
        mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        download_url=None,
        drive_id="drive-1",
    )

    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector.SHAREPOINT_XLSX_MAX_FILE_SIZE_FOR_INDEXING",
        1_000,
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector.SHAREPOINT_XLSX_MAX_ROWS_FOR_INDEXING",
        1_000,
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._download_via_graph_api",
        lambda *args, **kwargs: b"fake-xlsx-bytes",
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._count_non_empty_xlsx_rows",
        lambda *args, **kwargs: 500,
    )

    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector.extract_text_and_images",
        lambda *args, **kwargs: SimpleNamespace(text_content="sheet text"),
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._build_xlsx_profile_sections",
        lambda *args, **kwargs: [
            "Workbook: reasonable.xlsx\nWorkbook profile summary",
            "Workbook: reasonable.xlsx\nSheet: Sheet1\nSample rows: ...",
        ],
    )

    doc = _convert_driveitem_to_document_with_permissions(
        driveitem=driveitem,
        drive_name="Shared Documents",
        ctx=None,
        graph_client=object(),  # type: ignore[arg-type]
        graph_api_base="https://graph.microsoft.com/v1.0",
        include_permissions=False,
        parent_hierarchy_raw_node_id=None,
        access_token="token",
    )

    assert isinstance(doc, Document)
    assert doc.sections
    assert isinstance(doc.sections[0], TextSection)
    assert doc.sections[0].text == "Workbook: reasonable.xlsx\nSheet: Sheet1\nSample rows: ..."
    assert isinstance(doc.sections[1], TextSection)
    assert (
        doc.sections[1].text
        == "Workbook: reasonable.xlsx\nWorkbook profile summary\n\nsheet text"
    )


def test_convert_large_xlsx_profile_build_failure_is_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    driveitem = DriveItemData(
        id="xlsx-3",
        name="broken-large.xlsx",
        web_url="https://example.sharepoint.com/sites/sample/broken-large.xlsx",
        size=5_000,
        mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        download_url=None,
        drive_id="drive-1",
    )

    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector.SHAREPOINT_XLSX_MAX_FILE_SIZE_FOR_INDEXING",
        1_000,
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector.SHAREPOINT_XLSX_MAX_ROWS_FOR_INDEXING",
        1_000,
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._download_via_graph_api",
        lambda *args, **kwargs: b"fake-xlsx-bytes",
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._count_non_empty_xlsx_rows",
        lambda *args, **kwargs: 1_001,
    )
    monkeypatch.setattr(
        "onyx.connectors.sharepoint.connector._build_xlsx_profile_sections",
        lambda *args, **kwargs: None,
    )

    doc = _convert_driveitem_to_document_with_permissions(
        driveitem=driveitem,
        drive_name="Shared Documents",
        ctx=None,
        graph_client=object(),  # type: ignore[arg-type]
        graph_api_base="https://graph.microsoft.com/v1.0",
        include_permissions=False,
        parent_hierarchy_raw_node_id=None,
        access_token="token",
    )

    assert doc is None
