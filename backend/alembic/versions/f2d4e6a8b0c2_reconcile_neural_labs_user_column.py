"""reconcile neural labs user column naming

Revision ID: f2d4e6a8b0c2
Revises: e1a2b3c4d5f6
Create Date: 2026-04-14 17:00:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "f2d4e6a8b0c2"
down_revision = "e1a2b3c4d5f6"
branch_labels = None
depends_on = None


def _has_column(bind: sa.Connection, table_name: str, column_name: str) -> bool:
    inspector = sa.inspect(bind)
    return any(
        col.get("name") == column_name for col in inspector.get_columns(table_name)
    )


def upgrade() -> None:
    bind = op.get_bind()
    has_old = _has_column(bind, "user", "enable_codex_labs")
    has_new = _has_column(bind, "user", "enable_neural_labs")

    if not has_new:
        op.add_column(
            "user",
            sa.Column(
                "enable_neural_labs",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )

    if has_old:
        op.execute(
            sa.text(
                'UPDATE "user" SET enable_neural_labs = enable_codex_labs '
                "WHERE enable_codex_labs IS NOT NULL"
            )
        )

    op.alter_column("user", "enable_neural_labs", server_default=None)


def downgrade() -> None:
    bind = op.get_bind()
    if not _has_column(bind, "user", "enable_codex_labs"):
        op.add_column(
            "user",
            sa.Column(
                "enable_codex_labs",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )

    op.execute(
        sa.text(
            'UPDATE "user" SET enable_codex_labs = enable_neural_labs '
            "WHERE enable_neural_labs IS NOT NULL"
        )
    )
    op.alter_column("user", "enable_codex_labs", server_default=None)
