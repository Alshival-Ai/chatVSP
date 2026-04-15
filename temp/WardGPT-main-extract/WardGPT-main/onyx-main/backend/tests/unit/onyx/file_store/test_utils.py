from unittest.mock import MagicMock

from onyx.file_store.models import ChatFileType
from onyx.file_store.models import InMemoryChatFile
from onyx.file_store.utils import load_chat_file_by_id
from onyx.file_store.utils import verify_user_files


def test_load_chat_file_by_id_marks_descriptor_as_chat_file(monkeypatch) -> None:
    mock_store = MagicMock()
    mock_store.read_file_record.return_value = MagicMock(
        file_type="application/pdf",
        display_name="packet.pdf",
    )
    mock_store.read_file.return_value = MagicMock(read=lambda: b"pdf-bytes")

    monkeypatch.setattr(
        "onyx.file_store.utils.get_default_file_store",
        lambda: mock_store,
    )

    loaded = load_chat_file_by_id("chat-file-1")

    assert loaded.file_id == "chat-file-1"
    assert loaded.filename == "packet.pdf"
    assert loaded.file_type == ChatFileType.DOC
    assert loaded.user_file_id is None
    assert loaded.is_chat_file is True


def test_in_memory_chat_file_descriptor_preserves_chat_marker() -> None:
    descriptor = InMemoryChatFile(
        file_id="chat-file-1",
        content=b"pdf-bytes",
        file_type=ChatFileType.DOC,
        filename="packet.pdf",
        is_chat_file=True,
    ).to_file_descriptor()

    assert descriptor["id"] == "chat-file-1"
    assert descriptor["type"] == ChatFileType.DOC
    assert descriptor["name"] == "packet.pdf"
    assert descriptor["is_chat_file"] is True
    assert descriptor["user_file_id"] is None


def test_verify_user_files_accepts_chat_file_descriptors(monkeypatch) -> None:
    mock_store = MagicMock()
    mock_store.read_file_record.return_value = MagicMock()

    monkeypatch.setattr(
        "onyx.file_store.utils.get_default_file_store",
        lambda: mock_store,
    )

    verify_user_files(
        user_files=[
            {
                "id": "chat-file-1",
                "type": ChatFileType.DOC,
                "name": "packet.pdf",
                "is_chat_file": True,
            }
        ],
        user_id=None,
        db_session=MagicMock(),
        project_id=None,
    )

    mock_store.read_file_record.assert_called_once_with("chat-file-1")
