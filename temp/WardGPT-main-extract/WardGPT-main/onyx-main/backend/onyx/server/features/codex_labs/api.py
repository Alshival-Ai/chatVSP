import asyncio
import json
import mimetypes
import shutil
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import AsyncGenerator
from typing import Any

from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import Request
from fastapi import Response
from fastapi import UploadFile
from fastapi import WebSocket
from fastapi import WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse
from sqlalchemy import or_
from sqlalchemy import select
from sqlalchemy.orm import Session

from onyx.auth.pat import hash_pat
from onyx.auth.users import current_user
from onyx.db.engine.sql_engine import get_session
from onyx.db.models import PersonalAccessToken
from onyx.db.models import User
from onyx.db.pat import create_pat
from onyx.error_handling.error_codes import OnyxErrorCode
from onyx.error_handling.exceptions import OnyxError
from onyx.server.features.build.configs import ENABLE_CODEX_LABS
from onyx.server.features.codex_labs.manager import get_codex_labs_manager
from onyx.server.features.codex_labs.manager import Subscriber
from onyx.server.features.codex_labs.models import CreateDirectoryRequest
from onyx.server.features.codex_labs.models import DeletePathResponse
from onyx.server.features.codex_labs.models import DirectoryResponse
from onyx.server.features.codex_labs.models import FileEntry
from onyx.server.features.codex_labs.models import MovePathRequest
from onyx.server.features.codex_labs.models import PathResponse
from onyx.server.features.codex_labs.models import RenamePathRequest
from onyx.server.features.codex_labs.models import TerminalDescriptor
from onyx.server.features.codex_labs.models import TerminalInputRequest
from onyx.server.features.codex_labs.models import TerminalListResponse
from onyx.server.features.codex_labs.models import TerminalResizeRequest
from onyx.server.features.codex_labs.models import TerminalSessionResponse
from onyx.server.features.codex_labs.models import TerminalStatusResponse
from onyx.server.features.codex_labs.models import TerminalWebSocketTokenRequest
from onyx.server.features.codex_labs.models import TerminalWebSocketTokenResponse
from onyx.server.features.codex_labs.models import UpdateFileContentRequest
from onyx.server.features.codex_labs.models import WarmupResponse
from onyx.server.features.codex_labs.provisioning import (
    CODEX_WARDGPT_MCP_BEARER_TOKEN_ENV_VAR,
)
from onyx.server.features.codex_labs.provisioning import provision_codex_home
from shared_configs.contextvars import get_current_tenant_id

CODEX_LABS_MCP_PAT_NAME = "codex-labs-mcp"
CODEX_LABS_MCP_PAT_FILE_RELATIVE_PATH = ".wardGPT/mcp_pat.token"


def require_codex_labs_enabled(user: User = Depends(current_user)) -> User:
    if not ENABLE_CODEX_LABS or not user.enable_codex_labs:
        raise OnyxError(
            OnyxErrorCode.INSUFFICIENT_PERMISSIONS, "Codex Labs is not available"
        )
    return user


router = APIRouter(prefix="/codex-labs", dependencies=[Depends(require_codex_labs_enabled)])
ws_router = APIRouter(prefix="/codex-labs")


def _resolve_user_path(home_dir: Path, relative_path: str) -> Path:
    rel = (relative_path or "").strip().lstrip("/")
    root = home_dir.resolve()
    target = (root / rel).resolve()

    if target != root and root not in target.parents:
        raise OnyxError(OnyxErrorCode.UNAUTHORIZED, "Access denied")

    return target


def _relative_path(home_dir: Path, target: Path) -> str:
    root = home_dir.resolve()
    resolved = target.resolve()
    if resolved == root:
        return ""
    if root not in resolved.parents:
        raise OnyxError(OnyxErrorCode.UNAUTHORIZED, "Access denied")
    return str(resolved.relative_to(root))


def _ensure_not_home_root(home_dir: Path, target: Path) -> None:
    if target.resolve() == home_dir.resolve():
        raise OnyxError(OnyxErrorCode.INVALID_INPUT, "Cannot modify home root")


def _guess_mime_type(target: Path) -> str | None:
    mime_type, _ = mimetypes.guess_type(str(target))
    return mime_type


def _get_or_create_default_session(
    tenant_id: str, user: User, db_session: Session, request: Request
):
    manager = get_codex_labs_manager()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    env_overrides = provision_codex_home(home_dir=home_dir, db_session=db_session)
    _inject_request_bearer_token_env_override(
        request=request,
        env_overrides=env_overrides,
        user=user,
        db_session=db_session,
        home_dir=home_dir,
    )

    desired_mcp_token = env_overrides.get(CODEX_WARDGPT_MCP_BEARER_TOKEN_ENV_VAR, "")
    if desired_mcp_token:
        for terminal_id, session in manager.list_sessions(
            tenant_id=tenant_id, user_id=user.id
        ):
            current_token = session.env_overrides.get(
                CODEX_WARDGPT_MCP_BEARER_TOKEN_ENV_VAR, ""
            )
            # Existing sessions keep startup env; recycle stale-token sessions so
            # path-based MCP tools can access the correct user-scoped codex-labs files.
            if current_token != desired_mcp_token:
                manager.close_session(
                    tenant_id=tenant_id,
                    user_id=user.id,
                    terminal_id=terminal_id,
                )
    return manager.ensure_default_session(
        tenant_id=tenant_id,
        user_id=user.id,
        home_dir=home_dir,
        env_overrides=env_overrides,
    )


def _inject_request_bearer_token_env_override(
    *,
    request: Request,
    env_overrides: dict[str, str],
    user: User,
    db_session: Session,
    home_dir: Path,
) -> None:
    """Prefer user bearer token for MCP calls from Codex Labs shell sessions.

    Using the caller's token allows path-based codex-labs file endpoints
    (which are user-scoped) to authorize correctly from MCP tools.
    """
    token = _extract_bearer_token_from_request(request=request)
    if not token:
        token = _get_or_create_codex_labs_pat_token(
            user=user, db_session=db_session, home_dir=home_dir
        )
    if token:
        env_overrides[CODEX_WARDGPT_MCP_BEARER_TOKEN_ENV_VAR] = token


def _extract_bearer_token_from_request(*, request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    if not authorization:
        return ""

    prefix = "bearer "
    if not authorization.lower().startswith(prefix):
        return ""
    return authorization[len(prefix) :].strip()


def _is_valid_pat_for_user(*, token: str, user: User, db_session: Session) -> bool:
    hashed_token = hash_pat(token)
    now = datetime.now(timezone.utc)
    existing = db_session.scalar(
        select(PersonalAccessToken)
        .where(PersonalAccessToken.user_id == user.id)
        .where(PersonalAccessToken.hashed_token == hashed_token)
        .where(PersonalAccessToken.is_revoked.is_(False))
        .where(
            or_(
                PersonalAccessToken.expires_at.is_(None),
                PersonalAccessToken.expires_at > now,
            )
        )
    )
    return existing is not None


def _get_or_create_codex_labs_pat_token(
    *,
    user: User,
    db_session: Session,
    home_dir: Path,
) -> str:
    token_path = home_dir / CODEX_LABS_MCP_PAT_FILE_RELATIVE_PATH

    # Reuse a previously provisioned token when it still maps to this user.
    try:
        existing_token = token_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        existing_token = ""
    if existing_token and _is_valid_pat_for_user(
        token=existing_token, user=user, db_session=db_session
    ):
        return existing_token

    _, raw_token = create_pat(
        db_session=db_session,
        user_id=user.id,
        name=CODEX_LABS_MCP_PAT_NAME,
        expiration_days=None,
    )

    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(raw_token, encoding="utf-8")
    try:
        token_path.chmod(0o600)
    except OSError:
        # Non-fatal (e.g., unsupported chmod semantics on some filesystems)
        pass
    return raw_token


@router.post("/warmup")
def warmup(
    request: Request,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> WarmupResponse:
    tenant_id = get_current_tenant_id()
    terminal_id, session = _get_or_create_default_session(
        tenant_id=tenant_id, user=user, db_session=db_session, request=request
    )
    return WarmupResponse(home_dir=str(session.home_dir), terminal_id=terminal_id)


@router.get("/terminals")
def list_terminals(user: User = Depends(current_user)) -> TerminalListResponse:
    tenant_id = get_current_tenant_id()
    manager = get_codex_labs_manager()
    sessions = manager.list_sessions(tenant_id=tenant_id, user_id=user.id)
    terminals = [
        TerminalDescriptor(terminal_id=terminal_id) for terminal_id, _ in sessions
    ]
    return TerminalListResponse(terminals=terminals)


@router.post("/terminals")
def create_terminal(
    request: Request,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> TerminalDescriptor:
    tenant_id = get_current_tenant_id()
    manager = get_codex_labs_manager()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    env_overrides = provision_codex_home(home_dir=home_dir, db_session=db_session)
    _inject_request_bearer_token_env_override(
        request=request,
        env_overrides=env_overrides,
        user=user,
        db_session=db_session,
        home_dir=home_dir,
    )
    try:
        terminal_id, _ = manager.create_session(
            tenant_id=tenant_id,
            user_id=user.id,
            home_dir=home_dir,
            env_overrides=env_overrides,
        )
    except ValueError as e:
        raise OnyxError(OnyxErrorCode.INVALID_INPUT, str(e))

    return TerminalDescriptor(terminal_id=terminal_id)


@router.delete("/terminals/{terminal_id}")
def close_terminal_by_id(
    terminal_id: str,
    user: User = Depends(current_user),
) -> Response:
    tenant_id = get_current_tenant_id()
    manager = get_codex_labs_manager()
    manager.close_session(tenant_id=tenant_id, user_id=user.id, terminal_id=terminal_id)
    return Response(status_code=204)


@router.post("/terminal/session")
def ensure_terminal_session(
    request: Request,
    user: User = Depends(current_user),
    db_session: Session = Depends(get_session),
) -> TerminalSessionResponse:
    tenant_id = get_current_tenant_id()
    terminal_id, _ = _get_or_create_default_session(
        tenant_id=tenant_id, user=user, db_session=db_session, request=request
    )
    return TerminalSessionResponse(started=True, terminal_id=terminal_id)


@router.get("/terminal/status")
def get_terminal_status(
    terminal_id: str,
    user: User = Depends(current_user),
) -> TerminalStatusResponse:
    tenant_id = get_current_tenant_id()
    manager = get_codex_labs_manager()
    session = manager.get_session(
        tenant_id=tenant_id, user_id=user.id, terminal_id=terminal_id
    )
    if not session:
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Terminal session not found")

    return TerminalStatusResponse(
        terminal_id=terminal_id,
        state=session.state,
        alive=session.alive,
        created_at_epoch=session.created_at,
        first_output_at_epoch=session.first_output_at,
        last_activity_epoch=session.last_activity,
        has_output=session.has_output,
    )


@router.post("/terminal/ws-token")
def create_terminal_ws_token(
    request: TerminalWebSocketTokenRequest,
    user: User = Depends(current_user),
) -> TerminalWebSocketTokenResponse:
    tenant_id = get_current_tenant_id()
    manager = get_codex_labs_manager()
    try:
        token = manager.issue_ws_ticket(
            tenant_id=tenant_id,
            user_id=user.id,
            terminal_id=request.terminal_id,
        )
    except KeyError:
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Terminal session not found")

    return TerminalWebSocketTokenResponse(
        token=token,
        ws_path=f"/ws/codex-labs/terminal?token={token}",
    )


def _handle_ws_control_message(message: str, session: Any) -> bool:
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
    token: str,
) -> None:
    manager = get_codex_labs_manager()
    ticket = manager.consume_ws_ticket(token)
    if ticket is None:
        await websocket.close(code=4403, reason="Invalid terminal stream token")
        return

    tenant_id, user_id, terminal_id = ticket
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
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        session.remove_subscriber(subscriber)


@router.get("/terminal/stream")
async def stream_terminal(
    request: Request,
    terminal_id: str,
    user: User = Depends(current_user),
) -> StreamingResponse:
    tenant_id = get_current_tenant_id()
    manager = get_codex_labs_manager()
    session = manager.get_session(
        tenant_id=tenant_id, user_id=user.id, terminal_id=terminal_id
    )
    if not session:
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Terminal session not found")

    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=512)
    subscriber = Subscriber(queue=queue, loop=asyncio.get_running_loop())
    session.add_subscriber(subscriber)
    if not session.has_output:
        try:
            # Force prompt emission only when there is no replayable output yet.
            session.write_input("\n")
        except Exception:
            pass

    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            yield f"data: {json.dumps({'type': 'status', 'message': 'connected'})}\n\n"
            while True:
                if await request.is_disconnected():
                    break

                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue

                yield f"data: {json.dumps(payload)}\n\n"

                if payload.get("type") == "exit":
                    break
        finally:
            session.remove_subscriber(subscriber)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/terminal/input")
def send_terminal_input(
    request: TerminalInputRequest,
    user: User = Depends(current_user),
) -> Response:
    if len(request.data) > 65536:
        raise OnyxError(OnyxErrorCode.INVALID_INPUT, "Input payload too large")

    tenant_id = get_current_tenant_id()
    manager = get_codex_labs_manager()
    session = manager.get_session(
        tenant_id=tenant_id, user_id=user.id, terminal_id=request.terminal_id
    )
    if not session:
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Terminal session not found")
    session.write_input(request.data)
    return Response(status_code=204)


@router.post("/terminal/resize")
def resize_terminal(
    request: TerminalResizeRequest,
    user: User = Depends(current_user),
) -> Response:
    tenant_id = get_current_tenant_id()
    manager = get_codex_labs_manager()
    session = manager.get_session(
        tenant_id=tenant_id, user_id=user.id, terminal_id=request.terminal_id
    )
    if not session:
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Terminal session not found")
    session.resize(cols=request.cols, rows=request.rows)
    return Response(status_code=204)


@router.post("/terminal/close")
def close_terminal(user: User = Depends(current_user)) -> Response:
    tenant_id = get_current_tenant_id()
    manager = get_codex_labs_manager()
    manager.close_all_sessions(tenant_id=tenant_id, user_id=user.id)
    return Response(status_code=204)


@router.get("/files")
def list_files(
    path: str = "",
    user: User = Depends(current_user),
) -> DirectoryResponse:
    manager = get_codex_labs_manager()
    tenant_id = get_current_tenant_id()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    target = _resolve_user_path(home_dir, path)

    if not target.exists():
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Path not found")
    if not target.is_dir():
        raise OnyxError(OnyxErrorCode.INVALID_INPUT, "Path is not a directory")

    entries: list[FileEntry] = []
    for child in target.iterdir():
        if child.is_symlink():
            continue

        try:
            stat = child.stat()
        except FileNotFoundError:
            # Skip entries that disappear between list and stat.
            continue

        child_path = child.resolve()
        root = home_dir.resolve()
        if child_path != root and root not in child_path.parents:
            continue

        entries.append(
            FileEntry(
                name=child.name,
                path=_relative_path(home_dir, child),
                is_directory=child.is_dir(),
                mime_type=None if child.is_dir() else _guess_mime_type(child),
                size=None if child.is_dir() else stat.st_size,
                modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
            )
        )

    entries.sort(key=lambda e: (not e.is_directory, e.name.lower()))
    return DirectoryResponse(path=_relative_path(home_dir, target), entries=entries)


@router.post("/files/upload")
async def upload_file(
    file: UploadFile = File(...),
    path: str = Form(default=""),
    user: User = Depends(current_user),
) -> PathResponse:
    manager = get_codex_labs_manager()
    tenant_id = get_current_tenant_id()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    parent_dir = _resolve_user_path(home_dir, path)

    if not parent_dir.exists():
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Destination path not found")
    if not parent_dir.is_dir():
        raise OnyxError(
            OnyxErrorCode.INVALID_INPUT, "Destination path is not a directory"
        )

    filename = Path(file.filename or "upload.bin").name
    destination = parent_dir / filename

    if destination.exists():
        stem = destination.stem
        suffix = destination.suffix
        index = 1
        while destination.exists():
            destination = parent_dir / f"{stem} ({index}){suffix}"
            index += 1

    with destination.open("wb") as output_file:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            output_file.write(chunk)

    return PathResponse(path=_relative_path(home_dir, destination))


@router.get("/files/download")
def download_file(
    path: str,
    user: User = Depends(current_user),
) -> FileResponse:
    manager = get_codex_labs_manager()
    tenant_id = get_current_tenant_id()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    target = _resolve_user_path(home_dir, path)

    if not target.exists() or not target.is_file():
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "File not found")

    return FileResponse(path=str(target), filename=target.name)


@router.get("/files/content")
def get_file_content(
    path: str,
    user: User = Depends(current_user),
) -> FileResponse:
    manager = get_codex_labs_manager()
    tenant_id = get_current_tenant_id()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    target = _resolve_user_path(home_dir, path)

    if not target.exists() or not target.is_file():
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "File not found")

    media_type = _guess_mime_type(target) or "application/octet-stream"

    return FileResponse(
        path=str(target),
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="{target.name}"'},
    )


@router.put("/files/content")
def update_file_content(
    request: UpdateFileContentRequest,
    user: User = Depends(current_user),
) -> PathResponse:
    manager = get_codex_labs_manager()
    tenant_id = get_current_tenant_id()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    target = _resolve_user_path(home_dir, request.path)

    if not target.exists() or not target.is_file():
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "File not found")

    target.write_text(request.content, encoding="utf-8")
    return PathResponse(path=_relative_path(home_dir, target))


@router.post("/files/directory")
def create_directory(
    request: CreateDirectoryRequest,
    user: User = Depends(current_user),
) -> PathResponse:
    if not request.name or "/" in request.name or "\\" in request.name:
        raise OnyxError(OnyxErrorCode.INVALID_INPUT, "Invalid directory name")

    manager = get_codex_labs_manager()
    tenant_id = get_current_tenant_id()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    parent_dir = _resolve_user_path(home_dir, request.parent_path)

    if not parent_dir.exists() or not parent_dir.is_dir():
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Parent directory not found")

    target = parent_dir / request.name
    try:
        target.mkdir(exist_ok=False)
    except FileExistsError:
        raise OnyxError(OnyxErrorCode.DUPLICATE_RESOURCE, "Directory already exists")

    return PathResponse(path=_relative_path(home_dir, target))


@router.patch("/files/rename")
def rename_path(
    request: RenamePathRequest,
    user: User = Depends(current_user),
) -> PathResponse:
    if not request.new_name or "/" in request.new_name or "\\" in request.new_name:
        raise OnyxError(OnyxErrorCode.INVALID_INPUT, "Invalid name")

    manager = get_codex_labs_manager()
    tenant_id = get_current_tenant_id()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    target = _resolve_user_path(home_dir, request.path)
    _ensure_not_home_root(home_dir=home_dir, target=target)

    if not target.exists():
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Path not found")

    destination = target.parent / request.new_name
    if destination.exists():
        raise OnyxError(OnyxErrorCode.CONFLICT, "Destination already exists")

    target.rename(destination)
    return PathResponse(path=_relative_path(home_dir, destination))


@router.post("/files/move")
def move_path(
    request: MovePathRequest,
    user: User = Depends(current_user),
) -> PathResponse:
    manager = get_codex_labs_manager()
    tenant_id = get_current_tenant_id()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)

    source = _resolve_user_path(home_dir, request.path)
    _ensure_not_home_root(home_dir=home_dir, target=source)
    if not source.exists():
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Path not found")

    destination_parent = _resolve_user_path(home_dir, request.destination_parent_path)
    if not destination_parent.exists() or not destination_parent.is_dir():
        raise OnyxError(OnyxErrorCode.NOT_FOUND, "Destination directory not found")

    target_name = request.new_name if request.new_name is not None else source.name
    if not target_name or "/" in target_name or "\\" in target_name:
        raise OnyxError(OnyxErrorCode.INVALID_INPUT, "Invalid name")

    source_resolved = source.resolve()
    destination_parent_resolved = destination_parent.resolve()
    if source.is_dir() and (
        destination_parent_resolved == source_resolved
        or source_resolved in destination_parent_resolved.parents
    ):
        raise OnyxError(
            OnyxErrorCode.INVALID_INPUT,
            "Cannot move a directory into itself",
        )

    destination = destination_parent / target_name
    if destination.exists():
        raise OnyxError(OnyxErrorCode.CONFLICT, "Destination already exists")

    source.rename(destination)
    return PathResponse(path=_relative_path(home_dir, destination))


@router.delete("/files")
def delete_path(
    path: str,
    user: User = Depends(current_user),
) -> DeletePathResponse:
    manager = get_codex_labs_manager()
    tenant_id = get_current_tenant_id()
    home_dir = manager.get_user_home(tenant_id=tenant_id, user_id=user.id)
    target = _resolve_user_path(home_dir, path)
    _ensure_not_home_root(home_dir=home_dir, target=target)

    if not target.exists():
        return DeletePathResponse(deleted=False)

    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink(missing_ok=True)

    return DeletePathResponse(deleted=True)
