"""add theme specific chat backgrounds

Revision ID: a7c9e4b2f1d3
Revises: 689433b0d8de
Create Date: 2026-03-20 19:50:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "a7c9e4b2f1d3"
down_revision = "689433b0d8de"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user",
        sa.Column("light_chat_background", sa.String(), nullable=True),
    )
    op.add_column(
        "user",
        sa.Column("dark_chat_background", sa.String(), nullable=True),
    )
    op.execute(
        sa.text(
            """
            UPDATE "user"
            SET
                light_chat_background = chat_background,
                dark_chat_background = chat_background
            WHERE chat_background IS NOT NULL
            """
        )
    )


def downgrade() -> None:
    op.drop_column("user", "dark_chat_background")
    op.drop_column("user", "light_chat_background")
