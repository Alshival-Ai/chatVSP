import base64
from enum import Enum
from typing import NotRequired
from typing_extensions import TypedDict  # noreorder

from pydantic import BaseModel


class ChatFileType(str, Enum):
    # Image types only contain the binary data
    IMAGE = "image"
    # Doc types are saved as both the binary, and the parsed text
    DOC = "document"
    # Plain text only contain the text
    PLAIN_TEXT = "plain_text"
    CSV = "csv"

    def is_text_file(self) -> bool:
        return self in (
            ChatFileType.PLAIN_TEXT,
            ChatFileType.DOC,
            ChatFileType.CSV,
        )


class FileDescriptor(TypedDict):
    """NOTE: is a `TypedDict` so it can be used as a type hint for a JSONB column
    in Postgres"""

    id: str
    type: ChatFileType
    name: NotRequired[str | None]
    user_file_id: NotRequired[str | None]
    is_chat_file: NotRequired[bool]


class InMemoryChatFile(BaseModel):
    file_id: str
    content: bytes
    file_type: ChatFileType
    filename: str | None = None
    user_file_id: str | None = None
    is_chat_file: bool = False

    def to_base64(self) -> str:
        return base64.b64encode(self.content).decode()

    def to_file_descriptor(self) -> FileDescriptor:
        return {
            "id": str(self.file_id),
            "type": self.file_type,
            "name": self.filename,
            "user_file_id": self.user_file_id,
            "is_chat_file": self.is_chat_file,
        }
