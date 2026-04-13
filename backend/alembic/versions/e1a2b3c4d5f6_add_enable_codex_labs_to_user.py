"""add enable_codex_labs to user

Revision ID: e1a2b3c4d5f6
Revises: c7bf5721733e, d4f1e7c2b9a0
Create Date: 2026-04-13 22:15:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "e1a2b3c4d5f6"
down_revision = ("c7bf5721733e", "d4f1e7c2b9a0")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user",
        sa.Column(
            "enable_codex_labs",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.alter_column("user", "enable_codex_labs", server_default=None)


def downgrade() -> None:
    op.drop_column("user", "enable_codex_labs")
