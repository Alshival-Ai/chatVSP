import asyncio
import json
import secrets
from pathlib import Path

from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import Response
from fastapi import UploadFile
from fastapi import WebSocket
from fastapi import WebSocketDisconnect
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from onyx.auth.users import current_user
from onyx.auth.users import current_user_from_websocket
from onyx.db.engine.sql_engine import get_session
from onyx.db.models import User
from onyx.server.features.build.configs import ENABLE_NEURAL_LABS
from onyx.server.features.build.utils import sanitize_filename
from onyx.server.features.neural_labs.manager import NeuralLabsSessionManager
from onyx.server.features.neural_labs.manager import get_neural_labs_manager
from onyx.server.features.neural_labs.manager import Subscriber
from onyx.server.features.neural_labs.models import CreateDirectoryRequest
from onyx.server.features.neural_labs.models import DeletePathResponse
from onyx.server.features.neural_labs.models import DirectoryResponse
from onyx.server.features.neural_labs.models import FileEntry
from onyx.server.features.neural_labs.models import MovePathRequest
from onyx.server.features.neural_labs.models import PathResponse
from onyx.server.features.neural_labs.models import RenamePathRequest
from onyx.server.features.neural_labs.models import TerminalDescriptor
from onyx.server.features.neural_labs.models import TerminalInputRequest
from onyx.server.features.neural_labs.models import TerminalListResponse
from onyx.server.features.neural_labs.models import TerminalResizeRequest
from onyx.server.features.neural_labs.models import TerminalSessionResponse
from onyx.server.features.neural_labs.models import TerminalStatusResponse
from onyx.server.features.neural_labs.models import TerminalWebSocketTokenRequest
from onyx.server.features.neural_labs.models import TerminalWebSocketTokenResponse
from onyx.server.features.neural_labs.models import UpdateFileContentRequest
from onyx.server.features.neural_labs.models import WarmupResponse
from onyx.server.features.neural_labs.provisioning import provision_neural_labs_home
from onyx.redis.redis_pool import store_ws_token
from onyx.redis.redis_pool import WsTokenRateLimitExceeded
from shared_configs.contextvars import get_current_tenant_id


def require_neural_labs_enabled(user: User = Depends(current_user)) -> User:
    if not ENABLE_NEURAL_LABS or not user.enable_neural_labs:
        raise HTTPException(status_code=403, detail="Neural Labs is not available")
    return user


router = APIRouter(
    prefix="/neural-labs",
    dependencies=[Depends(require_neural_labs_enabled)],
    tags=["neural-labs"],
)
ws_router = APIRouter(prefix="/neural-labs")


def _get_manager(db_session: Session) -> NeuralLabsSessionManager:
    return NeuralLabsSessionManager(db_session)


def _workspace_for_user(
    manager: NeuralLabsSessionManager, user: User
) -> tuple[str, Path]:
    session = manager.ensure_workspace_session(user)
    return get_current_tenant_id(), session.root


@router.post("/warmup", response_model=WarmupResponse)
def warmup(
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> WarmupResponse:
    manager = _get_manager(db_session)
    tenant_id, workspace_root = _workspace_for_user(manager, user)
    env_overrides = provision_neural_labs_home(
        home_dir=workspace_root, db_session=db_session
    )
    terminal_id, _session = get_neural_labs_manager().ensure_default_session(
        tenant_id=tenant_id,
        user_id=user.id,
        home_dir=workspace_root,
        env_overrides=env_overrides,
    )
    return WarmupResponse(home_dir=str(workspace_root), terminal_id=terminal_id)


@router.get("/terminals", response_model=TerminalListResponse)
def list_terminals(user: User = Depends(current_user)) -> TerminalListResponse:
    manager = get_neural_labs_manager()
    tenant_id = get_current_tenant_id()
    sessions = manager.list_sessions(tenant_id=tenant_id, user_id=user.id)
    return TerminalListResponse(
        terminals=[TerminalDescriptor(terminal_id=terminal_id) for terminal_id, _ in sessions]
    )


@router.post("/terminals", response_model=TerminalDescriptor)
def create_terminal(
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> TerminalDescriptor:
    manager = _get_manager(db_session)
    tenant_id, workspace_root = _workspace_for_user(manager, user)
    env_overrides = provision_neural_labs_home(
        home_dir=workspace_root, db_session=db_session
    )
    try:
        terminal_id, _session = get_neural_labs_manager().create_session(
            tenant_id=tenant_id,
            user_id=user.id,
            home_dir=workspace_root,
            env_overrides=env_overrides,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return TerminalDescriptor(terminal_id=terminal_id)


@router.delete("/terminals/{terminal_id}")
def close_terminal_by_id(
    terminal_id: str,
    user: User = Depends(current_user),
) -> Response:
    tenant_id = get_current_tenant_id()
    get_neural_labs_manager().close_session(
        tenant_id=tenant_id,
        user_id=user.id,
        terminal_id=terminal_id,
    )
    return Response(status_code=204)


@router.get("/terminal/status", response_model=TerminalStatusResponse)
def get_terminal_status(
    terminal_id: str,
    user: User = Depends(current_user),
) -> TerminalStatusResponse:
    tenant_id = get_current_tenant_id()
    session = get_neural_labs_manager().get_session(
        tenant_id=tenant_id,
        user_id=user.id,
        terminal_id=terminal_id,
    )
    if not session:
        raise HTTPException(status_code=404, detail="Terminal session not found")

    return TerminalStatusResponse(
        terminal_id=terminal_id,
        state=session.state,
        alive=session.alive,
        created_at_epoch=session.created_at,
        first_output_at_epoch=session.first_output_at,
        last_activity_epoch=session.last_activity,
        has_output=session.has_output,
    )


@router.post("/terminal/ws-token", response_model=TerminalWebSocketTokenResponse)
async def create_terminal_ws_token(
    request: TerminalWebSocketTokenRequest,
    user: User = Depends(current_user),
) -> TerminalWebSocketTokenResponse:
    tenant_id = get_current_tenant_id()
    try:
        terminal_ticket = get_neural_labs_manager().issue_ws_ticket(
            tenant_id=tenant_id,
            user_id=user.id,
            terminal_id=request.terminal_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Terminal session not found")

    auth_token = secrets.token_urlsafe(32)
    try:
        await store_ws_token(auth_token, str(user.id))
    except WsTokenRateLimitExceeded:
        raise HTTPException(
            status_code=429,
            detail="Too many token requests. Please retry in a moment.",
        )

    return TerminalWebSocketTokenResponse(
        token=terminal_ticket,
        ws_path=(
            "/api/neural-labs/terminal/ws"
            f"?token={auth_token}&terminal_token={terminal_ticket}"
        ),
    )


def _handle_ws_control_message(message: str, session: object) -> bool:
    if not message or not message.startswith("{"):
        return False

    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        return False

    if payload.get("type") != "resize":
        return False

    try:
        cols = int(payload.get("cols") or 0)
        rows = int(payload.get("rows") or 0)
    except (TypeError, ValueError):
        return True

    if cols > 0 and rows > 0:
        session.resize(cols=cols, rows=rows)
    return True


@ws_router.websocket("/terminal/ws")
async def stream_terminal_ws(
    websocket: WebSocket,
    terminal_token: str,
    _user: User = Depends(current_user_from_websocket),
) -> None:
    manager = get_neural_labs_manager()
    ticket = manager.consume_ws_ticket(terminal_token)
    if ticket is None:
        await websocket.close(code=4403, reason="Invalid terminal stream token")
        return

    tenant_id, user_id, terminal_id = ticket
    if user_id != _user.id or tenant_id != get_current_tenant_id():
        await websocket.close(code=4403, reason="Terminal stream token mismatch")
        return
    session = manager.get_session(
        tenant_id=tenant_id,
        user_id=user_id,
        terminal_id=terminal_id,
    )
    if not session:
        await websocket.close(code=4404, reason="Terminal session not found")
        return

    await websocket.accept()

    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=512)
    subscriber = Subscriber(queue=queue, loop=asyncio.get_running_loop())
    session.add_subscriber(subscriber)
    if not session.has_output:
        try:
            session.write_input("\n")
        except Exception:
            pass

    async def sender() -> None:
        while True:
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=15.0)
            except asyncio.TimeoutError:
                await websocket.send_text(
                    json.dumps({"type": "status", "message": "keepalive"})
                )
                continue

            await websocket.send_text(json.dumps(payload))
            if payload.get("type") == "exit":
                break

    send_task = asyncio.create_task(sender())
    try:
        while True:
            message = await websocket.receive()
            message_type = message.get("type")
            if message_type == "websocket.disconnect":
                break

            text_payload = message.get("text")
            if isinstance(text_payload, str):
                if _handle_ws_control_message(text_payload, session):
                    continue
                session.write_input(text_payload)
                continue

            bytes_payload = message.get("bytes")
            if isinstance(bytes_payload, (bytes, bytearray)):
                decoded_payload = bytes(bytes_payload).decode("utf-8", errors="ignore")
                if decoded_payload:
                    session.write_input(decoded_payload)
    except WebSocketDisconnect:
        pass
    finally:
        send_task.cancel()
        try:
            await send_task
        except Exception:
            pass
        session.remove_subscriber(subscriber)


@router.post("/terminal/input")
def send_terminal_input(
    request: TerminalInputRequest,
    user: User = Depends(current_user),
) -> Response:
    if len(request.data) > 65536:
        raise HTTPException(status_code=400, detail="Input payload too large")

    tenant_id = get_current_tenant_id()
    session = get_neural_labs_manager().get_session(
        tenant_id=tenant_id,
        user_id=user.id,
        terminal_id=request.terminal_id,
    )
    if not session:
        raise HTTPException(status_code=404, detail="Terminal session not found")
    session.write_input(request.data)
    return Response(status_code=204)


@router.post("/terminal/resize")
def resize_terminal(
    request: TerminalResizeRequest,
    user: User = Depends(current_user),
) -> Response:
    tenant_id = get_current_tenant_id()
    session = get_neural_labs_manager().get_session(
        tenant_id=tenant_id,
        user_id=user.id,
        terminal_id=request.terminal_id,
    )
    if not session:
        raise HTTPException(status_code=404, detail="Terminal session not found")
    session.resize(cols=request.cols, rows=request.rows)
    return Response(status_code=204)


@router.get("/files", response_model=DirectoryResponse)
def list_files(
    path: str = "",
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> DirectoryResponse:
    manager = _get_manager(db_session)
    _tenant_id, workspace_root = _workspace_for_user(manager, user)
    try:
        listing = manager.list_directory(workspace_root=workspace_root, path=path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return DirectoryResponse(
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
    _tenant_id, workspace_root = _workspace_for_user(manager, user)
    try:
        content, mime_type, filename = manager.read_file(
            workspace_root=workspace_root,
            path=path,
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="File not found")

    disposition = "attachment" if download else "inline"
    return StreamingResponse(
        iter([content]),
        media_type=mime_type,
        headers={"Content-Disposition": f'{disposition}; filename="{filename}"'},
    )


@router.post("/files/upload", response_model=PathResponse)
async def upload_file(
    file: UploadFile = File(...),
    path: str = Form(default="", alias="_path"),
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    _tenant_id, workspace_root = _workspace_for_user(manager, user)

    safe_filename = sanitize_filename(file.filename or "upload.bin")
    content = await file.read()

    try:
        relative_path, _size = manager.upload_file(
            workspace_root=workspace_root,
            filename=safe_filename,
            content=content,
            parent_path=path,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(path=relative_path)


@router.post("/directories", response_model=PathResponse)
def create_directory(
    request: CreateDirectoryRequest,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    _tenant_id, workspace_root = _workspace_for_user(manager, user)
    try:
        relative_path = manager.create_directory(
            workspace_root=workspace_root,
            parent_path=request.parent_path,
            name=sanitize_filename(request.name),
        )
    except FileExistsError:
        raise HTTPException(status_code=409, detail="Directory already exists")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(path=relative_path)


@router.patch("/files/rename", response_model=PathResponse)
def rename_path(
    request: RenamePathRequest,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    _tenant_id, workspace_root = _workspace_for_user(manager, user)
    try:
        relative_path = manager.rename_path(
            workspace_root=workspace_root,
            path=request.path,
            new_name=sanitize_filename(request.new_name),
        )
    except ValueError as e:
        if "already exists" in str(e).lower():
            raise HTTPException(status_code=409, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(path=relative_path)


@router.patch("/files/move", response_model=PathResponse)
def move_path(
    request: MovePathRequest,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    _tenant_id, workspace_root = _workspace_for_user(manager, user)
    try:
        relative_path = manager.move_path(
            workspace_root=workspace_root,
            path=request.path,
            destination_parent_path=request.destination_parent_path,
            new_name=sanitize_filename(request.new_name) if request.new_name else None,
        )
    except ValueError as e:
        if "already exists" in str(e).lower():
            raise HTTPException(status_code=409, detail=str(e))
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(path=relative_path)


@router.put("/files/content", response_model=PathResponse)
def update_file_content(
    request: UpdateFileContentRequest,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> PathResponse:
    manager = _get_manager(db_session)
    _tenant_id, workspace_root = _workspace_for_user(manager, user)
    try:
        relative_path = manager.update_text_file(
            workspace_root=workspace_root,
            path=request.path,
            content=request.content,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return PathResponse(path=relative_path)


@router.delete("/files", response_model=DeletePathResponse)
def delete_file(
    path: str,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> DeletePathResponse:
    manager = _get_manager(db_session)
    _tenant_id, workspace_root = _workspace_for_user(manager, user)
    try:
        deleted = manager.delete_file(workspace_root=workspace_root, path=path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return DeletePathResponse(deleted=deleted)
