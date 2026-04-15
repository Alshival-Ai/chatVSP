"""Helpers to deploy critical custom agents on demand."""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from sqlalchemy import func
from sqlalchemy import select
from sqlalchemy.orm import Session

from onyx.db.models import Persona
from onyx.db.models import Tool
from onyx.db.persona import get_default_assistant
from onyx.db.persona import upsert_persona
from onyx.prompts.chat_prompts import KMZ_KML_OPERATIONS_GUIDANCE
from onyx.tools.constants import KMZ_PROCESSING_TOOL_ID
from onyx.tools.constants import KMZ_PROCESSING_TOOL_NAME
from onyx.utils.logger import setup_logger

logger = setup_logger()

DESIGN_AGENT_NAME = "Design Agent"
KMZ_AGENT_NAME = "KMZ Agent"

DESIGN_AGENT_DESCRIPTION = "Primary design workflow assistant."
KMZ_AGENT_DESCRIPTION = "Primary KMZ/KML workflow assistant."

_KMZ_REQUIRED_MCP_TOOL_NAMES = (
    "google_places_geocode_address",
    "google_places_search_text",
    "google_places_get_place_details",
)

CriticalAgentKey = Literal["design", "kmz"]
EnsureStatus = Literal["exists", "restored", "created"]
DeployStatus = Literal["already_exists", "restored", "created"]


class _CriticalAgentConfig:
    def __init__(
        self,
        *,
        name: str,
        description: str,
        system_prompt: str,
        tool_ids_fn: Callable[[Session], list[int]],
    ) -> None:
        self.name = name
        self.description = description
        self.system_prompt = system_prompt
        self.tool_ids_fn = tool_ids_fn


def _default_enabled_tool_ids(db_session: Session) -> list[int]:
    default_assistant = get_default_assistant(db_session)
    if default_assistant is None:
        return []
    return [tool.id for tool in default_assistant.tools if tool.enabled]


def _ensure_kmz_processing_tool(db_session: Session) -> Tool:
    existing_tool = db_session.scalar(
        select(Tool).where(Tool.in_code_tool_id == KMZ_PROCESSING_TOOL_ID)
    )
    if existing_tool:
        return existing_tool

    new_tool = Tool(
        name=KMZ_PROCESSING_TOOL_NAME,
        display_name="KMZ Packet Processor",
        description=(
            "Preprocess packet files for KMZ generation with per-packet output."
        ),
        in_code_tool_id=KMZ_PROCESSING_TOOL_ID,
        enabled=True,
    )
    db_session.add(new_tool)
    db_session.flush()
    return new_tool


def _required_kmz_tool_ids(db_session: Session) -> list[int]:
    tool_ids = set(_default_enabled_tool_ids(db_session))
    kmz_tool = _ensure_kmz_processing_tool(db_session)
    tool_ids.add(kmz_tool.id)

    mcp_tool_ids = db_session.scalars(
        select(Tool.id).where(
            Tool.name.in_(_KMZ_REQUIRED_MCP_TOOL_NAMES),
            Tool.enabled.is_(True),
            Tool.mcp_server_id.is_not(None),
        )
    ).all()
    tool_ids.update(mcp_tool_ids)
    return sorted(tool_ids)


def _find_personas_by_name(db_session: Session, name: str) -> list[Persona]:
    return db_session.scalars(
        select(Persona)
        .where(func.lower(Persona.name) == name.lower())
        .order_by(Persona.id.asc())
    ).all()


def _ensure_persona(
    db_session: Session,
    *,
    name: str,
    description: str,
    system_prompt: str,
    tool_ids_fn: Callable[[Session], list[int]],
) -> tuple[EnsureStatus, bool]:
    matching_personas = _find_personas_by_name(db_session, name)
    active_persona = next((persona for persona in matching_personas if not persona.deleted), None)
    if active_persona:
        return "exists", False

    deleted_persona = next((persona for persona in matching_personas if persona.deleted), None)
    if deleted_persona:
        deleted_persona.deleted = False
        return "restored", True

    upsert_persona(
        user=None,
        name=name,
        description=description,
        llm_model_provider_override=None,
        llm_model_version_override=None,
        starter_messages=None,
        system_prompt=system_prompt,
        task_prompt="",
        datetime_aware=True,
        is_public=True,
        db_session=db_session,
        document_set_ids=[],
        tool_ids=tool_ids_fn(db_session),
        is_visible=True,
        featured=False,
        replace_base_system_prompt=False,
        commit=False,
    )
    return "created", True


def _to_deploy_status(status: EnsureStatus) -> DeployStatus:
    if status == "exists":
        return "already_exists"
    return status


_CRITICAL_AGENT_CONFIGS: dict[CriticalAgentKey, _CriticalAgentConfig] = {
    "design": _CriticalAgentConfig(
        name=DESIGN_AGENT_NAME,
        description=DESIGN_AGENT_DESCRIPTION,
        system_prompt="",
        tool_ids_fn=lambda db_session: _default_enabled_tool_ids(db_session),
    ),
    "kmz": _CriticalAgentConfig(
        name=KMZ_AGENT_NAME,
        description=KMZ_AGENT_DESCRIPTION,
        system_prompt=KMZ_KML_OPERATIONS_GUIDANCE,
        tool_ids_fn=lambda db_session: _required_kmz_tool_ids(db_session),
    ),
}


def deploy_critical_agent(
    db_session: Session, agent: CriticalAgentKey
) -> tuple[str, DeployStatus]:
    """Create or restore a critical agent by key.

    Returns:
    - agent display name
    - status in {"already_exists", "restored", "created"}
    """
    config = _CRITICAL_AGENT_CONFIGS[agent]
    status, changed = _ensure_persona(
        db_session,
        name=config.name,
        description=config.description,
        system_prompt=config.system_prompt,
        tool_ids_fn=config.tool_ids_fn,
    )
    if changed:
        db_session.commit()
        logger.notice("Critical agent deployed: %s (%s)", config.name, status)
    else:
        logger.debug("Critical agent deploy skipped (already exists): %s", config.name)

    return config.name, _to_deploy_status(status)


def ensure_critical_agents(db_session: Session) -> dict[str, EnsureStatus]:
    """Ensure high-priority custom agents exist.

    Guarantees:
    - `Design Agent` exists (restored if soft-deleted, created if missing)
    - `KMZ Agent` exists (restored if soft-deleted, created if missing)
    """
    changed = False

    design_status, design_changed = _ensure_persona(
        db_session,
        name=DESIGN_AGENT_NAME,
        description=DESIGN_AGENT_DESCRIPTION,
        system_prompt="",
        tool_ids_fn=lambda db_session: _default_enabled_tool_ids(db_session),
    )
    changed = changed or design_changed

    kmz_status, kmz_changed = _ensure_persona(
        db_session,
        name=KMZ_AGENT_NAME,
        description=KMZ_AGENT_DESCRIPTION,
        system_prompt=KMZ_KML_OPERATIONS_GUIDANCE,
        tool_ids_fn=lambda db_session: _required_kmz_tool_ids(db_session),
    )
    changed = changed or kmz_changed

    if changed:
        db_session.commit()
        logger.notice(
            "Critical agents self-heal applied: Design Agent=%s, KMZ Agent=%s",
            design_status,
            kmz_status,
        )
    else:
        logger.debug("Critical agents self-heal check: no changes needed.")

    return {
        DESIGN_AGENT_NAME: design_status,
        KMZ_AGENT_NAME: kmz_status,
    }
