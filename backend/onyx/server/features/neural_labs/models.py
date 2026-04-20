from datetime import datetime

from pydantic import BaseModel


class WarmupResponse(BaseModel):
    home_dir: str
    terminal_id: str | None = None


class TerminalDescriptor(BaseModel):
    terminal_id: str


class TerminalListResponse(BaseModel):
    terminals: list[TerminalDescriptor]


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


class MovePathRequest(BaseModel):
    path: str
    destination_parent_path: str = ""
    new_name: str | None = None


class UpdateFileContentRequest(BaseModel):
    path: str
    content: str


class PathResponse(BaseModel):
    path: str


class DeletePathResponse(BaseModel):
    deleted: bool


class NeuraConfigResponse(BaseModel):
    assistant_name: str
    default_model: str


class NeuraConversationSummary(BaseModel):
    id: str
    title: str
    model_name: str
    created_at: datetime
    updated_at: datetime


class NeuraConversationListResponse(BaseModel):
    conversations: list[NeuraConversationSummary]


class NeuraMessage(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    created_at: datetime


class NeuraConversationResponse(BaseModel):
    conversation: NeuraConversationSummary
    messages: list[NeuraMessage]


class NeuraCreateConversationRequest(BaseModel):
    title: str | None = None


class NeuraSendMessageRequest(BaseModel):
    content: str
