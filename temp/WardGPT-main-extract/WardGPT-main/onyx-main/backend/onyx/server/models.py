from typing import Generic
from typing import Optional
from typing import TypeVar
from uuid import UUID

from pydantic import BaseModel

from onyx.auth.schemas import UserRole
from onyx.db.models import User
from onyx.server.features.build.configs import ENABLE_CODEX_LABS
from onyx.server.features.build.configs import ENABLE_CRAFT


DataT = TypeVar("DataT")


class StatusResponse(BaseModel, Generic[DataT]):
    success: bool
    message: Optional[str] = None
    data: Optional[DataT] = None


class ApiKey(BaseModel):
    api_key: str


class IdReturn(BaseModel):
    id: int


class MinimalUserSnapshot(BaseModel):
    id: UUID
    email: str


class FullUserSnapshot(BaseModel):
    id: UUID
    email: str
    role: UserRole
    is_active: bool
    password_configured: bool
    enable_code_interpreter: bool
    enable_onyx_craft: bool
    enable_codex_labs: bool

    @classmethod
    def from_user_model(cls, user: User) -> "FullUserSnapshot":
        return cls(
            id=user.id,
            email=user.email,
            role=user.role,
            is_active=user.is_active,
            password_configured=user.password_configured,
            enable_code_interpreter=user.enable_code_interpreter,
            enable_onyx_craft=(user.enable_onyx_craft if ENABLE_CRAFT else False),
            enable_codex_labs=(
                user.enable_codex_labs if ENABLE_CODEX_LABS else False
            ),
        )


class DisplayPriorityRequest(BaseModel):
    display_priority_map: dict[int, int]


class InvitedUserSnapshot(BaseModel):
    email: str
