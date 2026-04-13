from dataclasses import dataclass
from pathlib import Path
import mimetypes
import shutil
from uuid import UUID

from sqlalchemy.orm import Session

from onyx.db.models import User
from onyx.server.features.build.configs import PERSISTENT_DOCUMENT_STORAGE_PATH
from shared_configs.contextvars import get_current_tenant_id


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


@dataclass
class DirectoryListing:
    path: str
    entries: list[WorkspaceEntry]


class CodexLabsSessionManager:
    """Manage a lightweight per-user Codex Labs workspace on persistent storage."""

    def __init__(self, db_session: Session) -> None:
        self._db_session = db_session

    def ensure_workspace_session(self, user: User) -> WorkspaceSession:
        tenant_id = get_current_tenant_id()
        workspace_root = (
            Path(PERSISTENT_DOCUMENT_STORAGE_PATH)
            / tenant_id
            / "codex-labs"
            / str(user.id)
        )
        workspace_root.mkdir(parents=True, exist_ok=True)

        welcome_file = workspace_root / "README.md"
        if not welcome_file.exists():
            welcome_file.write_text(
                "# Codex Labs Workspace\n\n"
                "This directory backs the first non-destructive Codex Labs slice.\n"
                "Files uploaded here are scoped to your account.\n",
                encoding="utf-8",
            )

        return WorkspaceSession(
            id=f"codex-labs-{user.id}",
            path="",
            root=workspace_root,
        )

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
            entries.append(
                WorkspaceEntry(
                    name=item.name,
                    path=relative_path,
                    is_directory=item.is_dir(),
                    mime_type=mime_type,
                    size=None if item.is_dir() else item.stat().st_size,
                )
            )

        normalized_path = target_dir.relative_to(workspace_root).as_posix()
        if normalized_path == ".":
            normalized_path = ""
        return DirectoryListing(path=normalized_path, entries=entries)

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

    def delete_file(self, workspace_root: Path, path: str) -> bool:
        target_path = self._resolve_path(workspace_root, path)
        if not target_path.exists():
            raise ValueError("Path not found")

        if target_path.is_dir():
            shutil.rmtree(target_path)
        else:
            target_path.unlink()
        return True
