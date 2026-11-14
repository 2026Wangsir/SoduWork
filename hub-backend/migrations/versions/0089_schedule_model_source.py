"""Persist whether an automation model is Hub-managed or desktop-owned."""
from alembic import op
import copy
import sqlalchemy as sa

revision = "0089_schedule_model_source"
down_revision = "0088_schedule_requirement_source"
branch_labels = None
depends_on = None


def _local_reference(value):
    model = str(value or "").strip()
    if model.startswith("local:"):
        return True
    if not model.startswith("image::"):
        return False
    provider, separator, name = model[len("image::"):].partition("::")
    return bool(separator and provider.strip() and name.strip().startswith("local:"))


def scrub_schedule_models(connection):
    schedules = sa.table("ai_schedule", sa.column("id", sa.String),
                         sa.column("model_name", sa.String), sa.column("model_source", sa.String))
    rows = connection.execute(sa.select(schedules.c.id, schedules.c.model_name)).mappings()
    while batch := rows.fetchmany(200):
        for row in batch:
            if _local_reference(row["model_name"]):
                connection.execute(schedules.update().where(schedules.c.id == row["id"]).values(
                    model_source="device", model_name=""))


def scrub_receipts(connection):
    """Remove historical desktop references without rewriting unrelated receipt data."""
    model_keys = {"modelName", "model", "modelRef", "modelId", "localModel"}
    envelopes = {"route", "requested", "resolved", "conversationInput", "selection",
                 "activeExecutionSelection", "acceptedSelection", "contextSegments"}

    def clean(value, inherited=False):
        if isinstance(value, dict):
            source = str(value.get("modelSource") or "").strip().lower()
            local = (source == "device" or value.get("localOnly") is True or
                     value.get("modelLocalOnly") is True or inherited and source != "managed")
            result = {key: copy.deepcopy(item) if key in {"pluginInputs", "arguments"} else
                      clean(item, local and key in envelopes) for key, item in value.items()}
            for key in model_keys:
                if key in result and (local or _local_reference(result[key])):
                    result[key] = ""
                    result["modelSource"] = "device"
            return result
        if isinstance(value, list):
            return [clean(item, inherited) for item in value]
        return value

    runs = sa.table("ai_schedule_run", sa.column("id", sa.String), sa.column("receipt", sa.JSON))
    rows = connection.execute(sa.select(runs.c.id, runs.c.receipt)).mappings()
    while batch := rows.fetchmany(200):
        for row in batch:
            receipt = clean(row["receipt"])
            if receipt != row["receipt"]:
                connection.execute(runs.update().where(runs.c.id == row["id"]).values(receipt=receipt))


def upgrade():
    op.add_column(
        "ai_schedule",
        sa.Column("model_source", sa.String(length=16), nullable=False,
                  server_default="managed"),
    )
    # Historical clients occasionally persisted a desktop-only reference in
    # model_name. Retain only the non-sensitive source marker and fail closed
    # until the owning desktop saves a fresh encrypted mapping.
    scrub_schedule_models(op.get_bind())
    scrub_receipts(op.get_bind())


def downgrade():
    op.drop_column("ai_schedule", "model_source")
