"""Retain requirement provenance without linking or changing the source task."""
from alembic import op
import sqlalchemy as sa

revision = "0088_schedule_requirement_source"
down_revision = "0086_usage_quota_scope"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ai_schedule", sa.Column("source_requirement", sa.JSON(), nullable=False, server_default="{}"))


def downgrade():
    op.drop_column("ai_schedule", "source_requirement")
