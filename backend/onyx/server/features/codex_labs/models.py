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


class DirectoryResponse(BaseModel):
    session_id: str
    path: str
    entries: list[FileEntry]


class PathResponse(BaseModel):
    session_id: str
    path: str


class DeletePathResponse(BaseModel):
    deleted: bool
