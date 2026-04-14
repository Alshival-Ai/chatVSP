from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from onyx.server.features.neural_labs import api


def test_raise_files_http_error_maps_missing_paths_to_404() -> None:
    with pytest.raises(HTTPException) as exc_info:
        api._raise_files_http_error(ValueError("Directory not found"))

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Directory not found"


def test_raise_files_http_error_maps_existing_paths_to_409() -> None:
    with pytest.raises(HTTPException) as exc_info:
        api._raise_files_http_error(ValueError("Destination already exists"))

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "Destination already exists"


def test_list_files_uses_404_for_missing_directories(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = Mock()
    manager.list_directory.side_effect = ValueError("Directory not found")

    monkeypatch.setattr(api, "_get_manager", lambda _db_session: manager)
    monkeypatch.setattr(
        api,
        "_workspace_for_user",
        lambda _manager, _user: ("tenant", Path("/tmp/workspace")),
    )

    with pytest.raises(HTTPException) as exc_info:
        api.list_files(path="Broward", user=Mock(), db_session=Mock())

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "Directory not found"

