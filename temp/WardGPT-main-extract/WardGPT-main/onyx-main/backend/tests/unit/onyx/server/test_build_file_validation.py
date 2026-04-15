from types import SimpleNamespace
from unittest.mock import MagicMock
from unittest.mock import patch

from onyx.server.features.build.utils import is_onyx_craft_enabled
from onyx.server.features.build.utils import validate_file_extension


def test_validate_file_extension_accepts_kmz() -> None:
    is_valid, error = validate_file_extension("network-map.kmz")
    assert is_valid is True
    assert error is None


@patch("onyx.server.features.build.utils.ENABLE_CRAFT", False)
def test_is_onyx_craft_enabled_global_disable_overrides_user_and_flags() -> None:
    user = SimpleNamespace(id="u1", enable_onyx_craft=True)

    feature_provider = MagicMock()
    feature_provider.feature_enabled.return_value = True

    with patch(
        "onyx.server.features.build.utils.get_default_feature_flag_provider",
        return_value=feature_provider,
    ):
        assert is_onyx_craft_enabled(user) is False


@patch("onyx.server.features.build.utils.ENABLE_CRAFT", True)
def test_is_onyx_craft_enabled_requires_per_user_access_even_when_global_enabled() -> None:
    user = SimpleNamespace(id="u1", enable_onyx_craft=False)

    feature_provider = MagicMock()
    feature_provider.feature_enabled.return_value = True

    with patch(
        "onyx.server.features.build.utils.get_default_feature_flag_provider",
        return_value=feature_provider,
    ):
        assert is_onyx_craft_enabled(user) is False
