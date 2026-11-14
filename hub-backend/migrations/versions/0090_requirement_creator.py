"""Recover missing requirement creators only from consistent migrated provenance."""
from alembic import op
import sqlalchemy as sa

revision = "0090_requirement_creator"
down_revision = "0089_schedule_model_source"
branch_labels = None
depends_on = None


def _proven_source(task):
    sources = task["legacy_requirements"]
    if not isinstance(sources, list) or not sources:
        return None
    creator, ids = None, set()
    for source in sources:
        if not isinstance(source, dict):
            return None
        sid, uid = source.get("id"), source.get("created_by_user_id")
        if (not isinstance(sid, str) or not sid or sid != sid.strip() or sid in ids or
                not isinstance(uid, str) or not uid or uid != uid.strip() or
                source.get("delivery_task_id") != task["id"] or
                (source.get("org_id") or None) != (task["shared_org_id"] or None)):
            return None
        if creator is not None and creator != uid:
            return None
        creator = uid
        ids.add(sid)
    return creator, ids


def migrate_data(connection):
    """Repair the linked-delivery branch of 0053 without inferring an author."""
    if connection.dialect.name == "postgresql":
        connection.execute(sa.text(
            "LOCK TABLE task, task_requirement_access, app_user IN SHARE ROW EXCLUSIVE MODE"))
    metadata = sa.MetaData()
    tasks = sa.Table("task", metadata, autoload_with=connection)
    access = sa.Table("task_requirement_access", metadata, autoload_with=connection)
    users = sa.Table("app_user", metadata, autoload_with=connection)
    missing = sa.or_(tasks.c.created_by.is_(None), sa.func.trim(tasks.c.created_by) == "")
    rows = connection.execute(sa.select(tasks.c.id, tasks.c.created_by,
        tasks.c.legacy_requirements, tasks.c.shared_org_id).where(missing)).mappings()
    restored = 0
    while batch := rows.fetchmany(200):
        for task in batch:
            proven = _proven_source(task)
            if proven is None:
                continue
            creator, source_ids = proven
            user = connection.execute(sa.select(users.c.id, users.c.display_name, users.c.username).where(
                users.c.id == creator, users.c.is_active.is_(True), users.c.account_deleted_at.is_(None)
            )).mappings().one_or_none()
            if user is None:
                continue
            grants = {}
            for row in connection.execute(sa.select(access.c.source_id, access.c.principal_id).where(
                access.c.task_id == task["id"], access.c.principal_kind == "user", access.c.role == "creator"
            )).mappings():
                grants.setdefault(row["source_id"], set()).add(row["principal_id"])
            if set(grants) != source_ids or any(grants.get(sid) != {creator} for sid in source_ids):
                continue
            # Immutable source authorship and its independently stored creator
            # grants must agree. Device ownership and execution never prove authorship.
            result = connection.execute(tasks.update().where(tasks.c.id == task["id"], missing).values(
                created_by=creator, created_by_name=user["display_name"] or user["username"]))
            restored += result.rowcount
    return restored


def upgrade():
    migrate_data(op.get_bind())


def downgrade():
    # Proven authorship is retained; erasing it could strand later review records.
    pass
