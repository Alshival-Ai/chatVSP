from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
from datetime import timezone
from pathlib import Path
import sqlite3
from typing import Iterator
from typing import Sequence
from uuid import uuid4

from onyx.server.features.neural_labs.models import NeuraMessageAttachment
from onyx.server.features.neural_labs.models import NeuraConversationSummary
from onyx.server.features.neural_labs.models import NeuraMessage

NEURA_DIRECTORY_RELATIVE_PATH = ".neural-labs/neura"
NEURA_UPLOADS_RELATIVE_PATH = f"{NEURA_DIRECTORY_RELATIVE_PATH}/uploads"
NEURA_DB_FILENAME = "neura.db"
DEFAULT_NEURA_CONVERSATION_TITLE = "New Conversation"


def get_neura_db_path(home_dir: Path) -> Path:
    return home_dir / NEURA_DIRECTORY_RELATIVE_PATH / NEURA_DB_FILENAME


@contextmanager
def neura_connection(home_dir: Path) -> Iterator[sqlite3.Connection]:
    db_path = get_neura_db_path(home_dir)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        _ensure_schema(connection)
        yield connection
        connection.commit()
    finally:
        connection.close()


def list_conversations(home_dir: Path) -> list[NeuraConversationSummary]:
    with neura_connection(home_dir) as connection:
        rows = connection.execute(
            """
            SELECT id, title, model_name, created_at, updated_at
            FROM conversations
            ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
            """
        ).fetchall()
    return [_conversation_summary_from_row(row) for row in rows]


def create_conversation(
    home_dir: Path,
    *,
    model_name: str,
    title: str | None = None,
) -> NeuraConversationSummary:
    conversation_id = str(uuid4())
    now = _utc_now()
    resolved_title = (title or "").strip() or DEFAULT_NEURA_CONVERSATION_TITLE

    with neura_connection(home_dir) as connection:
        connection.execute(
            """
            INSERT INTO conversations (id, title, model_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (conversation_id, resolved_title, model_name, now, now),
        )
        row = connection.execute(
            """
            SELECT id, title, model_name, created_at, updated_at
            FROM conversations
            WHERE id = ?
            """,
            (conversation_id,),
        ).fetchone()

    if row is None:
        raise ValueError("Unable to create conversation")

    return _conversation_summary_from_row(row)


def get_conversation(
    home_dir: Path, conversation_id: str
) -> tuple[NeuraConversationSummary, list[NeuraMessage]]:
    with neura_connection(home_dir) as connection:
        conversation_row = connection.execute(
            """
            SELECT id, title, model_name, created_at, updated_at
            FROM conversations
            WHERE id = ?
            """,
            (conversation_id,),
        ).fetchone()
        if conversation_row is None:
            raise KeyError("Conversation not found")

        message_rows = connection.execute(
            """
            SELECT id, conversation_id, role, content, created_at
            FROM messages
            WHERE conversation_id = ?
            ORDER BY datetime(created_at) ASC, id ASC
            """,
            (conversation_id,),
        ).fetchall()
        message_ids = [str(row["id"]) for row in message_rows]
        attachment_rows = (
            connection.execute(
                f"""
                SELECT id, message_id, file_name, storage_path, mime_type, size
                FROM message_attachments
                WHERE message_id IN ({",".join(["?"] * len(message_ids))})
                ORDER BY id ASC
                """,
                message_ids,
            ).fetchall()
            if message_ids
            else []
        )

    attachments_by_message_id: dict[str, list[NeuraMessageAttachment]] = {}
    for row in attachment_rows:
        attachment = _attachment_from_row(row)
        attachments_by_message_id.setdefault(attachment.message_id, []).append(
            attachment
        )

    return (
        _conversation_summary_from_row(conversation_row),
        [
            _message_from_row(
                row,
                attachments=attachments_by_message_id.get(str(row["id"]), []),
            )
            for row in message_rows
        ],
    )


def delete_conversation(home_dir: Path, conversation_id: str) -> bool:
    with neura_connection(home_dir) as connection:
        result = connection.execute(
            "DELETE FROM conversations WHERE id = ?",
            (conversation_id,),
        )
    return result.rowcount > 0


def append_message(
    home_dir: Path,
    *,
    conversation_id: str,
    role: str,
    content: str,
    attachments: Sequence[dict[str, str | int | None]] | None = None,
) -> NeuraMessage:
    message_id = str(uuid4())
    now = _utc_now()

    with neura_connection(home_dir) as connection:
        _require_conversation(connection, conversation_id)
        connection.execute(
            """
            INSERT INTO messages (id, conversation_id, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (message_id, conversation_id, role, content, now),
        )
        normalized_attachments: list[dict[str, str | int | None]] = []
        for attachment in attachments or []:
            attachment_id = str(attachment.get("id") or uuid4())
            file_name = str(attachment.get("file_name") or "").strip()
            storage_path = str(attachment.get("storage_path") or "").strip()
            if not file_name or not storage_path:
                continue

            attachment_payload = {
                "id": attachment_id,
                "file_name": file_name,
                "storage_path": storage_path,
                "mime_type": attachment.get("mime_type"),
                "size": attachment.get("size"),
            }
            normalized_attachments.append(attachment_payload)
            connection.execute(
                """
                INSERT INTO message_attachments
                (id, message_id, file_name, storage_path, mime_type, size)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    attachment_id,
                    message_id,
                    file_name,
                    storage_path,
                    attachment.get("mime_type"),
                    attachment.get("size"),
                ),
            )
        connection.execute(
            "UPDATE conversations SET updated_at = ? WHERE id = ?",
            (now, conversation_id),
        )
        row = connection.execute(
            """
            SELECT id, conversation_id, role, content, created_at
            FROM messages
            WHERE id = ?
            """,
            (message_id,),
        ).fetchone()

    if row is None:
        raise ValueError("Unable to create message")

    return _message_from_row(
        row,
        attachments=[
            NeuraMessageAttachment(
                id=str(attachment["id"]),
                message_id=message_id,
                file_name=str(attachment["file_name"]),
                storage_path=str(attachment["storage_path"]),
                mime_type=(
                    str(attachment["mime_type"])
                    if attachment.get("mime_type") is not None
                    else None
                ),
                size=(
                    int(attachment["size"])
                    if attachment.get("size") is not None
                    else None
                ),
            )
            for attachment in normalized_attachments
        ],
    )


def maybe_update_title_from_first_user_message(
    home_dir: Path, *, conversation_id: str, content: str
) -> None:
    with neura_connection(home_dir) as connection:
        conversation_row = connection.execute(
            "SELECT title FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        if conversation_row is None:
            raise KeyError("Conversation not found")

        current_title = str(conversation_row["title"] or "").strip()
        if current_title != DEFAULT_NEURA_CONVERSATION_TITLE:
            return

        user_message_count = connection.execute(
            """
            SELECT COUNT(*) AS total
            FROM messages
            WHERE conversation_id = ? AND role = 'user'
            """,
            (conversation_id,),
        ).fetchone()
        if not user_message_count or int(user_message_count["total"] or 0) != 1:
            return

        next_title = _derive_title(content)
        now = _utc_now()
        connection.execute(
            "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
            (next_title, now, conversation_id),
        )


def _ensure_schema(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            model_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
        ON messages (conversation_id, created_at)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
        ON conversations (updated_at)
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS message_attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            file_name TEXT NOT NULL,
            storage_path TEXT NOT NULL,
            mime_type TEXT,
            size INTEGER
        )
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id
        ON message_attachments (message_id)
        """
    )


def _require_conversation(connection: sqlite3.Connection, conversation_id: str) -> None:
    row = connection.execute(
        "SELECT id FROM conversations WHERE id = ?",
        (conversation_id,),
    ).fetchone()
    if row is None:
        raise KeyError("Conversation not found")


def _conversation_summary_from_row(row: sqlite3.Row) -> NeuraConversationSummary:
    return NeuraConversationSummary(
        id=str(row["id"]),
        title=str(row["title"]),
        model_name=str(row["model_name"]),
        created_at=_parse_timestamp(str(row["created_at"])),
        updated_at=_parse_timestamp(str(row["updated_at"])),
    )


def _message_from_row(
    row: sqlite3.Row,
    *,
    attachments: list[NeuraMessageAttachment] | None = None,
) -> NeuraMessage:
    return NeuraMessage(
        id=str(row["id"]),
        conversation_id=str(row["conversation_id"]),
        role=str(row["role"]),
        content=str(row["content"]),
        created_at=_parse_timestamp(str(row["created_at"])),
        attachments=attachments or [],
    )


def _attachment_from_row(row: sqlite3.Row) -> NeuraMessageAttachment:
    return NeuraMessageAttachment(
        id=str(row["id"]),
        message_id=str(row["message_id"]),
        file_name=str(row["file_name"]),
        storage_path=str(row["storage_path"]),
        mime_type=str(row["mime_type"]) if row["mime_type"] is not None else None,
        size=int(row["size"]) if row["size"] is not None else None,
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _derive_title(content: str) -> str:
    single_line = " ".join(content.split())
    if not single_line:
        return DEFAULT_NEURA_CONVERSATION_TITLE
    if len(single_line) <= 48:
        return single_line
    return f"{single_line[:45].rstrip()}..."
