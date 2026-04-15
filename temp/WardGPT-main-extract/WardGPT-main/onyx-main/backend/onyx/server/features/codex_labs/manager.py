import asyncio
import fcntl
import os
import pty
import secrets
import signal
import struct
import termios
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID
from uuid import uuid4

from onyx.utils.logger import setup_logger

logger = setup_logger()

CODEX_LABS_BASE_PATH = Path(
    os.environ.get("CODEX_LABS_BASE_PATH", "/tmp/onyx-codex-labs")
)
CODEX_LABS_IDLE_TIMEOUT_SECONDS = int(
    os.environ.get("CODEX_LABS_IDLE_TIMEOUT_SECONDS", "3600")
)
CODEX_LABS_SWEEP_INTERVAL_SECONDS = int(
    os.environ.get("CODEX_LABS_SWEEP_INTERVAL_SECONDS", "60")
)
CODEX_LABS_MAX_TERMINALS_PER_USER = int(
    os.environ.get("CODEX_LABS_MAX_TERMINALS_PER_USER", "8")
)
CODEX_LABS_OUTPUT_REPLAY_CHUNKS = int(
    os.environ.get("CODEX_LABS_OUTPUT_REPLAY_CHUNKS", "128")
)
CODEX_LABS_WS_TICKET_TTL_SECONDS = int(
    os.environ.get("CODEX_LABS_WS_TICKET_TTL_SECONDS", "90")
)


@dataclass(frozen=True)
class Subscriber:
    queue: asyncio.Queue[dict[str, Any]]
    loop: asyncio.AbstractEventLoop


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
            maxlen=max(1, CODEX_LABS_OUTPUT_REPLAY_CHUNKS)
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

    def _broadcast(self, payload: dict[str, Any]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)

        for subscriber in subscribers:
            subscriber.loop.call_soon_threadsafe(
                self._safe_queue_put, subscriber.queue, payload
            )

    @staticmethod
    def _safe_queue_put(queue: asyncio.Queue[dict[str, Any]], payload: dict[str, Any]) -> None:
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
                self._broadcast(
                    {
                        "type": "output",
                        "data": decoded,
                    }
                )
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


class CodexLabsManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[tuple[str, UUID], dict[str, TerminalSession]] = {}
        self._ws_tickets: dict[str, tuple[str, UUID, str, float]] = {}
        self._sweeper_started = False

    @staticmethod
    def _user_key(tenant_id: str, user_id: UUID) -> tuple[str, UUID]:
        return (tenant_id, user_id)

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
                now + max(10, CODEX_LABS_WS_TICKET_TTL_SECONDS),
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
            time.sleep(CODEX_LABS_SWEEP_INTERVAL_SECONDS)
            cutoff = time.time() - CODEX_LABS_IDLE_TIMEOUT_SECONDS
            stale_session_keys: list[tuple[str, UUID]] = []
            stale_terminal_ids: list[str] = []

            with self._lock:
                for user_key, user_sessions in self._sessions.items():
                    for terminal_id, session in user_sessions.items():
                        if session.last_activity < cutoff:
                            stale_session_keys.append(user_key)
                            stale_terminal_ids.append(terminal_id)

            for user_key, terminal_id in zip(stale_session_keys, stale_terminal_ids):
                self.close_session(
                    tenant_id=user_key[0], user_id=user_key[1], terminal_id=terminal_id
                )

    def get_user_home(self, tenant_id: str, user_id: UUID) -> Path:
        home_dir = CODEX_LABS_BASE_PATH / tenant_id / str(user_id)
        home_dir.mkdir(parents=True, exist_ok=True)
        return home_dir

    def warmup(
        self,
        tenant_id: str,
        user_id: UUID,
        env_overrides: dict[str, str] | None = None,
    ) -> Path:
        home_dir = self.get_user_home(tenant_id, user_id)
        self._ensure_sweeper()
        self.ensure_default_session(
            tenant_id=tenant_id,
            user_id=user_id,
            home_dir=home_dir,
            env_overrides=env_overrides,
        )
        return home_dir

    def _create_session_locked(
        self,
        user_key: tuple[str, UUID],
        user_id: UUID,
        home_dir: Path,
        env_overrides: dict[str, str] | None,
    ) -> tuple[str, TerminalSession]:
        user_sessions = self._sessions.setdefault(user_key, {})
        active_session_count = sum(1 for session in user_sessions.values() if session.alive)
        if active_session_count >= CODEX_LABS_MAX_TERMINALS_PER_USER:
            raise ValueError(
                f"Maximum terminal count reached ({CODEX_LABS_MAX_TERMINALS_PER_USER})"
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

            for dead_terminal_id in dead_terminal_ids:
                user_sessions.pop(dead_terminal_id, None)

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


_MANAGER = CodexLabsManager()


def get_codex_labs_manager() -> CodexLabsManager:
    return _MANAGER
