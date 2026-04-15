from types import SimpleNamespace
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from onyx.server.manage.models import UserOnyxCraftAccessUpdateRequest
from onyx.server.manage.users import update_user_onyx_craft_access


@patch("onyx.server.manage.users.get_user_by_email")
@patch("onyx.server.manage.users.ENABLE_CRAFT", False)
def test_update_user_onyx_craft_access_rejects_enabling_when_globally_disabled(
    mock_get_user_by_email: MagicMock,
) -> None:
    user = SimpleNamespace(enable_onyx_craft=False)
    mock_get_user_by_email.return_value = user
    db_session = MagicMock()

    request = UserOnyxCraftAccessUpdateRequest(
        user_email="user@example.com",
        enabled=True,
    )

    with pytest.raises(HTTPException) as exc_info:
        update_user_onyx_craft_access(request=request, _=None, db_session=db_session)

    assert exc_info.value.status_code == 400
    assert "globally disabled" in str(exc_info.value.detail)
    db_session.commit.assert_not_called()


@patch("onyx.server.manage.users.get_user_by_email")
@patch("onyx.server.manage.users.ENABLE_CRAFT", False)
def test_update_user_onyx_craft_access_forces_false_when_globally_disabled(
    mock_get_user_by_email: MagicMock,
) -> None:
    user = SimpleNamespace(enable_onyx_craft=True)
    mock_get_user_by_email.return_value = user
    db_session = MagicMock()

    request = UserOnyxCraftAccessUpdateRequest(
        user_email="user@example.com",
        enabled=False,
    )

    update_user_onyx_craft_access(request=request, _=None, db_session=db_session)

    assert user.enable_onyx_craft is False
    db_session.commit.assert_called_once()
