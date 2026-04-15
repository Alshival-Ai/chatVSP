from types import SimpleNamespace

from onyx.chat.kmz_agent_parity import append_kmz_guidance_if_missing
from onyx.chat.kmz_agent_parity import build_effective_kmz_persona
from onyx.chat.kmz_agent_parity import is_kmz_agent_name
from onyx.chat.kmz_agent_parity import KMZ_FILENAME_EXTENSION_RULE
from onyx.chat.kmz_agent_parity import merge_tools_with_default


def _tool(tool_id: int) -> SimpleNamespace:
    return SimpleNamespace(id=tool_id, name=f"tool-{tool_id}")


def _persona(
    *,
    name: str,
    tool_ids: list[int],
    system_prompt: str | None = "base prompt",
) -> SimpleNamespace:
    return SimpleNamespace(
        id=123,
        name=name,
        tools=[_tool(tid) for tid in tool_ids],
        replace_base_system_prompt=False,
        system_prompt=system_prompt,
        datetime_aware=True,
        task_prompt=None,
        user_files=[],
    )


def test_is_kmz_agent_name_case_insensitive() -> None:
    assert is_kmz_agent_name("KMZ agent") is True
    assert is_kmz_agent_name(" kmz AGENT ") is True
    assert is_kmz_agent_name("not-kmz") is False


def test_append_kmz_guidance_if_missing_is_idempotent() -> None:
    first = append_kmz_guidance_if_missing("custom prompt")
    second = append_kmz_guidance_if_missing(first)

    assert "# KMZ/KML Operations" in first
    assert KMZ_FILENAME_EXTENSION_RULE in first
    assert second == first


def test_append_kmz_guidance_if_missing_adds_extension_rule_to_existing_kmz_prompt() -> None:
    existing_prompt = "# KMZ/KML Operations\n- Existing rule."

    merged = append_kmz_guidance_if_missing(existing_prompt)

    assert KMZ_FILENAME_EXTENSION_RULE in merged


def test_merge_tools_with_default_deduplicates_by_id() -> None:
    merged = merge_tools_with_default(
        persona_tools=[_tool(1), _tool(2)],
        default_tools=[_tool(2), _tool(3)],
    )

    assert [tool.id for tool in merged] == [1, 2, 3]


def test_build_effective_kmz_persona_inherits_default_tools_and_guidance() -> None:
    kmz_persona = _persona(name="KMZ agent", tool_ids=[1], system_prompt="custom")
    default_persona = _persona(name="default", tool_ids=[2, 3], system_prompt="default")

    effective = build_effective_kmz_persona(kmz_persona, default_persona)  # type: ignore[arg-type]

    assert [tool.id for tool in effective.tools] == [1, 2, 3]
    assert "# KMZ/KML Operations" in effective.system_prompt


def test_build_effective_kmz_persona_appends_required_tools() -> None:
    kmz_persona = _persona(name="KMZ agent", tool_ids=[1], system_prompt="custom")
    default_persona = _persona(name="default", tool_ids=[2], system_prompt="default")
    required = [_tool(9), _tool(18)]

    effective = build_effective_kmz_persona(  # type: ignore[arg-type]
        kmz_persona,
        default_persona,
        required_tools=required,
    )

    assert [tool.id for tool in effective.tools] == [1, 2, 9, 18]


def test_build_effective_kmz_persona_keeps_non_kmz_unchanged() -> None:
    persona = _persona(name="General Agent", tool_ids=[7], system_prompt="plain")
    effective = build_effective_kmz_persona(persona, None)  # type: ignore[arg-type]

    assert effective is persona
