"""Device-owned usage receipts retain the funding of each native model call."""
from __future__ import annotations

import copy
import time
from urllib.parse import urlsplit


def capture(run: dict, cfg: dict) -> None:
    llm = dict((cfg or {}).get("llm") or {})
    local = llm.get("localOnly") is True
    run["_activeModelConfig"] = llm
    run["activeUsageOwner"] = {
        "agent": str(run.get("cli") or ""), "localOnly": local,
        "model": "" if local else str(llm.get("model") or run.get("model") or ""),
        "provider": "" if local else str(llm.get("quotaProvider") or ""),
        **({"quotaUsageToken": str(llm["quotaUsageToken"])}
           if not local and llm.get("quotaVersion") == 2 and llm.get("quotaUsageToken") else {}),
    }


def _local(run: dict) -> bool:
    owner = run.get("activeUsageOwner")
    if isinstance(owner, dict):
        return owner.get("localOnly") is True
    return bool(dict((run.get("cfg") or {}).get("llm") or {}).get("localOnly") or
                run.get("modelLocalOnly"))


def redact_metadata(run: dict, value, *, diagnostic: bool = False):
    llm = dict(run.get("_activeModelConfig") or (run.get("cfg") or {}).get("llm") or {})
    if not _local(run):
        return value
    secrets = [str(llm.get("key") or ""), str(llm.get("base") or "")]
    if diagnostic:
        secrets.append(str(llm.get("model") or ""))
        try:
            secrets.append(urlsplit(str(llm.get("base") or "")).hostname or "")
        except ValueError:
            pass
    if isinstance(value, str):
        for secret in sorted(set(secrets), key=len, reverse=True):
            if secret:
                value = value.replace(secret, "[local model]")
        return value
    if isinstance(value, list):
        return [redact_metadata(run, row, diagnostic=diagnostic) for row in value]
    if isinstance(value, dict):
        return {key: redact_metadata(run, row, diagnostic=diagnostic) for key, row in value.items()}
    return value


def sanitize_event(run: dict, event: dict, *, diagnostic: bool = False) -> dict:
    if not _local(run):
        return event
    row = dict(event)
    row["localModelMetadata"] = True
    diagnostic = diagnostic or str(row.get("tool") or "").lower() in {"stderr", "error", "model", "错误"}
    metadata = diagnostic or row.get("kind") == "out" and row.get("tool", "") in {"", "提示"}
    row = redact_metadata(run, row, diagnostic=metadata)
    if diagnostic and row.get("kind") in {"out", "say", "text"}:
        # Provider failures can contain arbitrary echoed request bodies. Keep
        # their details on the provider side rather than in Hub-visible events.
        row["text"] = "Local model request failed; check the device model settings."
        row.pop("full", None)
    return row


def append(run: dict, usage: dict) -> None:
    llm = dict((run.get("cfg") or {}).get("llm") or {})
    local = _local(run)
    receipt = {"usage": dict(usage), "at": int(time.time() * 1000),
               "agent": str(run.get("cli") or ""),
               "model": "" if local else str(llm.get("model") or run.get("model") or ""),
               "provider": "" if local else str(llm.get("quotaProvider") or ""),
               "localOnly": local, "reportable": not local}
    if not local and llm.get("quotaVersion") == 2 and llm.get("quotaUsageToken"):
        receipt["quotaUsageToken"] = str(llm["quotaUsageToken"])
    if isinstance(run.get("activeUsageOwner"), dict):
        # A queued follow-up may already have replaced cfg. Attribute current
        # output to the executor that started it, including after restart.
        receipt.pop("quotaUsageToken", None)
        receipt.update(run["activeUsageOwner"])
        receipt["reportable"] = not local
    if not isinstance(run.get("usageReceipts"), list):
        run["usageReceipts"] = []
    run["usageReceipts"].append(receipt)


def private_snapshot(run: dict) -> list[dict]:
    # Only the trusted desktop stdio channel may receive signed funding tokens.
    # An empty list is authoritative for legacy totals with unknown ownership.
    return copy.deepcopy(run.get("usageReceipts") or [])


def public_usage(run: dict) -> dict:
    from .usage_values import normalize_usage
    receipts = run.get("usageReceipts")
    if receipts is None:
        # Old archives lack proof separating device-funded and Hub-funded calls.
        return {}
    totals = {}
    quality_rank = {"unknown": 0, "estimated": 1, "reported": 2, "reconciled": 3}
    for row in receipts:
        if row.get("localOnly") or row.get("reportable") is False:
            continue
        usage = normalize_usage(row.get("usage") or {})
        for key in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
                    "reasoning_tokens", "total_tokens", "requests", "turns", "steps",
                    "duration_ms", "cost_microusd"):
            totals[key] = totals.get(key, 0) + usage[key]
        if not usage["input_includes_cache"]:
            totals["input_tokens"] += usage["cache_read_tokens"] + usage["cache_write_tokens"]
        totals["input_includes_cache"] = True
        totals["cost_known"] = totals.get("cost_known", True) and usage["cost_known"]
        totals["currency"] = usage["currency"]
        totals["quality"] = min(totals.get("quality", usage["quality"]), usage["quality"],
                                key=lambda value: quality_rank[value])
    return totals


def device_owned(run: dict) -> bool:
    return bool(run.get("modelLocalOnly") or (run.get("activeUsageOwner") or {}).get("localOnly") or
                dict((run.get("cfg") or {}).get("llm") or {}).get("localOnly") or
                any(row.get("localOnly") for row in run.get("usageReceipts") or []))


def private_model(run: dict) -> bool:
    """Unknown historical ownership cannot establish a public model identity."""
    from .model_reference_privacy import is_local_model_reference
    if device_owned(run) or is_local_model_reference(run.get("model")):
        return True
    if run.get("modelLocalOnly") is False:
        return False
    from ..agent_catalog import AGENTS
    if AGENTS.get(str(run.get("cli") or ""), {}).get("modelMode") == "account":
        return False
    receipts = run.get("usageReceipts") or []
    return not any(row.get("localOnly") is False and row.get("reportable") is True and
                   row.get("model") == run.get("model") for row in receipts)


def public_snapshot(value: dict, run: dict) -> dict:
    """Project native session metadata across the remote RPC boundary."""
    private = private_model(run)
    model_keys = {"model", "modelName", "modelRef", "modelId", "localModel"}

    def clean(item, path=()):
        if isinstance(item, dict):
            runtime_event = (len(path) in {2, 3} and path[-2] == "items" and
                             isinstance(path[-1], int) and path[0] in {"items", "data"})
            local_event = item.get("localModelMetadata") is True or private and runtime_event
            excluded = {"usageReceipts", "quotaUsageToken", "localModelMetadata", "_terminal"}
            if local_event:
                excluded.update({"usage", "tokens", "cost", "ctxPct", "ctxWindow", "ctxWindowKnown"})
            result = {}
            for key, field in item.items():
                if key in excluded:
                    continue
                if key in {"arguments", "pluginInputs"}:
                    result[key] = copy.deepcopy(field)
                elif private and key in model_keys:
                    result[key] = ""
                elif key == "error" and field and private and run:
                    result[key] = "Local model execution failed; inspect the device model settings."
                else:
                    result[key] = clean(field, path + (key,))
            if path in {(), ("data",)}:
                if "usage" in result:
                    result["usage"] = public_usage(run)
                if private:
                    for key, empty in (("tokens", {}), ("ctxPct", 0), ("ctxWindow", 0),
                                       ("ctxWindowKnown", False)):
                        if key in result:
                            result[key] = empty
            return result
        if isinstance(item, list):
            return [clean(field, path + (index,)) for index, field in enumerate(item)]
        return item

    return clean(value)
