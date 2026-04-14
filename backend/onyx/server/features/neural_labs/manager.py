import asyncio
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
import fcntl
import mimetypes
import os
from pathlib import Path
import pty
import secrets
import shutil
import signal
import struct
import termios
import threading
import time
from uuid import UUID
from uuid import uuid4

from sqlalchemy.orm import Session

from onyx.db.models import User
from onyx.server.features.build.configs import PERSISTENT_DOCUMENT_STORAGE_PATH
from onyx.utils.logger import setup_logger
from shared_configs.contextvars import get_current_tenant_id

logger = setup_logger()

NEURAL_LABS_IDLE_TIMEOUT_SECONDS = 3600
NEURAL_LABS_SWEEP_INTERVAL_SECONDS = 60
NEURAL_LABS_MAX_TERMINALS_PER_USER = 8
NEURAL_LABS_OUTPUT_REPLAY_CHUNKS = 128
NEURAL_LABS_WS_TICKET_TTL_SECONDS = 90


@dataclass(frozen=True)
class Subscriber:
    queue: asyncio.Queue[dict]
    loop: asyncio.AbstractEventLoop


@dataclass
class WorkspaceSession:
    id: str
    path: str
    root: Path


@dataclass
class WorkspaceEntry:
    name: str
    path: str
    is_directory: bool
    mime_type: str | None
    size: int | None
    modified_at: datetime | None


@dataclass
class DirectoryListing:
    path: str
    entries: list[WorkspaceEntry]


class TerminalSession:
    def __init__(
        self,
        user_id: UUID,
        home_dir: Path,
        env_overrides: dict[str, str] | None = None,
        on_exit: Callable[[], None] | None = None,
    ) -> None:
        self.user_id = user_id
        self.home_dir = home_dir
        self.env_overrides = env_overrides or {}
        self._on_exit = on_exit
        self._lock = threading.Lock()
        self._subscribers: set[Subscriber] = set()
        self._alive = True
        self._master_fd_closed = False
        now = time.time()
        self.created_at = now
        self.last_activity = now
        self.first_output_at: float | None = None
        self._recent_output_chunks: deque[str] = deque(
            maxlen=max(1, NEURAL_LABS_OUTPUT_REPLAY_CHUNKS)
        )

        pid, master_fd = pty.fork()
        if pid == 0:
            os.environ["HOME"] = str(home_dir)
            os.environ["USER"] = str(user_id)
            os.environ.setdefault("TERM", "xterm-256color")
            for key, value in self.env_overrides.items():
                os.environ[key] = value
            os.chdir(home_dir)
            os.execv("/bin/bash", ["/bin/bash", "-l"])

        self.pid = pid
        self.master_fd = master_fd
        self._start_reader_thread()
        self._set_size(120, 32)

    def _start_reader_thread(self) -> None:
        thread = threading.Thread(target=self._reader_loop, daemon=True)
        thread.start()

    def _broadcast(self, payload: dict[str, object]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)

        for subscriber in subscribers:
            subscriber.loop.call_soon_threadsafe(
                self._safe_queue_put, subscriber.queue, payload
            )

    @staticmethod
    def _safe_queue_put(queue: asyncio.Queue[dict], payload: dict[str, object]) -> None:
        try:
            queue.put_nowait(payload)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
                queue.put_nowait(payload)
            except Exception:
                pass

    def _reader_loop(self) -> None:
        try:
            while self._alive:
                try:
                    data = os.read(self.master_fd, 4096)
                except OSError:
                    break

                if not data:
                    break

                self.last_activity = time.time()
                decoded = data.decode("utf-8", errors="ignore")
                if decoded:
                    if self.first_output_at is None:
                        self.first_output_at = time.time()
                    with self._lock:
                        self._recent_output_chunks.append(decoded)
                self._broadcast({"type": "output", "data": decoded})
        finally:
            exit_code = None
            try:
                _, status = os.waitpid(self.pid, os.WNOHANG)
                if status:
                    exit_code = os.waitstatus_to_exitcode(status)
            except ChildProcessError:
                exit_code = 0
            except Exception:
                exit_code = None

            self._alive = False
            self._broadcast({"type": "exit", "code": exit_code})
            self.close()
            if self._on_exit:
                self._on_exit()

    def add_subscriber(self, subscriber: Subscriber) -> None:
        with self._lock:
            self._subscribers.add(subscriber)
            replay_chunks = list(self._recent_output_chunks)

        for chunk in replay_chunks:
            subscriber.loop.call_soon_threadsafe(
                self._safe_queue_put,
                subscriber.queue,
                {"type": "output", "data": chunk},
            )

    def remove_subscriber(self, subscriber: Subscriber) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)

    @property
    def alive(self) -> bool:
        return self._alive

    @property
    def state(self) -> str:
        if not self._alive:
            return "exited"
        if self.first_output_at is None:
            return "initializing"
        return "ready"

    @property
    def has_output(self) -> bool:
        with self._lock:
            return len(self._recent_output_chunks) > 0

    def write_input(self, data: str) -> None:
        if not self._alive:
            raise RuntimeError("Terminal session is not running")
        self.last_activity = time.time()
        os.write(self.master_fd, data.encode("utf-8", errors="ignore"))

    def _set_size(self, cols: int, rows: int) -> None:
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)

    def resize(self, cols: int, rows: int) -> None:
        if not self._alive:
            return
        cols = max(20, min(cols, 500))
        rows = max(5, min(rows, 200))
        self.last_activity = time.time()
        self._set_size(cols, rows)

    def close(self) -> None:
        was_alive = self._alive
        self._alive = False

        if was_alive:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception as e:
                logger.warning(
                    f"Failed terminating terminal process for user {self.user_id}: {e}"
                )

        with self._lock:
            if self._master_fd_closed:
                return
            self._master_fd_closed = True

        try:
            os.close(self.master_fd)
        except OSError:
            pass


class NeuralLabsManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[tuple[str, UUID], dict[str, TerminalSession]] = {}
        self._ws_tickets: dict[str, tuple[str, UUID, str, float]] = {}
        self._sweeper_started = False

    @staticmethod
    def _user_key(tenant_id: str, user_id: UUID) -> tuple[str, UUID]:
        return (tenant_id, user_id)

    def get_user_home(self, tenant_id: str, user_id: UUID) -> Path:
        home_dir = (
            Path(PERSISTENT_DOCUMENT_STORAGE_PATH)
            / tenant_id
            / "neural-labs"
            / str(user_id)
        )
        home_dir.mkdir(parents=True, exist_ok=True)
        welcome_file = home_dir / "README.md"
        if not welcome_file.exists():
            welcome_file.write_text(
                "# Neural Labs Workspace\n\n"
                "This directory backs the current Neural Labs workspace.\n"
                "Files uploaded here are scoped to your account.\n",
                encoding="utf-8",
            )
        for seed_dir in ("downloads", "outputs"):
            (home_dir / seed_dir).mkdir(parents=True, exist_ok=True)
        return home_dir

    def _resolve_path(self, workspace_root: Path, path: str) -> Path:
        candidate = workspace_root
        for part in Path(path.lstrip("/")).parts:
            if part in {"", ".", ".."}:
                continue
            candidate = candidate / part

        resolved_root = workspace_root.resolve()
        resolved_candidate = candidate.resolve(strict=False)
        try:
            resolved_candidate.relative_to(resolved_root)
        except ValueError as e:
            raise ValueError("Invalid path: potential path traversal detected") from e
        return resolved_candidate

    def _normalize_relative_path(self, workspace_root: Path, target_path: Path) -> str:
        normalized_path = target_path.relative_to(workspace_root).as_posix()
        return "" if normalized_path == "." else normalized_path

    def _sanitize_name(self, name: str) -> str:
        cleaned = name.strip().strip("/\\")
        if not cleaned:
            raise ValueError("Name cannot be empty")
        if cleaned in {".", ".."}:
            raise ValueError("Invalid name")
        if "/" in cleaned or "\\" in cleaned:
            raise ValueError("Name cannot contain path separators")
        return cleaned

    def ensure_workspace_session(self, user: User) -> WorkspaceSession:
        tenant_id = get_current_tenant_id()
        workspace_root = self.get_user_home(tenant_id=tenant_id, user_id=user.id)
        return WorkspaceSession(
            id=f"neural-labs-{user.id}",
            path="",
            root=workspace_root,
        )

    def list_directory(self, workspace_root: Path, path: str) -> DirectoryListing:
        target_dir = self._resolve_path(workspace_root, path)
        if not target_dir.exists():
            raise ValueError("Directory not found")
        if not target_dir.is_dir():
            raise ValueError("Path is not a directory")

        entries: list[WorkspaceEntry] = []
        for item in sorted(
            target_dir.iterdir(),
            key=lambda entry: (not entry.is_dir(), entry.name.lower()),
        ):
            relative_path = item.relative_to(workspace_root).as_posix()
            mime_type = None if item.is_dir() else mimetypes.guess_type(item.name)[0]
            stat = item.stat()
            entries.append(
                WorkspaceEntry(
                    name=item.name,
                    path=relative_path,
                    is_directory=item.is_dir(),
                    mime_type=mime_type,
                    size=None if item.is_dir() else stat.st_size,
                    modified_at=datetime.fromtimestamp(stat.st_mtime),
                )
            )

        return DirectoryListing(
            path=self._normalize_relative_path(workspace_root, target_dir),
            entries=entries,
        )

    def read_file(self, workspace_root: Path, path: str) -> tuple[bytes, str, str]:
        file_path = self._resolve_path(workspace_root, path)
        if not file_path.exists() or not file_path.is_file():
            raise ValueError("File not found")

        mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        return file_path.read_bytes(), mime_type, file_path.name

    def upload_file(
        self,
        workspace_root: Path,
        filename: str,
        content: bytes,
        parent_path: str = "",
    ) -> tuple[str, int]:
        target_dir = self._resolve_path(workspace_root, parent_path)
        target_dir.mkdir(parents=True, exist_ok=True)

        target_file = self._resolve_path(workspace_root, f"{parent_path}/{filename}")
        target_file.parent.mkdir(parents=True, exist_ok=True)
        target_file.write_bytes(content)
        return target_file.relative_to(workspace_root).as_posix(), len(content)

    def create_directory(
        self,
        workspace_root: Path,
        parent_path: str,
        name: str,
    ) -> str:
        safe_name = self._sanitize_name(name)
        parent_dir = self._resolve_path(workspace_root, parent_path)
        parent_dir.mkdir(parents=True, exist_ok=True)
        if not parent_dir.is_dir():
            raise ValueError("Parent path is not a directory")

        new_dir = self._resolve_path(workspace_root, f"{parent_path}/{safe_name}")
        new_dir.mkdir(parents=False, exist_ok=False)
        return self._normalize_relative_path(workspace_root, new_dir)

    def rename_path(
        self,
        workspace_root: Path,
        path: str,
        new_name: str,
    ) -> str:
        source_path = self._resolve_path(workspace_root, path)
        if not source_path.exists():
            raise ValueError("Path not found")

        safe_name = self._sanitize_name(new_name)
        destination_path = source_path.with_name(safe_name)
        destination_path = self._resolve_path(
            workspace_root,
            self._normalize_relative_path(workspace_root, destination_path),
        )
        if destination_path.exists():
            raise ValueError("Destination already exists")

        source_path.rename(destination_path)
        return self._normalize_relative_path(workspace_root, destination_path)

    def move_path(
        self,
        workspace_root: Path,
        path: str,
        destination_parent_path: str,
        new_name: str | None = None,
    ) -> str:
        source_path = self._resolve_path(workspace_root, path)
        if not source_path.exists():
            raise ValueError("Path not found")

        destination_parent = self._resolve_path(workspace_root, destination_parent_path)
        destination_parent.mkdir(parents=True, exist_ok=True)
        if not destination_parent.is_dir():
            raise ValueError("Destination parent is not a directory")

        final_name = self._sanitize_name(new_name) if new_name else source_path.name
        destination_path = destination_parent / final_name
        destination_path = self._resolve_path(
            workspace_root,
            self._normalize_relative_path(workspace_root, destination_path),
        )
        if destination_path.exists():
            raise ValueError("Destination already exists")

        if source_path.is_dir():
            resolved_source = source_path.resolve()
            resolved_destination_parent = destination_parent.resolve()
            if (
                resolved_destination_parent == resolved_source
                or resolved_destination_parent.is_relative_to(resolved_source)
            ):
                raise ValueError("Cannot move a directory into itself")

        source_path.rename(destination_path)
        return self._normalize_relative_path(workspace_root, destination_path)

    def update_text_file(
        self,
        workspace_root: Path,
        path: str,
        content: str,
    ) -> str:
        file_path = self._resolve_path(workspace_root, path)
        if file_path.exists() and file_path.is_dir():
            raise ValueError("Path is a directory")

        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(content, encoding="utf-8")
        return self._normalize_relative_path(workspace_root, file_path)

    def delete_file(self, workspace_root: Path, path: str) -> bool:
        target_path = self._resolve_path(workspace_root, path)
        if not target_path.exists():
            raise ValueError("Path not found")

        if target_path.is_dir():
            shutil.rmtree(target_path)
        else:
            target_path.unlink()
        return True

    def _remove_dead_session(self, user_key: tuple[str, UUID], terminal_id: str) -> None:
        with self._lock:
            user_sessions = self._sessions.get(user_key)
            if not user_sessions:
                return
            existing = user_sessions.get(terminal_id)
            if existing and not existing.alive:
                user_sessions.pop(terminal_id, None)
            if not user_sessions:
                self._sessions.pop(user_key, None)

    def _ensure_sweeper(self) -> None:
        if self._sweeper_started:
            return
        with self._lock:
            if self._sweeper_started:
                return
            thread = threading.Thread(target=self._sweeper_loop, daemon=True)
            thread.start()
            self._sweeper_started = True

    def _purge_expired_ws_tickets_locked(self, now: float) -> None:
        expired_tokens = [
            token
            for token, (_tenant_id, _user_id, _terminal_id, expires_at) in self._ws_tickets.items()
            if expires_at <= now
        ]
        for token in expired_tokens:
            self._ws_tickets.pop(token, None)

    def issue_ws_ticket(self, tenant_id: str, user_id: UUID, terminal_id: str) -> str:
        user_key = self._user_key(tenant_id, user_id)
        now = time.time()
        with self._lock:
            self._purge_expired_ws_tickets_locked(now)
            user_sessions = self._sessions.get(user_key)
            if not user_sessions:
                raise KeyError("Terminal session not found")
            session = user_sessions.get(terminal_id)
            if not session or not session.alive:
                raise KeyError("Terminal session not found")

            ticket = secrets.token_urlsafe(32)
            self._ws_tickets[ticket] = (
                tenant_id,
                user_id,
                terminal_id,
                now + max(10, NEURAL_LABS_WS_TICKET_TTL_SECONDS),
            )
            return ticket

    def consume_ws_ticket(self, ticket: str) -> tuple[str, UUID, str] | None:
        now = time.time()
        with self._lock:
            self._purge_expired_ws_tickets_locked(now)
            payload = self._ws_tickets.pop(ticket, None)
            if payload is None:
                return None

            tenant_id, user_id, terminal_id, _expires_at = payload
            user_sessions = self._sessions.get(self._user_key(tenant_id, user_id))
            if not user_sessions:
                return None
            session = user_sessions.get(terminal_id)
            if not session or not session.alive:
                return None
            return (tenant_id, user_id, terminal_id)

    def _sweeper_loop(self) -> None:
        while True:
            time.sleep(NEURAL_LABS_SWEEP_INTERVAL_SECONDS)
            cutoff = time.time() - NEURAL_LABS_IDLE_TIMEOUT_SECONDS
            stale_pairs: list[tuple[tuple[str, UUID], str]] = []
            with self._lock:
                for user_key, user_sessions in self._sessions.items():
                    for terminal_id, session in user_sessions.items():
                        if session.last_activity < cutoff:
                            stale_pairs.append((user_key, terminal_id))

            for user_key, terminal_id in stale_pairs:
                self.close_session(
                    tenant_id=user_key[0], user_id=user_key[1], terminal_id=terminal_id
                )

    def _create_session_locked(
        self,
        user_key: tuple[str, UUID],
        user_id: UUID,
        home_dir: Path,
        env_overrides: dict[str, str] | None,
    ) -> tuple[str, TerminalSession]:
        user_sessions = self._sessions.setdefault(user_key, {})
        active_count = sum(1 for session in user_sessions.values() if session.alive)
        if active_count >= NEURAL_LABS_MAX_TERMINALS_PER_USER:
            raise ValueError(
                f"Maximum terminal count reached ({NEURAL_LABS_MAX_TERMINALS_PER_USER})"
            )

        terminal_id = str(uuid4())
        while terminal_id in user_sessions:
            terminal_id = str(uuid4())

        session = TerminalSession(
            user_id=user_id,
            home_dir=home_dir,
            env_overrides=env_overrides,
            on_exit=lambda tid=terminal_id: self._remove_dead_session(user_key, tid),
        )
        user_sessions[terminal_id] = session
        return terminal_id, session

    def create_session(
        self,
        tenant_id: str,
        user_id: UUID,
        home_dir: Path,
        env_overrides: dict[str, str] | None = None,
    ) -> tuple[str, TerminalSession]:
        self._ensure_sweeper()
        user_key = self._user_key(tenant_id, user_id)
        with self._lock:
            return self._create_session_locked(
                user_key=user_key,
                user_id=user_id,
                home_dir=home_dir,
                env_overrides=env_overrides,
            )

    def ensure_default_session(
        self,
        tenant_id: str,
        user_id: UUID,
        home_dir: Path,
        env_overrides: dict[str, str] | None = None,
    ) -> tuple[str, TerminalSession]:
        self._ensure_sweeper()
        user_key = self._user_key(tenant_id, user_id)
        with self._lock:
            user_sessions = self._sessions.get(user_key, {})
            for terminal_id, session in user_sessions.items():
                if session.alive:
                    session.last_activity = time.time()
                    return terminal_id, session

            return self._create_session_locked(
                user_key=user_key,
                user_id=user_id,
                home_dir=home_dir,
                env_overrides=env_overrides,
            )

    def list_sessions(self, tenant_id: str, user_id: UUID) -> list[tuple[str, TerminalSession]]:
        user_key = self._user_key(tenant_id, user_id)
        with self._lock:
            user_sessions = self._sessions.get(user_key)
            if not user_sessions:
                return []

            alive_sessions: list[tuple[str, TerminalSession]] = []
            dead_terminal_ids: list[str] = []
            for terminal_id, session in user_sessions.items():
                if session.alive:
                    alive_sessions.append((terminal_id, session))
                else:
                    dead_terminal_ids.append(terminal_id)

            for terminal_id in dead_terminal_ids:
                user_sessions.pop(terminal_id, None)
            if not user_sessions:
                self._sessions.pop(user_key, None)
            return alive_sessions

    def get_session(
        self, tenant_id: str, user_id: UUID, terminal_id: str | None = None
    ) -> TerminalSession | None:
        user_key = self._user_key(tenant_id, user_id)
        with self._lock:
            user_sessions = self._sessions.get(user_key)
            if not user_sessions:
                return None

            if terminal_id:
                session = user_sessions.get(terminal_id)
                if session and session.alive:
                    return session
                return None

            for session in user_sessions.values():
                if session.alive:
                    return session
            return None

    def close_session(self, tenant_id: str, user_id: UUID, terminal_id: str) -> None:
        user_key = self._user_key(tenant_id, user_id)
        with self._lock:
            user_sessions = self._sessions.get(user_key)
            if not user_sessions:
                return

            session = user_sessions.pop(terminal_id, None)
            if not user_sessions:
                self._sessions.pop(user_key, None)

        if session is not None:
            session.close()

    def close_all_sessions(self, tenant_id: str, user_id: UUID) -> None:
        user_key = self._user_key(tenant_id, user_id)
        with self._lock:
            user_sessions = self._sessions.pop(user_key, {})

        for session in user_sessions.values():
            session.close()


_MANAGER = NeuralLabsManager()


def get_neural_labs_manager() -> NeuralLabsManager:
    return _MANAGER


class NeuralLabsSessionManager:
    """Compatibility wrapper for existing file APIs."""

    def __init__(self, db_session: Session) -> None:
        self._db_session = db_session
        self._manager = _MANAGER

    def ensure_workspace_session(self, user: User) -> WorkspaceSession:
        return self._manager.ensure_workspace_session(user)

    def __getattr__(self, item: str) -> object:
        return getattr(self._manager, item)
