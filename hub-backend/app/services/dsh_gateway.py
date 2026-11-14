"""Use DSH's built-in pi-ai provider for managed OpenAI/Anthropic gateways.

This changes only the model wire protocol. The DSH agent, native sandbox,
approvals and sessions remain owned by the installed DeepSeek Harness.
"""
from __future__ import annotations

import json
from pathlib import Path

from . import context_window, runtime_images
from .runtime_defaults import DEFAULT_OUTPUT

PROVIDER = "soduwork"
KEY_ENV = "SODUWORK_API_KEY"
PROFILE_ENV = "SODUWORK_DSH_PROVIDERS"


def bundle_args() -> list[str]:
    bundle = Path(__file__).with_name("dsh_gateway_bundle")
    if not (bundle / "cordis.patch.yml").is_file() or not (bundle / "package.json").is_file():
        raise RuntimeError("DeepSeek Harness managed gateway adapter is missing; update SoduWork")
    return ["--bundle", str(bundle)]


def inject_env(env: dict, llm: dict) -> None:
    base, secret, model = (str(llm.get(key) or "") for key in ("base", "key", "model"))
    local_only = (llm or {}).get("localOnly") is True
    if not (base and model and (secret or local_only)):
        raise ValueError("DeepSeek Harness requires a managed model endpoint, credential and model")
    protocol = "anthropic-messages" if llm.get("kind") == "anthropic" else "openai-completions"
    context_limit = context_window.resolve(llm)["contextWindow"]
    output_limit = min(runtime_images.model_fields(llm).get("maxOutputTokens", DEFAULT_OUTPUT), context_limit)
    profile = {
        "displayName": "SoduWork",
        "baseURL": base.rstrip("/"),
        "api": protocol,
        "models": [{"id": model, "name": model,
                    "input": ["text", "image"] if runtime_images.transport_supported(llm) else ["text"],
                    "contextWindow": context_limit, "maxTokens": output_limit}],
    }
    if secret:
        profile["apiKeyEnv"] = KEY_ENV
    if protocol == "openai-completions":
        profile["compat"] = {"supportsStore": False, "supportsDeveloperRole": False,
                             "supportsReasoningEffort": False, "maxTokensField": "max_tokens"}
    # A shared model service credential must not become the native DeepSeek search
    # credential, whose separate endpoint remains api.deepseek.com.
    for name in ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"):
        env.pop(name, None)
    if secret:
        env[KEY_ENV] = secret
    else:
        env.pop(KEY_ENV, None)
    env.update({PROFILE_ENV: json.dumps({PROVIDER: profile}, ensure_ascii=False),
                "DSH_PROVIDER": PROVIDER, "DSH_MODEL": model, "DSH_ACP_MODELS": model,
                "DSH_MAX_TOKENS": str(output_limit)})
