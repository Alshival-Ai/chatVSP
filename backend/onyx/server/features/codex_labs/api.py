from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import Response
from fastapi import UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from onyx.auth.users import current_user
from onyx.db.engine.sql_engine import get_session
from onyx.db.models import User
from onyx.server.features.build.configs import ENABLE_CODEX_LABS
from onyx.server.features.build.utils import sanitize_filename
from onyx.server.features.codex_labs.manager import CodexLabsSessionManager
from onyx.server.features.codex_labs.models import CreateDirectoryRequest
from onyx.server.features.codex_labs.models import DeletePathResponse
from onyx.server.features.codex_labs.models import DirectoryResponse
from onyx.server.features.codex_labs.models import FileEntry
from onyx.server.features.codex_labs.models import MovePathRequest
from onyx.server.features.codex_labs.models import PathResponse
from onyx.server.features.codex_labs.models import RenamePathRequest
from onyx.server.features.codex_labs.models import UpdateFileContentRequest
from onyx.server.features.codex_labs.models import WarmupResponse


def require_codex_labs_enabled(user: User = Depends(current_user)) -> User:
    if not ENABLE_CODEX_LABS or not user.enable_codex_labs:
        raise HTTPException(status_code=403, detail="Codex Labs is not available")
    return user


router = APIRouter(
    prefix="/codex-labs",
    dependencies=[Depends(require_codex_labs_enabled)],
    tags=["codex-labs"],
)


def _get_manager(db_session: Session) -> CodexLabsSessionManager:
    return CodexLabsSessionManager(db_session)


@router.post("/warmup", response_model=WarmupResponse)
def warmup(
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> WarmupResponse:
    manager = _get_manager(db_session)
    session = manager.ensure_workspace_session(user)
    return WarmupResponse(session_id=session.id, path=session.path)


@router.get("/files", response_model=DirectoryResponse)
def list_files(
    path: str = "",
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> DirectoryResponse:
    manager = _get_manager(db_session)
    session = manager.ensure_workspace_session(user)
    try:
        listing = manager.list_directory(
            workspace_root=session.root,
            path=path,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return DirectoryResponse(
        session_id=session.id,
        path=listing.path,
        entries=[
            FileEntry(
                name=entry.name,
                path=entry.path,
                is_directory=entry.is_directory,
                mime_type=entry.mime_type,
                size=entry.size,
                modified_at=entry.modified_at,
            )
            for entry in listing.entries
        ],
    )


@router.get("/files/content")
def get_file_content(
    path: str,
    download: bool = False,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> Response:
    manager = _get_manager(db_session)
    session = manager.ensure_workspace_session(user)
    try:
        content, mime_type, filename = manager.read_file(
            workspace_root=session.root,
            path=path,
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="File not found")

    if download:
        return StreamingResponse(
            iter([content]),
            media_type=mime_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return StreamingResponse(
        iter([content]),
        media_type=mime_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.post("/files/upload", response_model=PathResponse)
async def upload_file(
    file: UploadFile = File(...),
    path: str = Form(default="", alias="_path"),
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    session = manager.ensure_workspace_session(user)

    safe_filename = sanitize_filename(file.filename or "upload.bin")
    content = await file.read()

    try:
        relative_path, _size = manager.upload_file(
            workspace_root=session.root,
            filename=safe_filename,
            content=content,
            parent_path=path,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(session_id=session.id, path=relative_path)


@router.post("/directories", response_model=PathResponse)
def create_directory(
    request: CreateDirectoryRequest,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    session = manager.ensure_workspace_session(user)
    try:
        relative_path = manager.create_directory(
            workspace_root=session.root,
            parent_path=request.parent_path,
            name=sanitize_filename(request.name),
        )
    except FileExistsError:
        raise HTTPException(status_code=409, detail="Directory already exists")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(session_id=session.id, path=relative_path)


@router.patch("/files/rename", response_model=PathResponse)
def rename_path(
    request: RenamePathRequest,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    session = manager.ensure_workspace_session(user)
    try:
        relative_path = manager.rename_path(
            workspace_root=session.root,
            path=request.path,
            new_name=sanitize_filename(request.new_name),
        )
    except ValueError as e:
        if "already exists" in str(e).lower():
            raise HTTPException(status_code=409, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(session_id=session.id, path=relative_path)


@router.patch("/files/move", response_model=PathResponse)
def move_path(
    request: MovePathRequest,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    session = manager.ensure_workspace_session(user)
    try:
        relative_path = manager.move_path(
            workspace_root=session.root,
            path=request.path,
            destination_parent_path=request.destination_parent_path,
            new_name=sanitize_filename(request.new_name) if request.new_name else None,
        )
    except ValueError as e:
        if "already exists" in str(e).lower():
            raise HTTPException(status_code=409, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(session_id=session.id, path=relative_path)


@router.put("/files/content", response_model=PathResponse)
def update_file_content(
    request: UpdateFileContentRequest,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    session = manager.ensure_workspace_session(user)
    try:
        relative_path = manager.update_text_file(
            workspace_root=session.root,
            path=request.path,
            content=request.content,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(session_id=session.id, path=relative_path)


@router.delete("/files", response_model=DeletePathResponse)
def delete_file(
    path: str,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> DeletePathResponse:
    manager = _get_manager(db_session)
    session = manager.ensure_workspace_session(user)
    try:
        deleted = manager.delete_file(
            workspace_root=session.root,
            path=path,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return DeletePathResponse(deleted=deleted)
