# -*- coding: utf-8 -*-
"""Offline Git credential tests for masked storage, validation, subprocess injection, real commit
identity, and every dispatch entry point. Cover self-authenticated runtimes before needs_llm
early returns and inspect actual Git results, not context shape alone.
"""
import ast
import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

sys.path.insert(0, ".")

SMOKE_DATA = os.path.abspath(".smoke-gitcreds-data")
shutil.rmtree(SMOKE_DATA, ignore_errors=True)
os.environ["SODUWORK_DATA_ROOT"] = SMOKE_DATA

from app import models  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.services import ai_exec, code_creds  # noqa: E402
from app.services.local_base import _PROFILES, _env_for  # noqa: E402
from live_test_support import seed_active_device  # noqa: E402

ok = fail = 0
log = []
BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:9080").rstrip("/") + "/api/v1"
CID = "u-smoke-gitcreds"
SECRET = "smoke-token-DO-NOT-LEAK"
DEVICE_SECRET = "smoke-gitcreds-device-secret-0123456789abcdef"


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def call(method, path, body=None, device=CID, timeout=60):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json; charset=utf-8")
    req.add_header("X-Soduwork-Device", device)
    req.add_header("X-Soduwork-Secret", DEVICE_SECRET)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


async def purge():
    async with SessionLocal() as s:
        c = await s.get(models.Client, CID)
        if c is not None:
            await s.delete(c)
            await s.commit()


def git(ws, *a, env=None):
    p = subprocess.run(["git", *a], cwd=ws, env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=90)
    return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()


# Static dispatch-entry coverage.
def dispatch_sites():
    """Find functions that dispatch work and check whether they apply task-owner Git credentials."""
    out = []
    for root, _, fs in os.walk("app"):
        if "__pycache__" in root:
            continue
        for f in fs:
            if not f.endswith(".py"):
                continue
            p = os.path.join(root, f)
            src = io.open(p, encoding="utf-8", errors="replace").read()
            try:
                tree = ast.parse(src)
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                # Inspect AST name references rather than searching source text.
                # Comments mentioning dispatch functions must not count as execution paths.
                # Function references may be arguments to worker helpers.
                # Detect to_thread(ai_exec.dispatch_sync, ...) as well as direct calls.
                # AST reference checks exclude comment and string mentions.
                refs = {getattr(n, "attr", None) or getattr(n, "id", None)
                        for n in ast.walk(node) if isinstance(n, (ast.Attribute, ast.Name))}
                if "dispatch_sync" in refs and node.name != "dispatch_sync":
                    body = ast.get_source_segment(src, node) or ""
                    out.append((p.replace("\\", "/"), node.name, "with_task_git" in body))
    return out


async def main():
    await purge()
    async with SessionLocal() as s:
        await seed_active_device(
            s, CID, DEVICE_SECRET, name="（冒烟）代码账号",
            platform="live-smoke", app_version="live-gate")
        await s.commit()

    # Verify masked storage and validation.
    st, raw = call("PUT", "/my-git", {"name": "冒烟机器人", "email": "smoke@example.com",
                                      "user": "smokeuser", "token": SECRET})
    chk("PUT /my-git 存得下", st == 200, (st, raw[:200]))
    st, raw = call("GET", "/my-git")
    chk("GET /my-git 通", st == 200, st)
    chk("★★明文 token **永不回显**", SECRET not in raw, "响应里出现了明文")
    g = json.loads(raw)["git"]
    chk("只回「配没配 + 多少位」", g["tokenSet"] and g["tokenLen"] == len(SECRET) and "token" not in g, g)
    chk("★身份和凭据分开算（两件事，不能用一个布尔糊过去）",
        g["identityReady"] is True and g["pushReady"] is True and g["ready"] is True, g)
    chk("顺带给出可以拿来测的仓库地址（不然「测一下」没法用）",
        isinstance(json.loads(raw).get("repos"), list))

    st, raw = call("PUT", "/my-git", {"email": "不是邮箱"})
    chk("邮箱格式不对被拦住", st == 400, (st, raw[:120]))
    st, raw = call("PUT", "/my-git", {"key": "ssh-rsa AAAAB3Nz... me@host"})
    chk("★贴成公钥被拦住（最常见的贴错）", st == 400 and "公钥" in raw, (st, raw[:160]))
    st, raw = call("PUT", "/my-git", {"key": "-----BEGIN RSA PRIVATE KEY-----\n"
                                             "Proc-Type: 4,ENCRYPTED\n\nx\n-----END RSA PRIVATE KEY-----"})
    chk("★带口令的私钥被拦住（后台进程输不了口令）", st == 400 and "口令" in raw, (st, raw[:160]))
    chk("界面话术里不许有 markdown 记号（这些字直接进 HTML）", "**" not in raw, raw[:160])
    st, raw = call("GET", "/my-git")
    chk("★状态说明别和标题重复（真图上出现过「配好了配好了」）",
        not json.loads(raw)["git"]["why"].startswith("配好了"), json.loads(raw)["git"]["why"])

    # Changing email without a token field preserves the stored token.
    call("PUT", "/my-git", {"email": "smoke2@example.com"})
    st, raw = call("GET", "/my-git")
    chk("★改别的字段不会把 token 冲掉（不传=不改）", json.loads(raw)["git"]["tokenSet"] is True)
    st, raw = call("PUT", "/my-git", {"token": None})
    chk("传 null 才是删掉 token", json.loads(raw)["git"]["tokenSet"] is False, raw[:160])
    call("PUT", "/my-git", {"token": SECRET})

    # Validate incompatible URL/credential combinations without network requests.
    st, raw = call("POST", "/my-git/test", {"url": "git@example.com:a/b.git"})
    chk("★SSH 地址但没配私钥 → 说人话，不去连", json.loads(raw)["ok"] is False and "私钥" in raw, raw[:160])
    st, raw = call("POST", "/my-git/test", {"url": ""})
    chk("没给地址被拦住", st == 400, st)

    # Verify credentials reach a real Git subprocess.
    async with SessionLocal() as s:
        c = await s.get(models.Client, CID)
        got = code_creds.resolve(c)
    chk("resolve 拿得到明文（只在派活那一刻）", got.get("token") == SECRET,
        {k: v for k, v in got.items() if k not in code_creds.SECRETS})

    async with SessionLocal() as s:
        ctx = await ai_exec.load(s, force=True)
    # Use the actual current local-provider context shape.
    chk("★真实 ctx 的形状是 {name,cfg}（造假数据前先看真的长什么样）",
        "cfg" in ctx and ctx.get("name") == "local", sorted(ctx.keys()))
    ctx2 = ai_exec.with_git(ctx, got)
    chk("★★with_git 写进 cfg **里面**，不是 ctx 顶层",
        ("git" in (ctx2.get("cfg") or {})) and "git" not in ctx2, sorted(ctx2.keys()))
    chk("原件不动（回的是新 ctx）", "git" not in (ctx.get("cfg") or {}))

    # Pi requires this dispatch's model; no inference occurs in this Git-only check.
    runtime_cfg = {**(ctx2.get("cfg") or {}), "llm": {
        "base": "http://127.0.0.1:9/v1", "key": "git-smoke-fixture", "model": "git-smoke"}}
    for cli in ("pi", "opencode", "claude"):
        env = _env_for(_PROFILES[cli], runtime_cfg)
        n = int(env.get("GIT_CONFIG_COUNT") or 0)
        keys = [env.get("GIT_CONFIG_KEY_%d" % i) for i in range(n)]
        vals = [env.get("GIT_CONFIG_VALUE_%d" % i, "") for i in range(n)]
        chk("「%s」子进程环境里有提交身份" % cli,
            env.get("GIT_AUTHOR_NAME") == "冒烟机器人" and keys[:2] == ["user.name", "user.email"],
            (n, keys, env.get("GIT_AUTHOR_NAME")))
        chk("★「%s」credential.helper **先清空再加**（不清的话本机的 GCM 会抢过去挂死）" % cli,
            keys.count("credential.helper") == 2 and vals[keys.index("credential.helper")] == "",
            list(zip(keys, [v[:20] for v in vals])))
        chk("★「%s」明文 token 不进 git 配置，只在环境变量里" % cli,
            not any(SECRET in v for v in vals) and env.get("SODUWORK_GIT_TOKEN") == SECRET)
        chk("★「%s」GIT_TERMINAL_PROMPT=0（缺了它凭据不对时会停在提示符上，表现成任务卡死）" % cli,
            env.get("GIT_TERMINAL_PROMPT") == "0", env.get("GIT_TERMINAL_PROMPT"))

    # Create a real repository and commit to verify author identity.
    ws = tempfile.mkdtemp(prefix="smoke-gitid-")
    try:
        git(ws, "init", "-q", "-b", "main")
        io.open(os.path.join(ws, "a.txt"), "w").write("hi")
        env = _env_for(_PROFILES["pi"], runtime_cfg)
        git(ws, "add", "a.txt", env=env)
        c0, o0 = git(ws, "commit", "-q", "-m", "smoke", env=env)
        chk("★★真跑一次 git commit 成功", c0 == 0, o0[:200])
        who = git(ws, "log", "-1", "--format=%an <%ae>|%cn <%ce>", env=env)[1]
        chk("★★作者**和**提交者都是这个人（gerrit 认的是提交者）",
            who == "冒烟机器人 <smoke2@example.com>|冒烟机器人 <smoke2@example.com>", who)
        cfg_txt = io.open(os.path.join(ws, ".git", "config"), encoding="utf-8",
                          errors="replace").read()
        chk("★没往仓库的 .git/config 里写任何东西（工作目录常常是人的真仓库）",
            "user" not in cfg_txt.lower().replace("[remote", ""), cfg_txt[:200])
        chk("★★明文 token 没落进 .git/config", SECRET not in cfg_txt)
    finally:
        shutil.rmtree(ws, ignore_errors=True)

    # Check every dispatch entry point.
    sites = dispatch_sites()
    chk("扫得到派活入口（扫不到说明这条检查本身失效了）", len(sites) >= 4, sites)
    missing = [(p, n) for p, n, has in sites if not has]
    chk("★★每个调 dispatch_sync 的地方都带上了代码账号（漏一个就是那个入口悄悄不生效）",
        not missing, missing)

    # Remove test fixtures.
    await purge()
    async with SessionLocal() as s:
        chk("★冒烟 SoduWork 已删干净", await s.get(models.Client, CID) is None)
    left = [f for f in os.listdir(code_creds._store_dir())] if os.path.isdir(
        code_creds._store_dir()) else []
    chk("★没在磁盘上留下私钥文件（这一轮压根没用 SSH，目录该是空的或只有别人的）",
        all(not f.startswith("probe") for f in left), left)
    shutil.rmtree(SMOKE_DATA, ignore_errors=True)


try:
    asyncio.run(main())
finally:
    asyncio.run(purge())
    shutil.rmtree(SMOKE_DATA, ignore_errors=True)
log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_gitcreds.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
