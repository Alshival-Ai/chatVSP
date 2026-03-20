"""add enable_code_interpreter to user

Revision ID: c1a2b3d4e5f6
Revises: 114a638452db
Create Date: 2026-03-20 18:00:00.000000

"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "c1a2b3d4e5f6"
down_revision = "114a638452db"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user",
        sa.Column(
            "enable_code_interpreter",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.alter_column("user", "enable_code_interpreter", server_default=None)


def downgrade() -> None:
    op.drop_column("user", "enable_code_interpreter")
