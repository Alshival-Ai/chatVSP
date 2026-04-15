"""add enable_code_interpreter to user

Revision ID: e1d2c3b4a5f6
Revises: a3b8d9e2f1c4
Create Date: 2026-03-10 00:00:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "e1d2c3b4a5f6"
down_revision = "a3b8d9e2f1c4"
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


def downgrade() -> None:
    op.drop_column("user", "enable_code_interpreter")
