from __future__ import annotations

import os
import re
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from onyx.db.llm import fetch_default_llm_model
from onyx.db.models import LLMProvider
from onyx.llm.constants import LlmProviderNames
from onyx.utils.logger import setup_logger

logger = setup_logger()

CODEX_CONFIG_DIR_NAME = ".codex"
CODEX_CONFIG_FILE_NAME = "config.toml"
OPENAI_ENV_KEY_NAME = "OPENAI_API_KEY"
ANTHROPIC_ENV_KEY_NAME = "ANTHROPIC_API_KEY"
OPENAI_STANDARD_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OPENAI_CODEX_MODEL = "gpt-5.4"

# Use both names for compatibility with existing configs/scripts.
NEURAL_LABS_MCP_BEARER_TOKEN_ENV_VAR = "NEURAL_LABS_MCP_BEARER_TOKEN"
WARDGPT_MCP_BEARER_TOKEN_ENV_VAR = "WARDGPT_MCP_BEARER_TOKEN"

MCP_SERVER_URL_ENV_KEYS = (
    "NEURAL_LABS_MCP_SERVER_URL",
    "LOCAL_MCP_SERVER_URL",
    "MCP_SERVER_URL",
)
DEFAULT_MCP_SERVER_URL = "http://api_server:8080/mcp"

SHELL_BASHRC_FILENAME = ".bashrc"
SHELL_BASH_PROFILE_FILENAME = ".bash_profile"
SHELL_BANNER_BLOCK_START = "# >>> neural-labs-banner >>>"
SHELL_BANNER_BLOCK_END = "# <<< neural-labs-banner <<<"
SHELL_BASH_PROFILE_BLOCK_START = "# >>> neural-labs-bash-profile >>>"
SHELL_BASH_PROFILE_BLOCK_END = "# <<< neural-labs-bash-profile <<<"
SHELL_BANNER_ENV_VAR = "NEURAL_LABS_BANNER_SHOWN"


def provision_neural_labs_home(home_dir: Path, db_session: Session) -> dict[str, str]:
    """Provision managed Neural Labs files and return shell env overrides."""
    _provision_shell_profile_banner(home_dir=home_dir)
    _provision_bash_profile(home_dir=home_dir)

    model_name, openai_api_key = _resolve_openai_codex_settings(db_session)
    if not openai_api_key:
        return {}

    mcp_server_url = _resolve_mcp_server_url()
    config_text = _build_codex_config_toml(
        model_name=model_name,
        mcp_server_url=mcp_server_url,
    )
    codex_dir = home_dir / CODEX_CONFIG_DIR_NAME
    codex_dir.mkdir(parents=True, exist_ok=True)
    (codex_dir / CODEX_CONFIG_FILE_NAME).write_text(config_text, encoding="utf-8")

    env_overrides = {OPENAI_ENV_KEY_NAME: openai_api_key}
    anthropic_api_key = _resolve_anthropic_api_key(db_session)
    if anthropic_api_key:
        env_overrides[ANTHROPIC_ENV_KEY_NAME] = anthropic_api_key
    return env_overrides


def _resolve_mcp_server_url() -> str | None:
    for key in MCP_SERVER_URL_ENV_KEYS:
        value = os.environ.get(key, "").strip()
        if value:
            return value

    # Keep this deterministic in compose environments where api_server is resolvable.
    return DEFAULT_MCP_SERVER_URL


def _resolve_openai_codex_settings(db_session: Session) -> tuple[str, str | None]:
    """Resolve OpenAI model+credentials from Onyx LLM provider settings."""
    provider = _fetch_openai_provider(db_session)
    if not provider:
        logger.warning(
            "Neural Labs OpenAI bootstrap skipped because no OpenAI provider is configured."
        )
        return DEFAULT_OPENAI_CODEX_MODEL, None

    api_key = provider.api_key.get_value(apply_mask=False) if provider.api_key else None
    if not api_key:
        logger.warning(
            "Neural Labs OpenAI bootstrap skipped because the OpenAI provider has no API key."
        )
        return DEFAULT_OPENAI_CODEX_MODEL, None

    default_model = fetch_default_llm_model(db_session)
    if default_model and default_model.llm_provider.provider == str(LlmProviderNames.OPENAI):
        default_name = (default_model.name or "").strip()
        if default_name:
            return default_name, api_key

    visible_models = [m.name for m in provider.model_configurations if m.is_visible and m.name]
    if visible_models:
        return visible_models[0], api_key

    if provider.model_configurations and provider.model_configurations[0].name:
        return provider.model_configurations[0].name, api_key

    return DEFAULT_OPENAI_CODEX_MODEL, api_key


def _fetch_openai_provider(db_session: Session) -> LLMProvider | None:
    build_mode_name = "build-mode-openai"
    provider = db_session.scalar(
        select(LLMProvider).where(LLMProvider.name == build_mode_name)
    )
    if provider:
        return provider

    return db_session.scalar(
        select(LLMProvider).where(LLMProvider.provider == str(LlmProviderNames.OPENAI))
    )


def _resolve_anthropic_api_key(db_session: Session) -> str | None:
    provider = _fetch_provider_by_type(
        db_session=db_session, provider_type=str(LlmProviderNames.ANTHROPIC)
    )
    if not provider or not provider.api_key:
        return None
    return provider.api_key.get_value(apply_mask=False)


def _fetch_provider_by_type(db_session: Session, provider_type: str) -> LLMProvider | None:
    build_mode_name = f"build-mode-{provider_type}"
    provider = db_session.scalar(select(LLMProvider).where(LLMProvider.name == build_mode_name))
    if provider:
        return provider
    return db_session.scalar(
        select(LLMProvider).where(LLMProvider.provider == provider_type)
    )


def _build_codex_config_toml(model_name: str, mcp_server_url: str | None) -> str:
    lines = [
        "# Managed by Neural Labs. Manual edits may be overwritten.",
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        "",
        f"model = {_toml_quote(model_name)}",
        'model_provider = "openai-custom"',
        'model_reasoning_effort = "medium"',
        "",
        "[model_providers.openai-custom]",
        'name = "OpenAI (Neural Labs)"',
        f"base_url = {_toml_quote(OPENAI_STANDARD_BASE_URL)}",
        f"env_key = {_toml_quote(OPENAI_ENV_KEY_NAME)}",
        'wire_api = "responses"',
        "",
    ]

    if mcp_server_url:
        lines.extend(
            [
                "[mcp_servers.onyx]",
                f"url = {_toml_quote(mcp_server_url)}",
                (
                    "bearer_token_env_var = "
                    f"{_toml_quote(NEURAL_LABS_MCP_BEARER_TOKEN_ENV_VAR)}"
                ),
                "",
                "[mcp_servers.wardgpt]",
                f"url = {_toml_quote(mcp_server_url)}",
                (
                    "bearer_token_env_var = "
                    f"{_toml_quote(WARDGPT_MCP_BEARER_TOKEN_ENV_VAR)}"
                ),
                "",
            ]
        )

    return "\n".join(lines).rstrip() + "\n"


def _provision_shell_profile_banner(home_dir: Path) -> None:
    bashrc_path = home_dir / SHELL_BASHRC_FILENAME
    managed_block = _build_shell_banner_block()
    try:
        existing = bashrc_path.read_text(encoding="utf-8") if bashrc_path.exists() else ""
    except OSError:
        logger.exception("Neural Labs failed reading shell profile: %s", bashrc_path)
        return

    next_text = _upsert_managed_block(
        existing_text=existing,
        managed_block=managed_block,
        block_start=SHELL_BANNER_BLOCK_START,
        block_end=SHELL_BANNER_BLOCK_END,
    )
    if next_text == existing:
        return

    try:
        bashrc_path.write_text(next_text, encoding="utf-8")
    except OSError:
        logger.exception("Neural Labs failed writing shell profile: %s", bashrc_path)


def _provision_bash_profile(home_dir: Path) -> None:
    bash_profile_path = home_dir / SHELL_BASH_PROFILE_FILENAME
    managed_block = _build_bash_profile_block()
    try:
        existing = (
            bash_profile_path.read_text(encoding="utf-8")
            if bash_profile_path.exists()
            else ""
        )
    except OSError:
        logger.exception(
            "Neural Labs failed reading login shell profile: %s", bash_profile_path
        )
        return

    next_text = _upsert_managed_block(
        existing_text=existing,
        managed_block=managed_block,
        block_start=SHELL_BASH_PROFILE_BLOCK_START,
        block_end=SHELL_BASH_PROFILE_BLOCK_END,
    )
    if next_text == existing:
        return

    try:
        bash_profile_path.write_text(next_text, encoding="utf-8")
    except OSError:
        logger.exception(
            "Neural Labs failed writing login shell profile: %s", bash_profile_path
        )


def _upsert_managed_block(
    *,
    existing_text: str,
    managed_block: str,
    block_start: str,
    block_end: str,
) -> str:
    block_pattern = re.compile(
        rf"{re.escape(block_start)}\n.*?{re.escape(block_end)}\n?",
        flags=re.DOTALL,
    )
    if block_pattern.search(existing_text):
        return block_pattern.sub(managed_block, existing_text, count=1)

    trimmed = existing_text.rstrip("\n")
    if not trimmed:
        return managed_block
    return f"{trimmed}\n\n{managed_block}"


def _build_shell_banner_block() -> str:
    banner = (
        "\n"
        " ███╗   ██╗███████╗██╗   ██╗██████╗  █████╗ ██╗         ██╗      █████╗ ██████╗ ███████╗\n"
        " ████╗  ██║██╔════╝██║   ██║██╔══██╗██╔══██╗██║         ██║     ██╔══██╗██╔══██╗██╔════╝\n"
        " ██╔██╗ ██║█████╗  ██║   ██║██████╔╝███████║██║         ██║     ███████║██████╔╝███████╗\n"
        " ██║╚██╗██║██╔══╝  ██║   ██║██╔══██╗██╔══██║██║         ██║     ██╔══██║██╔══██╗╚════██║\n"
        " ██║ ╚████║███████╗╚██████╔╝██║  ██║██║  ██║███████╗    ███████╗██║  ██║██████╔╝███████║\n"
        " ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝    ╚══════╝╚═╝  ╚═╝╚═════╝ ╚══════╝\n"
        "\n"
        "             >> environment initialized <<\n"
        "\n"
    )
    lines = [
        SHELL_BANNER_BLOCK_START,
        f'if [[ $- == *i* ]] && [[ -z "${{{SHELL_BANNER_ENV_VAR}:-}}" ]]; then',
        f"  export {SHELL_BANNER_ENV_VAR}=1",
        "  cat <<'NEURAL_LABS_BANNER'",
        *banner.splitlines(),
        "NEURAL_LABS_BANNER",
        "fi",
        SHELL_BANNER_BLOCK_END,
        "",
    ]
    return "\n".join(lines)


def _build_bash_profile_block() -> str:
    lines = [
        SHELL_BASH_PROFILE_BLOCK_START,
        'if [ -f "$HOME/.bashrc" ]; then',
        '  . "$HOME/.bashrc"',
        "fi",
        SHELL_BASH_PROFILE_BLOCK_END,
        "",
    ]
    return "\n".join(lines)


def _toml_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'
