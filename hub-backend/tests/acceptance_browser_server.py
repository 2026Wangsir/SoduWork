"""Disposable acceptance scenarios using production HTTP routers and isolated storage."""
from tests.unified_requirements_browser_server import app, fixture
from app.api import approvals, delivery, trace
from app.services import delivery_manifest

app.include_router(approvals.router)
app.include_router(delivery.router)
app.include_router(trace.router)


@app.post('/e2e/acceptance-seed')
async def seed():
    async with fixture.sessions() as session:
        for task_id, state in [('empty-delivery', 'completed'), ('live-turn', 'running'),
                               ('revised-delivery', 'completed'), ('multiple-deliverables', 'completed')]:
            session.add(fixture.models.Task(id=task_id, title='验收回归 ' + task_id,
                status='doing', triage_stage='ready', created_by='sender',
                assignee_user_id='recipient', owner_client_id='e2e-recipient', owner_user_id='recipient',
                acceptance_criteria=['结果符合需求'], work_routing={
                    'executionSubmissionMode': 'auto', 'outputContract': {'expectedArtifacts': ['final.html']},
                    'conversationTurn': {'conversationId': task_id, 'turnId': 'revision-2', 'state': state}}))
        for version, name, data in [(1, 'report.md', b'# Old result'),
                                    (2, 'report.html', b'<!doctype html><html><body>Final result</body></html>')]:
            key = 'acceptance/' + name
            mime = 'text/html' if version == 2 else 'text/markdown'
            backend = fixture.storage.put(key, data, mime)
            session.add(fixture.models.Attachment(id='revision-' + str(version), task_id='revised-delivery',
                filename=name, role='output', content_type=mime, size=len(data), storage_key=key,
                backend=backend, source_ref='conversation:revised-delivery', uploaded_by='agent:conversation',
                evidence_meta={'round': version, 'verification': delivery_manifest.validate_bytes(name, data, mime)}))
        import hashlib
        for aid, name, data, role, version in [
            ('old-output', 'old.md', b'Old draft', 'output', 1),
            ('site-html', 'index.html', b'<html><head><link href="assets/style.css" rel="stylesheet"></head><body>Final site</body></html>', 'output', 2),
            ('site-css', 'assets/style.css', b'body{color:purple}', 'output', 2),
            ('site-doc', 'README.md', b'# Final site\nOpen index.html.', 'output', 2),
            ('site-notes', 'handoff.txt', b'Final site delivery notes.', 'output', 2),
            ('verify-shot', 'final-hero.png', b'Optional evidence', 'verification', 2),
            ('input-spec', 'brief.md', b'Reference only', 'input', 0),
        ]:
            key = 'acceptance/multi/' + name
            mime = 'text/html' if name.endswith('.html') else 'text/plain'
            session.add(fixture.models.Attachment(id=aid, task_id='multiple-deliverables', filename=name,
                role=role, content_type=mime, size=len(data), storage_key=key,
                backend=fixture.storage.put(key, data, mime), source_ref='conversation:multiple-deliverables',
                uploaded_by='agent:conversation' if role != 'input' else 'e2e-sender',
                evidence_meta={'round':version, 'sha256':hashlib.sha256(data).hexdigest(), 'verification':{'state':'passed'}}))
        await session.commit()
    return {'ok': True}
