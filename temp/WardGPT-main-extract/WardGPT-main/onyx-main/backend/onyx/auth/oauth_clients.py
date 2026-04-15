from typing import cast

import httpx
from httpx_oauth.clients.openid import OpenID


MICROSOFT_GRAPH_ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName"
MICROSOFT_OPENID_DEFAULT_SCOPES = [
    "openid",
    "email",
    "profile",
    "offline_access",
    "User.Read",
]


class MicrosoftOpenID(OpenID):
    """OpenID client backed by Microsoft Entra with Graph identity fallback."""

    def __init__(self, client_id: str, client_secret: str, tenant_id: str) -> None:
        openid_config_url = (
            f"https://login.microsoftonline.com/{tenant_id}/v2.0/.well-known/openid-configuration"
        )
        super().__init__(
            client_id,
            client_secret,
            openid_config_url,
            base_scopes=MICROSOFT_OPENID_DEFAULT_SCOPES,
        )

    async def get_id_email(self, token: str) -> tuple[str | None, str | None]:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                MICROSOFT_GRAPH_ME_ENDPOINT,
                headers={"Authorization": f"Bearer {token}"},
            )
            response.raise_for_status()
            user_info = cast(dict[str, str], response.json())

        email = user_info.get("mail") or user_info.get("userPrincipalName")
        return user_info.get("id"), email
