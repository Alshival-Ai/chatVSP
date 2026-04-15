"""add enable_onyx_craft to user

Revision ID: f2a3b4c5d6e7
Revises: e1d2c3b4a5f6
Create Date: 2026-03-10 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "f2a3b4c5d6e7"
down_revision = "e1d2c3b4a5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user",
        sa.Column(
            "enable_onyx_craft",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("user", "enable_onyx_craft")
