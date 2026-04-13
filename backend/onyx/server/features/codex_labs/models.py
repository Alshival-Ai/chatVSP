from datetime import datetime

from pydantic import BaseModel


class WarmupResponse(BaseModel):
    session_id: str
    path: str = ""


class FileEntry(BaseModel):
    name: str
    path: str
    is_directory: bool
    mime_type: str | None = None
    size: int | None = None
    modified_at: datetime | None = None


class DirectoryResponse(BaseModel):
    session_id: str
    path: str
    entries: list[FileEntry]


class CreateDirectoryRequest(BaseModel):
    parent_path: str = ""
    name: str


class RenamePathRequest(BaseModel):
    path: str
    new_name: str


class MovePathRequest(BaseModel):
    path: str
    destination_parent_path: str = ""
    new_name: str | None = None


class UpdateFileContentRequest(BaseModel):
    path: str
    content: str


class PathResponse(BaseModel):
    session_id: str
    path: str


class DeletePathResponse(BaseModel):
    deleted: bool
