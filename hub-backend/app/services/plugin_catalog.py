"""Employee plugin catalog read model, including publisher review feedback."""
from __future__ import annotations

from . import plugin_application_mcp

from datetime import datetime, timezone
from types import SimpleNamespace
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import product_brand
from . import plugin_covers
from . import (mcp_servers, plugin_audience, plugin_compat,
               plugin_identity, plugin_installations, plugin_marketplace,
               plugin_packages, plugin_input_contracts,
               plugin_setup_contracts, plugin_ui_contracts, plugin_icons,
               plugin_platforms, plugin_window_contracts)


def _ms(dt):
    from .release_control import _ms as stamp
    return stamp(dt)

def _version_key(row: am.PluginVersion) -> tuple:
    """Select the newest immutable plugin version deterministically by SemVer."""
    value = str(row.version or "0.0.0").strip()
    without_build = value.split("+", 1)[0]
    base, has_pre, prerelease = without_build.partition("-")
    try:
        major, minor, patch = (int(item) for item in base.split(".", 2))
    except (TypeError, ValueError):
        major, minor, patch = (0, 0, 0)
    pre_key = tuple(
        (0, int(item)) if item.isdigit() else (1, item.lower())
        for item in prerelease.split(".") if item
    )
    return (
        major, minor, patch, 0 if has_pre else 1, pre_key,
        str(row.created_at or ""), str(row.id or ""),
    )


def _submitted_version_key(version: am.PluginVersion) -> tuple:
    # Preserve submission history; coarse DB timestamps must not let random IDs
    # put an older semantic version ahead of a just-submitted improvement.
    created = version.created_at or datetime.min.replace(tzinfo=timezone.utc)
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return created, _version_key(version)



def _provenance(version: am.PluginVersion) -> dict:
    row = dict(version.provenance or {})
    return {
        "publisherName": product_brand.publisher_display(row)[:120],
        "publisherType": str(row.get("publisherType") or "member")[:24],
        "channel": str(row.get("channel") or "unknown")[:32],
        "sourceKind": str(row.get("sourceKind") or "")[:24],
        "checksum": str(row.get("checksum") or version.checksum or "")[:64],
        "signatureState": str(row.get("signatureState") or "unsigned")[:24],
        "signatureKeyId": str(row.get("signatureKeyId") or "")[:64],
        "signatureFingerprint": str(row.get("signatureFingerprint") or "")[:64],
    }


def _public_inputs(manifest: dict) -> list[dict]:
    """Return only governed, non-secret fields safe for employee clients."""
    try:
        return plugin_input_contracts.normalize(manifest.get("inputs"))
    except ValueError:
        # A malformed legacy package must not take down the whole catalog.
        return []


def _public_setup(manifest: dict) -> dict:
    """Return only typed non-secret installation preferences."""
    try:
        return plugin_setup_contracts.normalize(manifest.get("setup"))
    except ValueError:
        return {"title": "", "description": "", "preferences": []}


def _public_ui(manifest: dict) -> dict:
    """Only the declarative, validated UI manifest reaches employee clients."""
    return plugin_ui_contracts.public(
        manifest.get("ui"), _public_setup(manifest))


def _public_platforms(report: dict, manifest: dict, plugin_key: str = "") -> list[str]:
    """Expose declarations only; never expose a user's platform credentials."""
    raw = report.get("platforms")
    if raw is None:
        raw = dict(manifest.get("capabilities") or {}).get("platforms")
    # 1.0.0--1.0.4 official platform packs predate the explicit declaration;
    # retain their reserved-key behavior while requiring declarations for all
    # newly published shared plugins.
    if raw is None and plugin_key in plugin_platforms.PROVIDERS:
        raw = [plugin_key]
    try:
        return plugin_platforms.normalize(raw)
    except ValueError:
        # A legacy malformed report must not make the entire employee catalog
        # unusable. The package parser rejects this for new versions.
        return []


def _conversation_use(item: dict, dependency: dict) -> dict:
    """One catalog truth for whether an employee may use a plugin in chat.

    The renderer may improve the project-required state when the conversation
    already owns a concrete project id. Every other blocker is authoritative
    and is checked again by plugin_conversation.resolve at send time.
    """
    entrypoints = dict(item.get("entrypoints") or {})
    policy = dict(item.get("marketPolicy") or {})
    missing_mcp = list(dependency.get("missingMcp") or [])
    if entrypoints.get("conversation", True) is False:
        return {"available": False, "code": "entrypoint_disabled",
                "label": "\u4ec5需求\u6216\u81ea\u52a8\u5316"}
    if policy.get("installation") == plugin_marketplace.NOT_AVAILABLE:
        return {"available": False, "code": "task_only",
                "label": "需求\u4e13\u7528"}
    if not item.get("installed"):
        return {"available": False, "code": "install_required",
                "label": "\u8bf7\u5148\u5b89\u88c5"}
    if item.get("installedVersionAvailable") is False:
        return {"available": False, "code": "version_unavailable",
                "label": "已安装版本已撤销或不再授权，请升级"}
    if item.get("setupState") not in {"", "ready"}:
        return {"available": False, "code": "setup_required",
                "label": "\u8bf7\u5148\u5b8c\u6210\u8bbe\u7f6e"}
    if missing_mcp:
        return {"available": False, "code": "connection_required",
                "label": "\u8fde\u63a5\u5f85\u6062\u590d",
                "missingMcp": missing_mcp[:20]}
    return {"available": True, "code": "ready",
            "label": "\u53ef\u5728\u5bf9\u8bdd\u4f7f\u7528"}


async def client_catalog(session: AsyncSession, org_id: str | None,
                         actor_id: str = "", user_id: str = "",
                         visible_org_ids: set[str] | None = None, *, client=None) -> dict:
    """Return the published employee catalog without package paths, secret references, or
    administrative configuration.
    """
    visible_orgs = (set(visible_org_ids) if visible_org_ids is not None
                    else ({org_id} if org_id else set()))
    q = select(am.PluginBinding).where(am.PluginBinding.enabled.is_(True))
    if visible_orgs:
        q = q.where((am.PluginBinding.org_id.in_(visible_orgs)) |
                    am.PluginBinding.org_id.is_(None))
    else:
        q = q.where(am.PluginBinding.org_id.is_(None))
    real_bindings = list((await session.execute(
        q.order_by(am.PluginBinding.updated_at.desc()))).scalars().all())
    plugin_query = select(am.Plugin).where(am.Plugin.enabled.is_(True))
    if visible_orgs:
        plugin_query = plugin_query.where(
            (am.Plugin.org_id.in_(visible_orgs)) | am.Plugin.org_id.is_(None))
    else:
        plugin_query = plugin_query.where(am.Plugin.org_id.is_(None))
    plugin_rows = list((await session.execute(plugin_query)).scalars().all())
    plugins = {row.id: row for row in plugin_rows}
    from . import plugin_access
    access = await plugin_access.decisions(session, plugin_rows, user_id)
    plugin_ids = set(plugins)
    candidate_versions = list((await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id.in_(plugin_ids or {"__none__"}),
        am.PluginVersion.enabled.is_(True),
        am.PluginVersion.trust_state == "approved",
    ).order_by(am.PluginVersion.created_at.desc(),
               am.PluginVersion.id.desc()))).scalars().all())
    allowed_versions = await plugin_audience.allowed_version_ids(
        session, {row.id for row in candidate_versions}, user_id)
    latest_by_plugin = {}
    for version in sorted(candidate_versions, key=_version_key,
                          reverse=True):
        if (version.plugin_id not in latest_by_plugin
                and plugin_audience.visible(version, allowed_versions)):
            latest_by_plugin[version.plugin_id] = version
    for version in sorted(candidate_versions, key=_version_key, reverse=True):
        if (version.plugin_id not in latest_by_plugin
                and access.get(version.plugin_id, {}).get("canEdit")):
            latest_by_plugin[version.plugin_id] = version
    catalog_bindings = [
        SimpleNamespace(plugin_id=plugin_id, version_id=version.id,
                        project_id=None, catalog_only=True)
        for plugin_id, version in latest_by_plugin.items()
    ]
    bindings = catalog_bindings + real_bindings
    versions = {row.id: row for row in candidate_versions}
    policies = await plugin_marketplace.by_plugin(session, plugin_ids)
    out: dict[str, dict] = {}
    for binding in bindings:
        catalog_only = bool(getattr(binding, "catalog_only", False))
        plugin, version = plugins.get(binding.plugin_id), versions.get(binding.version_id)
        if not plugin or not version or not plugin.enabled or not version.enabled \
                or version.trust_state != "approved" \
                or (plugin.org_id is not None and plugin.org_id not in visible_orgs) \
                or (not plugin_audience.visible(version, allowed_versions)
                    and not access.get(plugin.id, {}).get("canEdit")):
            continue
        current = out.get(plugin.id)
        if current is None:
            report = dict(version.capability_report or {})
            manifest = product_brand.manifest_display(version)
            has_workflow = bool(report.get("hasWorkflow", True))
            entrypoints = dict(manifest.get("entrypoints") or report.get("entrypoints") or {})
            ui = _public_ui(manifest)
            entrypoints = plugin_ui_contracts.effective_entrypoints(
                entrypoints, ui, has_workflow=has_workflow, jiyong=manifest.get('jiyong'))
            audience_mode = plugin_audience.normalize(version.visibility)
            provenance = _provenance(version)
            market_policy = plugin_marketplace.public_policy(policies.get(plugin.id))
            platforms = _public_platforms(report, manifest, plugin.key)
            current = {
                "pluginId": plugin.id, "key": plugin.key,
                "permissions": {"canUse": plugin_audience.visible(version, allowed_versions),
                                "canEdit": bool(access.get(plugin.id, {}).get("canEdit"))},
                **plugin_identity.public(plugin),
                "name": str(manifest.get("name") or plugin.name),
                "versionId": version.id,
                "description": str(manifest.get("description") or plugin.description or ""),
                **({'locales': manifest['locales']} if manifest.get('locales') else {}),
                "icon": plugin_icons.public(manifest.get('icon')),
                "coverUrl": market_policy.get('coverUrl') or plugin_covers.public(manifest.get('coverUrl')),
                "category": str(market_policy.get("category") or "general"),
                "declaredCategory": str(manifest.get("category") or ""),
                "sourceKind": str(report.get("sourceKind") or plugin.source_kind),
                "openSource": dict(manifest.get("openSource") or {}),
                "process": plugin_packages.process_profile(manifest, report),
                "inputs": _public_inputs(manifest),
                "setup": _public_setup(manifest),
                "ui": ui,
                "appWindow": plugin_window_contracts.public(manifest.get("appWindow")),
                **({'jiyong': manifest['jiyong']} if manifest.get('jiyong') else {}),
                **({'template': 'app'} if manifest.get('template') == 'app' else {}),
                "provenance": provenance,
                "appCategory": manifest.get("appCategory") or "other",
                "authorName": str(manifest.get("author") or provenance["publisherName"])[:120],
                "authorType": str(provenance.get("publisherType") or "member")[:24],
                **({"extensions": manifest["extensions"]} if manifest.get("extensions") is not None else {}),
                "version": version.version, "workflow": ([{
                    "key": str(node.get("key") or "")[:64],
                    "type": str(node.get("type") or "")[:32],
                    "name": str(node.get("name") or node.get("key") or "")[:100],
                } for node in list(dict(version.workflow or {}).get("nodes") or [])[:100]
                    if isinstance(node, dict)] if has_workflow else []),
                "entrypoints": entrypoints,
                "capabilities": {
                    # Platform credentials are never part of the catalog.  We
                    # only publish the declaration so the client can request
                    # each employee's own desktop authorization at send time.
                    "platforms": platforms,
                    "resources": list(report.get('resources') or []),
                    "skills": list(report.get("skills") or [])[:50],
                    "mcpServers": list(report.get("mcpServers") or [])[:50],
                    "runtime": list(report.get("runtime") or [])[:50],
                    "network": bool(report.get("network")),
                    "hasScript": bool(report.get("hasScript")),
                    "hasWorkflow": has_workflow,
                    "executionMode": str(report.get("executionMode") or
                                         ("workflow" if has_workflow else "direct")),
                    "components": list(report.get("components") or [])[:20],
                    "componentCount": int(report.get("componentCount") or 0),
                    "permissionSummary": dict(report.get("permissionSummary") or {}),
                    "resultContract": list(report.get("resultContract") or [])[:100],
                    "evaluationCases": list(report.get("evaluationCases") or [])[:20],
                    "qualitySummary": dict(report.get("qualitySummary") or {}),
                },
                "marketPolicy": market_policy,
                "listed": market_policy.get("installation")
                    != plugin_marketplace.NOT_AVAILABLE,
                "taskReady": False, "taskVersionIds": [],
                "organizationWide": False, "projectCount": 0, "projectIds": [],
                "audienceLimited": audience_mode in {
                    plugin_audience.USERS, plugin_audience.ORG_UNITS},
                "audienceLabel": (
                    "指定人员" if audience_mode == plugin_audience.USERS else
                    "指定团队" if audience_mode == plugin_audience.ORG_UNITS else ""),
            }
            out[plugin.id] = current
        if catalog_only or not plugin_audience.visible(version, allowed_versions):
            continue
        current["taskReady"] = True
        version_id = str(binding.version_id)
        if (version_id not in current["taskVersionIds"]
                and len(current["taskVersionIds"]) < 20):
            current["taskVersionIds"].append(version_id)
        if binding.project_id:
            current["projectCount"] += 1
            project_id = str(binding.project_id)
            if project_id not in current["projectIds"] and len(current["projectIds"]) < 100:
                current["projectIds"].append(project_id)
        else:
            current["organizationWide"] = True
    rows = list(out.values())
    current_versions = {
        item["pluginId"]: (item["versionId"], item["version"])
        for item in rows
    }
    setup_by_plugin = {
        item["pluginId"]: item.get("setup") or {}
        for item in rows
    }
    mcp_requirements = {
        item["pluginId"]: set(plugin_application_mcp.company_names(
            item, item["capabilities"].get("mcpServers") or []))
        for item in rows
    }
    default_plugin_ids = {
        item["pluginId"] for item in rows
        if item["marketPolicy"].get("installation")
            == plugin_marketplace.INSTALLED_BY_DEFAULT
        and item["marketPolicy"].get("authentication")
            == plugin_marketplace.ON_INSTALL
    }
    wanted_mcp = sorted(set().union(*mcp_requirements.values())) \
        if mcp_requirements else []
    available_mcp = set((await mcp_servers.readiness(
        session, wanted_mcp, client=client)).get("available") or []) if wanted_mcp else set()
    dependency_states = {
        plugin_id: {
            "ok": not bool(required - available_mcp),
            "requiredMcp": sorted(required),
            "availableMcp": sorted(required & available_mcp),
            "missingMcp": sorted(required - available_mcp),
        }
        for plugin_id, required in mcp_requirements.items()
    }
    default_blockers = {
        plugin_id: dependency_states[plugin_id]["missingMcp"]
        for plugin_id in default_plugin_ids
        if dependency_states[plugin_id]["missingMcp"]
    }
    provision_policies = {
        item["pluginId"]: {
            **item["marketPolicy"],
            "installation": (
                plugin_marketplace.AVAILABLE
                if item["pluginId"] in default_blockers or not item["permissions"]["canUse"]
                else item["marketPolicy"]["installation"]),
        } for item in rows
    }
    await plugin_installations.ensure_defaults(
        session, user_id, current_versions, provision_policies,
        setup_by_plugin)
    installation_states = await plugin_installations.catalog_states(
        session, user_id, current_versions)
    installation_rows = await plugin_installations.by_plugin(
        session, user_id, current_versions)
    accepted_version_ids = {
        row.version_id for row in installation_rows.values() if row.version_id
    }
    accepted_versions = {
        version.id: version
        for version in (await session.execute(select(am.PluginVersion).where(
            am.PluginVersion.id.in_(accepted_version_ids or {"__none__"})
        ))).scalars().all()
    }
    accepted_allowed = await plugin_audience.allowed_version_ids(
        session, accepted_versions.keys(), user_id)
    accepted_mcp = sorted({str(name) for version in accepted_versions.values()
                           for name in dict(version.capability_report or {}).get("mcpServers") or []})
    accepted_available = set((await mcp_servers.readiness(
        session, accepted_mcp, client=client)).get("available") or []) if accepted_mcp else set()
    for item in rows:
        item.update(installation_states.get(item["pluginId"], {
            "installed": False, "installedVersion": "",
            "updateAvailable": False, "installationState": "available"}))
        installation_policy = item["marketPolicy"].get("installation")
        dependency = dependency_states.get(item["pluginId"], {
            "ok": True, "requiredMcp": [], "availableMcp": [], "missingMcp": []})
        item["dependencyReadiness"] = dependency
        missing_preferences = plugin_setup_contracts.missing_required(
            item.get("setup"), item.get("setupConfig"))
        item["setupReadiness"] = {
            "ok": not missing_preferences,
            "missingPreferences": missing_preferences,
            "requiresSetup": bool(
                (item.get("setup") or {}).get("preferences")),
        }
        item["installationBlockers"] = (
            list(dependency["missingMcp"]) + missing_preferences)
        if installation_policy == plugin_marketplace.NOT_AVAILABLE:
            item.update({
                "installed": False, "updateAvailable": False,
                "installationState": "task_only",
            })
        elif item.get("installed") and item.get("setupState") != "ready":
            item["installationState"] = "setup_required"
        elif installation_policy == plugin_marketplace.INSTALLED_BY_DEFAULT:
            item["installationState"] = (
                "default" if item["installed"] else
                "default_blocked" if default_blockers.get(item["pluginId"])
                else "default_disabled")
        elif (dependency["missingMcp"]
              and item["marketPolicy"].get("authentication")
              == plugin_marketplace.ON_INSTALL and not item["installed"]):
            item["installationState"] = "blocked"
        if item.get("updateAvailable"):
            installation = installation_rows.get(item["pluginId"])
            previous = accepted_versions.get(
                installation.version_id if installation else "")
            current = versions.get(item["versionId"])
            if current is not None:
                item["upgradeImpact"] = plugin_compat.between(previous, current)
        conversation_item = dict(item)
        conversation_dependency = dependency
        installation = installation_rows.get(item["pluginId"])
        if installation and installation.enabled:
            conversation_item["setupState"] = str(installation.setup_state or "ready")
            accepted = accepted_versions.get(installation.version_id)
            conversation_item["installedVersionAvailable"] = bool(
                accepted and accepted.enabled and accepted.trust_state == "approved"
                and plugin_audience.visible(accepted, accepted_allowed))
            if accepted:
                manifest = product_brand.manifest_display(accepted)
                report = dict(accepted.capability_report or {})
                item["conversationVersion"] = accepted.version
                item["conversationVersionId"] = accepted.id
                item['conversationChecksum'] = accepted.checksum
                item["conversationUi"] = _public_ui(manifest)
                item['conversationJiyong'] = manifest.get('jiyong')
                item['conversationExtensions'] = manifest.get('extensions')
                item['conversationAppCategory'] = manifest.get('appCategory') or 'other'
                item['conversationAuthorName'] = str(manifest.get('author') or provenance['publisherName'])[:120]
                item["conversationName"] = str(manifest.get("name") or item["name"])
                if manifest.get('locales'):
                    item['conversationLocales'] = manifest['locales']
                item["conversationInputs"] = _public_inputs(manifest)
                item["conversationEntrypoints"] = manifest.get("entrypoints") or report.get("entrypoints") or {}
                item["conversationCapabilities"] = {
                    "platforms": _public_platforms(report, manifest, plugin.key),
                    "skills": list(report.get("skills") or []),
                    "mcpServers": list(report.get("mcpServers") or []),
                    "runtime": list(report.get("runtime") or []),
                }
                conversation_item["entrypoints"] = manifest.get("entrypoints") or report.get("entrypoints") or {}
                required = set(plugin_application_mcp.company_names(manifest, report.get("mcpServers") or []))
                conversation_dependency = {"missingMcp": sorted(required - accepted_available)}
        item["conversationUse"] = _conversation_use(conversation_item, conversation_dependency)
        if not item["permissions"]["canUse"]:
            item["conversationUse"] = {"available": False, "code": "permission_denied",
                                       "label": "你没有这个插件的使用权限"}
            item["listed"] = False
            item["installationState"] = "permission_denied"
    rows.sort(key=lambda item: (
        not bool(item["marketPolicy"].get("featured")),
        int(item["marketPolicy"].get("sort") or 0),
        not item["organizationWide"], item["name"].lower()))
    submissions = []
    if actor_id:
        own_versions = list((await session.execute(select(am.PluginVersion).where(
            am.PluginVersion.created_by == actor_id
        ).order_by(am.PluginVersion.created_at.desc()))).scalars().all())
        own_versions.sort(key=_submitted_version_key, reverse=True)
        bound_version_ids = set((await session.execute(select(
            am.PluginBinding.version_id
        ).where(
            am.PluginBinding.version_id.in_(
                {item.id for item in own_versions} or {"__none__"}),
            am.PluginBinding.enabled.is_(True),
        ))).scalars().all())
        own_audience_counts = await plugin_audience.counts(
            session, [item.id for item in own_versions])
        own_plugin_ids = {item.plugin_id for item in own_versions}
        own_policies = await plugin_marketplace.by_plugin(session, own_plugin_ids)
        own_plugins = {row.id: row for row in (await session.execute(select(am.Plugin).where(
            am.Plugin.id.in_(own_plugin_ids or {"__none__"})
        ))).scalars().all()}
        own_access = await plugin_access.decisions(session, own_plugins.values(), user_id)
        review_rows = list((await session.execute(select(models.AuditLog).where(
            models.AuditLog.target_type == "plugin_version",
            models.AuditLog.target_id.in_({item.id for item in own_versions} or {"__none__"}),
            models.AuditLog.action.in_([
                "plugin.approve", "plugin.reject", "plugin.revoke",
            ]),
        ).order_by(models.AuditLog.at.desc(), models.AuditLog.id.desc()))).scalars().all())
        # Project immutable audit events without exposing package, evaluation or
        # actor IDs. Event IDs only stabilize ordering when times tie.
        review_history = {}
        for row in review_rows:
            detail = dict(row.detail or {})
            review_history.setdefault(str(row.target_id or ""), []).append({
                "id": row.id,
                "decision": row.action.split(".", 1)[1],
                "note": str(detail.get("note") or "")[:1200],
                "reviewedAt": _ms(row.at),
                "reviewedBy": str(row.actor_name or ""),
            })
        for version in own_versions:
            plugin = own_plugins.get(version.plugin_id)
            if not plugin or plugin.org_id != org_id:
                continue
            manifest = product_brand.manifest_display(version)
            report = dict(version.capability_report or {})
            provenance = _provenance(version)
            market_policy = plugin_marketplace.public_policy(own_policies.get(plugin.id))
            history = review_history.get(version.id, [])
            review = history[0] if history else {}
            submissions.append({
                "pluginId": plugin.id, "versionId": version.id,
                **({'template': 'app'} if manifest.get('template') == 'app' else {}),
                "permissions": {"canUse": False,
                                "canEdit": bool(own_access.get(plugin.id, {}).get("canEdit"))},
                **plugin_identity.public(plugin),
                "name": str(manifest.get("name") or plugin.name), "key": plugin.key,
                **({"locales": manifest["locales"]} if manifest.get("locales") else {}),
                "icon": plugin_icons.public(manifest.get('icon')),
                "sourceKind": str(report.get("sourceKind") or plugin.source_kind),
                "provenance": provenance,
                "appCategory": manifest.get("appCategory") or "other",
                "authorName": str(manifest.get("author") or provenance["publisherName"])[:120],
                "authorType": str(provenance.get("publisherType") or "member")[:24],
                **({"extensions": manifest["extensions"]} if manifest.get("extensions") is not None else {}),
                "category": str(market_policy.get("category") or "general"),
                "marketPolicy": market_policy,
                "version": version.version,
                "trustState": version.trust_state, "enabled": bool(version.enabled),
                "visibility": plugin_audience.normalize(version.visibility),
                "audienceCount": own_audience_counts.get(version.id, 0),
                "createdAt": _ms(version.created_at),
                "reviewDecision": review.get("decision", ""),
                "reviewNote": review.get("note", ""),
                "reviewedAt": review.get("reviewedAt", 0),
                "reviewedBy": review.get("reviewedBy", ""),
                "reviewHistory": history,
                "qualitySummary": dict(report.get("qualitySummary") or {}),
                "bindingCount": int(version.id in bound_version_ids),
                "catalogReady": bool(
                    version.trust_state == "approved"
                    and version.enabled
                    and market_policy.get("installation")
                        != plugin_marketplace.NOT_AVAILABLE),
            })
    # Keep disabled category metadata in the employee payload.  An existing
    # plugin may still be assigned to a category that an administrator has
    # disabled (the admin UI intentionally preserves that policy instead of
    # silently moving the plugin).  Omitting the metadata made the desktop
    # fall back to the manifest/PURPOSE label, so the same plugin appeared to
    # jump categories immediately after an admin disabled one.
    return {"items": rows, "submissions": submissions,
            "categories": await plugin_marketplace.categories(
                session, include_disabled=True)}
