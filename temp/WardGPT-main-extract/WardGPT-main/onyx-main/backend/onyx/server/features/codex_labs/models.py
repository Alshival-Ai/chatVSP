from datetime import datetime

from pydantic import BaseModel


class WarmupResponse(BaseModel):
    home_dir: str
    terminal_id: str | None = None


class TerminalSessionResponse(BaseModel):
    started: bool
    terminal_id: str


class TerminalInputRequest(BaseModel):
    terminal_id: str
    data: str


class TerminalResizeRequest(BaseModel):
    terminal_id: str
    cols: int
    rows: int


class TerminalDescriptor(BaseModel):
    terminal_id: str


class TerminalListResponse(BaseModel):
    terminals: list[TerminalDescriptor]


class TerminalStatusResponse(BaseModel):
    terminal_id: str
    state: str
    alive: bool
    created_at_epoch: float
    first_output_at_epoch: float | None = None
    last_activity_epoch: float
    has_output: bool


class TerminalWebSocketTokenRequest(BaseModel):
    terminal_id: str


class TerminalWebSocketTokenResponse(BaseModel):
    token: str
    ws_path: str


class FileEntry(BaseModel):
    name: str
    path: str
    is_directory: bool
    mime_type: str | None = None
    size: int | None = None
    modified_at: datetime | None = None


class DirectoryResponse(BaseModel):
    path: str
    entries: list[FileEntry]


class CreateDirectoryRequest(BaseModel):
    parent_path: str = ""
    name: str


class RenamePathRequest(BaseModel):
    path: str
    new_name: str


class UpdateFileContentRequest(BaseModel):
    path: str
    content: str


class MovePathRequest(BaseModel):
    path: str
    destination_parent_path: str = ""
    new_name: str | None = None


class PathResponse(BaseModel):
    path: str


class DeletePathResponse(BaseModel):
    deleted: bool
