from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
import mimetypes
import shutil

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
    modified_at: datetime | None


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
                    modified_at=datetime.fromtimestamp(
                        item.stat().st_mtime
                    ),
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
            if resolved_destination_parent == resolved_source or resolved_destination_parent.is_relative_to(
                resolved_source
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
