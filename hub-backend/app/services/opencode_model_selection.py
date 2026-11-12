"""Bind each managed OpenCode turn to its selected model without replacing history."""
from __future__ import annotations

import json
import os


def native_arguments(cfg: dict | None) -> list[str]:
    model = ((cfg or {}).get("llm") or {}).get("model")
    return ["--model", "company/" + model] if isinstance(model, str) and model else []


def _values(options: list) -> set[str]:
    values = set()
    for option in options:
        if not isinstance(option, dict):
            continue
        if isinstance(option.get("value"), str):
            values.add(option["value"])
        if isinstance(option.get("options"), list):
            values.update(_values(option["options"]))
    return values


def apply_model(client, session_config: dict) -> None:
    """Use the advertised ACP route before prompting an existing or new session."""
    raw = os.environ.get("OPENCODE_CONFIG_CONTENT")
    if not raw:
        return
    try:
        config = json.loads(raw)
        selected = config.get("model")
        providers = config.get("provider") or {}
        if "company" not in providers:
            return
        managed = providers["company"].get("models")
        if (not isinstance(selected, str) or not selected.startswith("company/")
                or not isinstance(managed, dict) or selected[len("company/"):] not in managed):
            raise ValueError("Missing managed model")
    except (ValueError, TypeError, AttributeError) as exc:
        raise RuntimeError("OpenCode 本次模型配置无效，本轮尚未执行。") from exc

    options = [option for option in session_config.get("configOptions") or []
               if isinstance(option, dict) and option.get("id") == "model"]
    if options:
        if len(options) != 1 or selected not in _values(options[0].get("options") or []):
            raise RuntimeError("OpenCode 未提供本次选择的模型，请更新执行组件后重试。")
        if options[0].get("currentValue") == selected:
            return
        result = client.request("session/set_config_option", {
            "sessionId": client.session_id, "configId": "model", "value": selected})
        updated = [option for option in (result or {}).get("configOptions") or []
                   if isinstance(option, dict) and option.get("id") == "model"]
        if len(updated) != 1 or updated[0].get("currentValue") != selected:
            raise RuntimeError("OpenCode 未确认本次选择的模型，本轮尚未执行。")
        return

    # Older ACP versions advertise model IDs through the legacy models field.
    models = session_config.get("models") or {}
    available = {model.get("modelId") for model in models.get("availableModels") or []
                 if isinstance(model, dict)}
    if selected not in available:
        raise RuntimeError("OpenCode 未提供本次选择的模型，请更新执行组件后重试。")
    if models.get("currentModelId") != selected:
        client.request("session/set_model", {"sessionId": client.session_id, "modelId": selected})
