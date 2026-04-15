import datetime
import uuid
from copy import deepcopy

from fastapi_users.password import PasswordHelper
from sqlalchemy import select
from sqlalchemy.orm import Session

from onyx.auth.api_key import build_displayable_api_key
from onyx.auth.api_key import generate_api_key
from onyx.auth.api_key import hash_api_key
from onyx.auth.schemas import UserRole
from onyx.configs.app_configs import AUTO_REGISTER_LOCAL_MCP_SERVER
from onyx.configs.app_configs import LOCAL_MCP_TOOL_SYNC_ENABLED
from onyx.configs.app_configs import LOCAL_MCP_API_KEY_NAME_PREFIX
from onyx.configs.app_configs import LOCAL_MCP_API_KEY_ROTATION_ENABLED
from onyx.configs.app_configs import LOCAL_MCP_API_KEY_TTL_SECONDS
from onyx.configs.app_configs import LOCAL_MCP_STATIC_API_KEY
from onyx.configs.app_configs import LOCAL_MCP_SERVER_ACTION_NAME
from onyx.configs.app_configs import LOCAL_MCP_SERVER_URL
from onyx.configs.app_configs import MCP_SERVER_ENABLED
from onyx.configs.constants import UNNAMED_KEY_PLACEHOLDER
from onyx.db.enums import MCPAuthenticationPerformer
from onyx.db.enums import MCPServerStatus
from onyx.db.enums import MCPTransport
from onyx.db.mcp import extract_connection_data
from onyx.db.mcp import create_connection_config
from onyx.db.mcp import update_mcp_server__no_commit
from onyx.db.tools import create_tool__no_commit
from onyx.db.tools import delete_tool__no_commit
from onyx.db.tools import get_tools_by_mcp_server_id
from onyx.db.models import ApiKey
from onyx.db.models import MCPAuthenticationType
from onyx.db.models import MCPServer
from onyx.db.models import Tool
from onyx.db.models import User
from onyx.server.features.mcp.models import MCPConnectionData
from onyx.tools.tool_implementations.mcp.mcp_client import discover_mcp_tools
from onyx.utils.logger import setup_logger
from shared_configs.contextvars import get_current_tenant_id

logger = setup_logger()


def _get_api_key_fake_email(name: str, unique_id: str) -> str:
    return f"APIKEY__{name}@{unique_id}.onyxapikey.ai"


def _create_local_mcp_service_api_key__no_commit(
    db_session: Session,
) -> tuple[str, ApiKey]:
    std_password_helper = PasswordHelper()
    tenant_id = get_current_tenant_id()
    api_key_value = generate_api_key(tenant_id)
    api_key_name = (
        f"{LOCAL_MCP_API_KEY_NAME_PREFIX}-"
        f"{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')}"
    )

    api_key_user_id = uuid.uuid4()
    email_name = api_key_name or UNNAMED_KEY_PLACEHOLDER
    api_key_user_row = User(
        id=api_key_user_id,
        email=_get_api_key_fake_email(email_name, str(api_key_user_id)),
        hashed_password=std_password_helper.hash(std_password_helper.generate()),
        is_active=True,
        is_superuser=False,
        is_verified=True,
        role=UserRole.BASIC,
    )
    db_session.add(api_key_user_row)

    api_key_row = ApiKey(
        name=api_key_name,
        hashed_api_key=hash_api_key(api_key_value),
        api_key_display=build_displayable_api_key(api_key_value),
        user_id=api_key_user_id,
        owner_id=None,
    )
    db_session.add(api_key_row)
    db_session.flush()

    return api_key_value, api_key_row


def _prune_expired_local_mcp_service_api_keys__no_commit(db_session: Session) -> int:
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        seconds=LOCAL_MCP_API_KEY_TTL_SECONDS
    )
    old_keys = list(
        db_session.scalars(
            select(ApiKey).where(
                ApiKey.name.like(f"{LOCAL_MCP_API_KEY_NAME_PREFIX}-%"),
                ApiKey.created_at < cutoff,
            )
        ).all()
    )

    deleted = 0
    for api_key_row in old_keys:
        key_user = db_session.scalar(select(User).where(User.id == api_key_row.user_id))
        db_session.delete(api_key_row)
        if key_user:
            db_session.delete(key_user)
        deleted += 1

    return deleted


def _set_mcp_server_admin_bearer_token__no_commit(
    db_session: Session, mcp_server: MCPServer, bearer_token: str
) -> bool:
    """Set/overwrite admin connection config Authorization header for an MCP server."""
    expected_headers = {"Authorization": f"Bearer {bearer_token}"}
    changed = False

    if mcp_server.admin_connection_config is None:
        connection_config = create_connection_config(
            config_data=MCPConnectionData(headers=expected_headers),
            db_session=db_session,
            mcp_server_id=mcp_server.id,
            user_email="",
        )
        mcp_server.admin_connection_config = connection_config
        mcp_server.admin_connection_config_id = connection_config.id
        changed = True
    else:
        config_data = deepcopy(
            extract_connection_data(mcp_server.admin_connection_config, apply_mask=False)
        )
        existing_headers = config_data.get("headers")
        if existing_headers != expected_headers:
            config_data["headers"] = expected_headers
            mcp_server.admin_connection_config.config = config_data  # type: ignore[assignment]
            changed = True

    return changed


def rotate_local_mcp_server_api_key(db_session: Session) -> bool:
    """Rotate local MCP action API key and update MCP admin credentials."""
    if not MCP_SERVER_ENABLED or not AUTO_REGISTER_LOCAL_MCP_SERVER:
        return False

    mcp_server = db_session.scalar(
        select(MCPServer).where(MCPServer.name == LOCAL_MCP_SERVER_ACTION_NAME)
    )
    if not mcp_server:
        logger.warning(
            "Local MCP server '%s' not found; skipping key rotation.",
            LOCAL_MCP_SERVER_ACTION_NAME,
        )
        return False

    # Static mode: keep admin auth pinned to the env key (no API key rotation jobs).
    if LOCAL_MCP_STATIC_API_KEY:
        changed = _set_mcp_server_admin_bearer_token__no_commit(
            db_session=db_session,
            mcp_server=mcp_server,
            bearer_token=LOCAL_MCP_STATIC_API_KEY,
        )
        update_mcp_server__no_commit(
            server_id=mcp_server.id,
            db_session=db_session,
            server_url=LOCAL_MCP_SERVER_URL,
            auth_type=MCPAuthenticationType.API_TOKEN,
            auth_performer=MCPAuthenticationPerformer.ADMIN,
            transport=MCPTransport.STREAMABLE_HTTP,
            status=MCPServerStatus.CONNECTED,
            last_refreshed_at=datetime.datetime.now(datetime.timezone.utc),
        )
        db_session.commit()
        logger.notice(
            "Configured static local MCP API key for '%s'%s.",
            LOCAL_MCP_SERVER_ACTION_NAME,
            " (updated)" if changed else " (already current)",
        )
        return changed

    if not LOCAL_MCP_API_KEY_ROTATION_ENABLED:
        return False

    api_key_value, _ = _create_local_mcp_service_api_key__no_commit(db_session)
    if mcp_server.admin_connection_config is None:
        connection_config = create_connection_config(
            config_data=MCPConnectionData(
                headers={"Authorization": f"Bearer {api_key_value}"}
            ),
            db_session=db_session,
            mcp_server_id=mcp_server.id,
            user_email="",
        )
        mcp_server.admin_connection_config = connection_config
        mcp_server.admin_connection_config_id = connection_config.id
    else:
        config_data = deepcopy(
            extract_connection_data(
                mcp_server.admin_connection_config, apply_mask=False
            )
        )
        config_data["headers"] = {"Authorization": f"Bearer {api_key_value}"}
        mcp_server.admin_connection_config.config = config_data  # type: ignore[assignment]

    update_mcp_server__no_commit(
        server_id=mcp_server.id,
        db_session=db_session,
        server_url=LOCAL_MCP_SERVER_URL,
        auth_type=MCPAuthenticationType.API_TOKEN,
        auth_performer=MCPAuthenticationPerformer.ADMIN,
        transport=MCPTransport.STREAMABLE_HTTP,
        status=MCPServerStatus.CONNECTED,
        last_refreshed_at=datetime.datetime.now(datetime.timezone.utc),
    )

    pruned = _prune_expired_local_mcp_service_api_keys__no_commit(db_session)
    db_session.commit()
    logger.notice(
        "Rotated local MCP API key for '%s'; pruned %s expired key(s).",
        LOCAL_MCP_SERVER_ACTION_NAME,
        pruned,
    )
    return True


def sync_local_mcp_server_tools(db_session: Session) -> bool:
    """Discover and sync local MCP server tools into the DB."""
    if (
        not MCP_SERVER_ENABLED
        or not AUTO_REGISTER_LOCAL_MCP_SERVER
        or not LOCAL_MCP_TOOL_SYNC_ENABLED
    ):
        return False

    mcp_server = db_session.scalar(
        select(MCPServer).where(MCPServer.name == LOCAL_MCP_SERVER_ACTION_NAME)
    )
    if not mcp_server:
        logger.warning(
            "Local MCP server '%s' not found; skipping tool sync.",
            LOCAL_MCP_SERVER_ACTION_NAME,
        )
        return False

    def _headers_for_server(server: MCPServer) -> dict[str, str]:
        headers: dict[str, str] = {}
        if server.admin_connection_config is not None:
            config_data = extract_connection_data(
                server.admin_connection_config, apply_mask=False
            )
            headers.update(config_data.get("headers", {}))
        return headers

    def _is_likely_auth_failure(exc: Exception) -> bool:
        message = str(exc).lower()
        auth_indicators = (
            "401",
            "403",
            "unauthorized",
            "forbidden",
            "invalid_token",
            "invalid token",
            "authentication",
            "access denied",
        )
        return any(indicator in message for indicator in auth_indicators)

    headers = _headers_for_server(mcp_server)
    discovered_tools = None
    sync_exception: Exception | None = None

    try:
        discovered_tools = discover_mcp_tools(
            server_url=mcp_server.server_url,
            connection_headers=headers,
            transport=mcp_server.transport or MCPTransport.STREAMABLE_HTTP,
            auth=None,
        )
    except Exception as first_exc:
        sync_exception = first_exc
        if _is_likely_auth_failure(first_exc):
            logger.warning(
                "Local MCP tool sync failed with likely auth error for '%s'; "
                "rotating key and retrying once.",
                LOCAL_MCP_SERVER_ACTION_NAME,
            )
            rotated = rotate_local_mcp_server_api_key(db_session)
            if rotated:
                refreshed_server = db_session.scalar(
                    select(MCPServer).where(MCPServer.id == mcp_server.id)
                )
                if refreshed_server:
                    mcp_server = refreshed_server
                headers = _headers_for_server(mcp_server)
                try:
                    discovered_tools = discover_mcp_tools(
                        server_url=mcp_server.server_url,
                        connection_headers=headers,
                        transport=mcp_server.transport or MCPTransport.STREAMABLE_HTTP,
                        auth=None,
                    )
                    sync_exception = None
                except Exception as retry_exc:
                    sync_exception = retry_exc
            else:
                logger.warning(
                    "Automatic local MCP key rotation was skipped for '%s'; "
                    "marking server as awaiting auth.",
                    LOCAL_MCP_SERVER_ACTION_NAME,
                )

    if discovered_tools is None:
        update_mcp_server__no_commit(
            server_id=mcp_server.id,
            db_session=db_session,
            status=MCPServerStatus.AWAITING_AUTH,
        )
        db_session.commit()
        logger.exception(
            "Failed to sync local MCP tools for '%s'",
            LOCAL_MCP_SERVER_ACTION_NAME,
            exc_info=sync_exception,
        )
        return False

    existing_tools = get_tools_by_mcp_server_id(mcp_server.id, db_session)
    existing_by_name = {tool.name: tool for tool in existing_tools}
    processed_names: set[str] = set()
    db_dirty = False

    for tool in discovered_tools:
        tool_name = tool.name
        if not tool_name:
            continue

        processed_names.add(tool_name)
        description = tool.description or ""
        annotations_title = tool.annotations.title if tool.annotations else None
        display_name = tool.title or annotations_title or tool_name
        input_schema = tool.inputSchema

        existing_tool: Tool | None = existing_by_name.get(tool_name)
        if existing_tool:
            if existing_tool.description != description:
                existing_tool.description = description
                db_dirty = True
            if existing_tool.display_name != display_name:
                existing_tool.display_name = display_name
                db_dirty = True
            if existing_tool.mcp_input_schema != input_schema:
                existing_tool.mcp_input_schema = input_schema
                db_dirty = True
            continue

        new_tool = create_tool__no_commit(
            name=tool_name,
            description=description,
            openapi_schema=None,
            custom_headers=None,
            user_id=None,
            db_session=db_session,
            passthrough_auth=False,
            mcp_server_id=mcp_server.id,
            enabled=True,
        )
        new_tool.display_name = display_name
        new_tool.mcp_input_schema = input_schema
        db_dirty = True

    for name, existing_tool in existing_by_name.items():
        if name not in processed_names:
            delete_tool__no_commit(existing_tool.id, db_session)
            db_dirty = True

    update_mcp_server__no_commit(
        server_id=mcp_server.id,
        db_session=db_session,
        status=MCPServerStatus.CONNECTED,
        last_refreshed_at=datetime.datetime.now(datetime.timezone.utc),
    )
    db_session.commit()

    logger.notice(
        "Synced %s MCP tools for '%s'%s.",
        len(discovered_tools),
        LOCAL_MCP_SERVER_ACTION_NAME,
        " (DB updated)" if db_dirty else " (no DB changes)",
    )
    return db_dirty
