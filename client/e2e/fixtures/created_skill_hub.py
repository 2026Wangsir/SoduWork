"""Authenticated loopback fixture for generated skill installation."""
import asyncio
import os
from pathlib import Path
import secrets
import sys

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["AUTH_SECRET"] = secrets.token_hex(32)
os.environ["ADMIN_PASS"] = secrets.token_hex(20)
os.environ["CLUSTER_REDIS_URL"] = ""
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "hub-backend"))

import uvicorn
from app.api import plugin_client_catalog
from skill_test_support import fixture


async def main():
    root = Path(sys.argv[2]).resolve()
    if not root.name.startswith("soduwork-skill-e2e-"):
        raise RuntimeError("Requires an isolated temporary directory")
    app, tokens, _sessions, cleanup = await fixture(root)
    app.include_router(plugin_client_catalog.router)
    mutations = {"imports": 0, "selections": 0}

    @app.middleware("http")
    async def observe_mutations(request, call_next):
        if request.method == "POST" and request.url.path == "/api/v1/skills/import":
            mutations["imports"] += 1
        if request.method == "PUT" and request.url.path == "/api/v1/skills":
            mutations["selections"] += 1
        return await call_next(request)

    @app.get("/fixture/mutations")
    async def mutation_counts():
        return dict(mutations)

    @app.get("/fixture/auth")
    async def auth():
        return tokens

    @app.get("/healthz")
    async def health():
        return {"ok": True, "version": "isolated-test"}

    try:
        await uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=int(sys.argv[1]),
                                          log_level="warning", access_log=False)).serve()
    finally:
        await cleanup()


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
