from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from onyx.prompts.chat_prompts import KMZ_KML_OPERATIONS_GUIDANCE

KMZ_GUIDANCE_HEADING = "# KMZ/KML Operations"
KMZ_FILENAME_EXTENSION_RULE = (
    "- Ensure every generated KMZ filename explicitly ends with `.kmz` "
    "(for example `compiled_packets.kmz`)."
)
KMZ_AGENT_NAME_ALIASES = {
    "kmz agent",
}


class EffectivePersonaProxy:
    """Runtime-only persona proxy that overrides prompt/tools without DB mutation."""

    def __init__(self, base_persona: Any, *, tools: list[Any], system_prompt: str) -> None:
        self._base_persona = base_persona
        self.tools = tools
        self.system_prompt = system_prompt

    def __getattr__(self, name: str) -> Any:
        return getattr(self._base_persona, name)


def is_kmz_agent_name(persona_name: str | None) -> bool:
    normalized = (persona_name or "").strip().lower()
    return normalized in KMZ_AGENT_NAME_ALIASES


def append_kmz_guidance_if_missing(system_prompt: str | None) -> str:
    prompt = (system_prompt or "").strip()
    if KMZ_GUIDANCE_HEADING.lower() in prompt.lower():
        merged = prompt
    elif not prompt:
        merged = KMZ_KML_OPERATIONS_GUIDANCE
    else:
        merged = f"{prompt}\n\n{KMZ_KML_OPERATIONS_GUIDANCE}".strip()

    if KMZ_FILENAME_EXTENSION_RULE.lower() in merged.lower():
        return merged
    return f"{merged}\n{KMZ_FILENAME_EXTENSION_RULE}".strip()


def merge_tools_with_default(
    persona_tools: Sequence[Any],
    default_tools: Sequence[Any],
    required_tools: Sequence[Any] | None = None,
) -> list[Any]:
    merged: list[Any] = []
    seen_tool_ids: set[int] = set()

    def add_tools(tools: Sequence[Any]) -> None:
        for tool in tools:
            tool_id = getattr(tool, "id", None)
            if not isinstance(tool_id, int):
                continue
            if tool_id in seen_tool_ids:
                continue
            seen_tool_ids.add(tool_id)
            merged.append(tool)

    add_tools(persona_tools)
    add_tools(default_tools)
    if required_tools:
        add_tools(required_tools)

    return merged


def build_effective_kmz_persona(
    persona: Any,
    default_persona: Any | None,
    required_tools: Sequence[Any] | None = None,
) -> Any:
    if not is_kmz_agent_name(getattr(persona, "name", None)):
        return persona

    merged_tools = merge_tools_with_default(
        persona_tools=getattr(persona, "tools", []) or [],
        default_tools=getattr(default_persona, "tools", []) or [],
        required_tools=required_tools,
    )
    merged_prompt = append_kmz_guidance_if_missing(getattr(persona, "system_prompt", ""))

    original_prompt = getattr(persona, "system_prompt", "") or ""
    original_tools = getattr(persona, "tools", []) or []
    if merged_prompt == original_prompt and [getattr(t, "id", None) for t in merged_tools] == [
        getattr(t, "id", None) for t in original_tools
    ]:
        return persona

    return EffectivePersonaProxy(
        persona,
        tools=merged_tools,
        system_prompt=merged_prompt,
    )
