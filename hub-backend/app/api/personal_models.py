"""Personal model providers, key patches and bounded credential probes."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_model_client, current_client, enforce_client_quota
from ..models import Client

router = APIRouter()


def _local_provider_ids(client) -> set[str]:
    """Identify legacy client-local providers that must not remain in Hub state."""
    config = getattr(client, "config", None) or {}
    rows = config.get("modelProviders") if isinstance(config, dict) else None
    ids = {
        str(row.get("id") or "").strip().lower()
        for row in (rows or [])
        if isinstance(row, dict)
        and row.get("localOnly") is True
    }
    ids.update(
        str(row.get("providerId") or "").strip().lower()
        for row in (getattr(client, "models", None) or [])
        if isinstance(row, dict)
        and row.get("localOnly") is True
    )
    return ids


def _purge_local_model_state(client) -> bool:
    """Remove legacy local model services, models, and keys from the Hub-owned client row."""
    local_ids = _local_provider_ids(client)
    if not local_ids:
        return False
    changed = False
    config = dict(getattr(client, "config", None) or {})
    providers = config.get("modelProviders")
    if isinstance(providers, list):
        kept = [row for row in providers
                if not isinstance(row, dict)
                or str(row.get("id") or "").strip().lower() not in local_ids]
        if kept != providers:
            changed = True
            if kept:
                config["modelProviders"] = kept
            else:
                config.pop("modelProviders", None)
    models = list(getattr(client, "models", None) or [])
    kept_models = [row for row in models
                   if not isinstance(row, dict)
                   or str(row.get("providerId") or "").strip().lower() not in local_ids]
    if kept_models != models:
        client.models = kept_models
        changed = True
    keys = dict(getattr(client, "model_keys", None) or {})
    kept_keys = {key: value for key, value in keys.items()
                 if str(key).strip().lower() not in local_ids}
    if kept_keys != keys:
        client.model_keys = kept_keys
        changed = True
    if config != (getattr(client, "config", None) or {}):
        client.config = config
        changed = True
    return changed


@router.get("/my-models")
async def my_models(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return Hub-managed usable models and masked personal credential metadata.

    Client-local services are removed from legacy rows and are never returned or persisted here.
    Credentials are masked and never returned in plaintext.
    """
    from ..services import model_catalog
    from ..services import model_config_guard
    if _purge_local_model_state(client):
        await session.commit()
        await session.refresh(client)
    cat = await model_catalog.catalog(session, client)
    # Include each provider's models so users can see what their credentials enable.
    # Exclude disabled providers, but retain enabled providers without organization credentials.
    # Personal credentials may enable models unavailable through organization credentials.
    byp: dict[str, list] = {}
    for m in cat["models"]:
        if m["enabled"]:
            byp.setdefault(m["providerId"], []).append(m)
    from ..services import model_capabilities
    from ..services.model_defaults import public_defaults
    own_models = [{**row, "own": True} for row in (getattr(client, "models", None) or []) if isinstance(row, dict)]
    await model_capabilities.enrich(session, own_models,
        await model_catalog.effective_provider_map(session, client), client)
    usable_models = await model_catalog.usable(session, client, "chat")
    return {
        "providers": [{
            **p,
            "modelDefs": byp.get(p["id"], []),
            "modelNames": [
                m["label"] or m["name"] for m in byp.get(p["id"], [])
            ],
        } for p in await model_catalog.providers_for_client(session, client)
           if p["enabled"]],
        # Keep usable limited to chat models for existing chat and dispatch selectors.
        "usable": usable_models,
        **public_defaults(usable_models, client),
        "mediaUsable": {
            "image": await model_catalog.usable(session, client, "image"),
            "video": await model_catalog.usable(session, client, "video"),
        },
        "myModels": own_models,
        "revision": model_config_guard.revision(client),
    }


@router.put("/my-models")
async def put_my_models(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Save Hub-managed personal providers, models, and credential overrides.

    Client-local services and models are persisted by the desktop client and are rejected here.
    Empty key values preserve existing keys; null explicitly removes a personal key.
    """
    import re as _re

    from sqlalchemy import select
    from ..models import ModelProvider
    from ..services import model_catalog
    from ..services import model_config_guard
    await model_config_guard.personal(session, client, body.get("expectedRevision"),
        allow_patch=not any(k in body for k in ("providers", "models")))
    _purge_local_model_state(client)
    valid_ids = {p.id for p in (await session.execute(select(ModelProvider))).scalars().all()}
    if isinstance(body.get("providers"), list):
        rows, seen = [], set()
        for raw in body["providers"][:30]:
            if not isinstance(raw, dict):
                continue
            pid = str(raw.get("id") or "").strip().lower()[:48]
            base = str(raw.get("baseUrl") or "").strip()[:400]
            if not pid or pid in seen:
                continue
            if raw.get("localOnly") is True:
                raise HTTPException(status_code=403,
                                    detail="本地模型配置由客户端管理，不能保存到 Hub")
            if base and not base.startswith(("http://", "https://")):
                raise HTTPException(status_code=400, detail="接口地址要以 http(s):// 开头")
            if pid in valid_ids:
                p = await session.get(ModelProvider, pid)
                if base and base.rstrip("/") != str(p.base_url or "").rstrip("/"):
                    rows.append({"id": pid, "baseUrl": base})
                seen.add(pid)
                continue
            if not pid.startswith("custom-") or not _re.fullmatch(r"[a-z0-9_-]+", pid):
                raise HTTPException(status_code=400, detail="自定义模型服务标识不合法")
            name = str(raw.get("name") or "").strip()[:64]
            if not name or not base:
                raise HTTPException(status_code=400, detail="自定义模型服务要填写名称和接口地址")
            kind = str(raw.get("kind") or "openai-compat").strip()
            if kind not in ("openai-compat", "anthropic"):
                raise HTTPException(status_code=400, detail="暂不支持这种接口协议")
            rows.append({"id": pid, "name": name, "baseUrl": base, "kind": kind,
                         "authMode": "none" if raw.get("authMode") == "none" else "key",
                         "note": str(raw.get("note") or "")[:300], "personal": True})
            valid_ids.add(pid); seen.add(pid)
        cfg = dict(client.config or {})
        old_custom = {str(x.get("id") or "") for x in (cfg.get("modelProviders") or [])
                      if isinstance(x, dict) and x.get("personal")}
        cfg["modelProviders"] = rows
        client.config = cfg
        new_custom = {x["id"] for x in rows if x.get("personal")}
        removed = old_custom - new_custom
    else:
        removed = set()
        valid_ids |= {p["id"] for p in await model_catalog.providers_for_client(session, client)}
    cur = dict(getattr(client, "model_keys", None) or {})
    keys = body.get("keys")
    if isinstance(keys, dict):
        for pid, v in keys.items():
            pid = str(pid).strip().lower()[:48]
            if v is None:
                cur.pop(pid, None)  # Remove the personal key and fall back to organization credentials.
            elif str(v).strip():
                if pid not in valid_ids:
                    raise HTTPException(status_code=400, detail="模型服务不存在，请刷新后重试")
                cur[pid] = str(v).strip()[:400]
    for pid in removed:
        cur.pop(pid, None)
    client.model_keys = cur
    if isinstance(body.get("models"), list):
        out = []
        for m in body["models"][:40]:
            if not isinstance(m, dict):
                continue
            pid = str(m.get("providerId") or "").strip().lower()[:48]
            nm = str(m.get("name") or "").strip()[:160]
            if m.get("localOnly") is True:
                raise HTTPException(status_code=403,
                                    detail="本地模型配置由客户端管理，不能保存到 Hub")
            if pid in valid_ids and nm:
                modality = model_catalog.normalize_modality(m.get("modality"))
                try:
                    config = model_catalog.clean_model_config(m.get("config"), modality)
                    from ..services.model_capabilities import validate_limits
                    context_size = validate_limits(m.get("ctxWindow"), config)
                except (ValueError, TypeError) as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
                out.append({"providerId": pid, "name": nm,
                            "label": str(m.get("label") or nm)[:80],
                            "modality": modality, "config": config,
                            "ctxWindow": context_size})
            elif pid and nm:
                raise HTTPException(status_code=400, detail="模型服务不存在，请刷新后重试")
        client.models = out
    await session.commit()
    await session.refresh(client)
    from ..services.client_domain_events import device_changed
    await device_changed(client, "models")
    return {
        "ok": True,
        "usable": await model_catalog.usable(session, client, "chat"),
        "mediaUsable": {
            "image": await model_catalog.usable(session, client, "image"),
            "video": await model_catalog.usable(session, client, "video"),
        },
    }


@router.post("/my-models/test")
async def test_my_model(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_model_client),
    session: AsyncSession = Depends(get_session),
):
    """Probe the client's currently effective credential, preferring a personal key over the
    organization's key.
    """
    import asyncio as _aio

    from ..services import model_catalog
    pid = str(body.get("providerId") or "").strip()
    p = (await model_catalog.effective_provider_map(session, client)).get(pid)
    if p is None or not p["enabled"]:
        raise HTTPException(status_code=404, detail="没有这个模型服务，或者它已经被停用了")
    key, key_from = model_catalog.provider_key(p, client)
    if not key:
        return {"ok": False, "detail": "还没有可用的密钥——公司没配，你也还没填"}
    # Use an available provider model for a chat probe when /models is unavailable.
    lst = []
    for modality in model_catalog.MODEL_MODALITIES:
        lst.extend(await model_catalog.usable(session, client, modality))
    probe = next((m["name"] for m in lst if m["providerId"] == pid), "")
    from ..services import model_quota
    # A probe can fall back to paid inference. Use the same credential-derived
    # admission, with the exact probe model for restricted plans.
    await enforce_client_quota(session, client, conf={"provider": pid, "model": probe,
        "quotaScope": model_quota.scope(p, key_from) if probe else "platform"})
    r = await _aio.to_thread(model_catalog.probe_sync, p["baseUrl"], key, probe, p["kind"])
    return {**r, "keyFrom": key_from, "protocol": p["kind"],
            "gatewayCompatible": p["kind"] == "openai-compat"}
