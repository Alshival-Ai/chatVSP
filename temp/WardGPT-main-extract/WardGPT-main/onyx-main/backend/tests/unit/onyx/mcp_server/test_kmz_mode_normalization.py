import pytest

from onyx.mcp_server.tools.kmz import _build_extraction_instruction
from onyx.mcp_server.tools.kmz import _normalize_mode


def test_normalize_mode_defaults_to_many_to_many() -> None:
    assert _normalize_mode(None) == "many_to_many"


def test_normalize_mode_maps_legacy_compiled_values_to_many_to_many() -> None:
    assert _normalize_mode("many_to_one") == "many_to_many"
    assert _normalize_mode("compiled") == "many_to_many"
    assert _normalize_mode("combined") == "many_to_many"


def test_normalize_mode_rejects_unknown_values() -> None:
    with pytest.raises(ValueError):
        _normalize_mode("unknown")


def test_build_extraction_instruction_is_per_packet_for_all_modes() -> None:
    instruction = _build_extraction_instruction("many_to_many", None)
    assert instruction == "Create one KMZ per packet from all attached packet files."

    with_extra = _build_extraction_instruction("many_to_many", "Preserve naming")
    assert "Create one KMZ per packet" in with_extra
    assert "Preserve naming" in with_extra
