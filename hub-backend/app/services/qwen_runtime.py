"""Map the managed model contract to Qwen's native settings without renaming it.

Qwen accepts ACP images independently of the selected model's modalities. Both
its request converter and read_file discard images when that model lacks the
image modality, so passing the model name and endpoint alone is insufficient.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

try:
    from . import runtime_images
except ImportError:  # Direct script entry used by the source Runner bridge.
    import runtime_images

SETTINGS_ENV = "QWEN_CODE_SYSTEM_SETTINGS_PATH"
DEFAULTS_ENV = "QWEN_CODE_SYSTEM_DEFAULTS_PATH"
MODEL_LABEL_ENV = "SODUWORK_QWEN_MODEL_LABEL"
MODEL_LABEL = "SoduWork managed model"
_JSON_COMMENTS = re.compile(r'("(?:\\.|[^"\\])*")|//[^\r\n]*|/\*[\s\S]*?\*/')


def system_settings_path(env: dict) -> Path:
    """Match Qwen's documented operator settings locations on each platform."""
    configured = env.get(SETTINGS_ENV)
    if configured:
        return Path(configured).expanduser()
    if sys.platform == "win32":
        return Path(r"C:\ProgramData\qwen-code\settings.json")
    if sys.platform == "darwin":
        return Path("/Library/Application Support/QwenCode/settings.json")
    return Path("/etc/qwen-code/settings.json")


def _read_settings(path: Path) -> dict:
    """Read Qwen's JSON-with-comments format without changing the source file."""
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return {}
    # Qwen uses JSON.parse(strip-json-comments(...)); trailing commas and JSON5
    # extensions are intentionally not accepted here either.
    raw = _JSON_COMMENTS.sub(lambda match: match[1] or " ", raw)
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Qwen operator settings must be a JSON object")
    return value


def _merge_generation(target: dict, source: dict) -> None:
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge_generation(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def _operator_settings(env: dict, defaults: Path) -> tuple[dict, dict]:
    """Retain operator policy and the existing managed-home model registry."""
    operator = _read_settings(system_settings_path(env))
    user = _read_settings(Path(env["QWEN_HOME"]) / "settings.json") if env.get("QWEN_HOME") else {}
    default_settings = _read_settings(defaults)
    generation = {}
    for scope in (default_settings, user, operator):
        _merge_generation(generation, (scope.get("model") or {}).get("generationConfig") or {})
    # Qwen replaces the entire modelProviders object across settings scopes.
    # Carry its original registry into the overlay, without promoting user
    # permissions, hooks or other settings to the privileged operator scope.
    if "modelProviders" not in operator:
        source = user if "modelProviders" in user else default_settings
        if "modelProviders" in source:
            operator["modelProviders"] = source["modelProviders"]
    return operator, generation


def settings(llm: dict, operator: dict, inherited_generation: dict | None = None) -> dict:
    """Declare transport support, not a guessed capability based on model names."""
    result = copy.deepcopy(operator)
    image = runtime_images.transport_supported(llm)
    model = result.setdefault("model", {})
    # Native settings can otherwise retain a model selected by an earlier turn.
    model["name"] = llm["model"]
    model["baseUrl"] = "$OPENAI_BASE_URL"
    generation = model.setdefault("generationConfig", {})
    generation.setdefault("modalities", {})["image"] = image
    generation["splitToolMedia"] = True
    providers = result.setdefault("modelProviders", {})
    rows = providers.get("openai") or []
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("Qwen OpenAI model providers must be an array of objects")
    model_id = str(llm.get("model") or "")
    # Provider entries are sealed in Qwen: top-level generationConfig is ignored
    # for a matching provider. Supply both scopes and retain unrelated models.
    def current_route(row):
        return row.get("id") == model_id and row.get("baseUrl", llm["base"]) in (
            llm["base"], "$OPENAI_BASE_URL", "${OPENAI_BASE_URL}")

    existing = next((row for row in rows if current_route(row)), {})
    entry_generation = copy.deepcopy(existing.get("generationConfig", inherited_generation or generation))
    entry_generation.setdefault("modalities", {})["image"] = image
    entry_generation["splitToolMedia"] = True
    entry = {**existing, "id": model_id, "name": MODEL_LABEL, "envKey": "OPENAI_API_KEY",
             "baseUrl": "$OPENAI_BASE_URL", "wireApi": existing.get("wireApi", "chat-completions"),
             "generationConfig": entry_generation}
    entry.pop("apiKey", None)
    # The managed route must precede same-name routes under custom providers.
    result["modelProviders"] = {"openai": [entry, *(row for row in rows if not current_route(row))],
                                **{key: value for key, value in providers.items() if key != "openai"}}
    return result


def configure(env: dict, llm: dict, data_root: str, runtime_ref: str = "") -> None:
    """Publish an invocation-local overlay while retaining native session storage.

    The original operator file and shared QWEN_HOME are never written. A private
    file per invocation avoids races with concurrent sessions or model switches,
    and does not rely on atomic renames blocked by some Windows filesystem filters.
    """
    if not (llm.get("base") and llm.get("model") and
            (llm.get("key") or llm.get("localOnly") is True)):
        return
    try:
        defaults = Path(env.get(DEFAULTS_ENV) or system_settings_path(env).parent / "system-defaults.json")
        operator, generation = _operator_settings(env, defaults)
        content = settings(llm, operator, generation)
        scope = hashlib.sha256(str(runtime_ref or "probe").encode("utf-8")).hexdigest()[:24]
        directory = Path(data_root).resolve() / "agent-runtimes" / "qwen" / scope
        directory.mkdir(parents=True, exist_ok=True)
        # Files are closed before child startup; no process can observe a partial
        # overlay. Credentials for the selected model remain environment-only.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".json",
                                         prefix="model-", dir=directory, delete=False) as stream:
            json.dump(content, stream, ensure_ascii=False, separators=(",", ":"))
            target = stream.name
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        # Never include settings content, endpoint credentials or parser excerpts.
        raise RuntimeError("Qwen Code 模型能力配置无法读取或写入，请检查执行机配置后重试。") from exc
    # Qwen derives its defaults path from the system settings path. Keep that
    # original location when redirecting only the operator overlay.
    env[DEFAULTS_ENV] = str(defaults)
    env[SETTINGS_ENV] = target
    env[MODEL_LABEL_ENV] = MODEL_LABEL


def apply_model(client, session_config: dict) -> None:
    """Bind restored ACP sessions to the managed route before sending a prompt."""
    label = os.environ.get(MODEL_LABEL_ENV)
    if not label:
        return
    models = (session_config.get("models") or {}).get("availableModels") or []
    matches = [model for model in models if model.get("name") == label and model.get("modelId")]
    if len(matches) != 1:
        raise RuntimeError("Qwen Code 未提供本次选择的模型配置，请更新底座后重试。")
    model_id = matches[0]["modelId"]
    # Use the advertised opaque route ID; names and endpoints alone cannot
    # disambiguate providers. Config-option updates do not persist a new default.
    options = session_config.get("configOptions") or []
    if any(option.get("id") == "model" for option in options):
        client.request("session/set_config_option", {
            "sessionId": client.session_id, "configId": "model", "value": model_id})
    else:
        client.request("session/set_model", {"sessionId": client.session_id, "modelId": model_id,
                                           "_meta": {"qwen.session.modelPersistDefault": False}})
