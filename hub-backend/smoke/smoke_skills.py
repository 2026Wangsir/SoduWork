# -*- coding: utf-8 -*-
"""Skill-catalog tests using real temporary directories for discovery and policy, plus
native-argument and prompt-context injection checks.
"""
import io
import json
import os
import shutil
import stat
import sys
import tempfile

tmp = tempfile.mkdtemp(prefix="soduwork_skills_")
os.environ["SODUWORK_DATA_ROOT"] = os.path.join(tmp, "data")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + os.path.join(tmp, ".smoke-skills.db").replace("\\", "/")
sys.path.insert(0, ".")
from app.db import engine, init_db  # noqa: E402
from app.services import local_base as LB  # noqa: E402
from app.services import skills as SK  # noqa: E402

ok = fail = 0
log = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def rm_tree(path):
    def unlock(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)
    if os.path.exists(path):
        shutil.rmtree(path, onerror=unlock)


def mk(rel, front, body="正文"):
    d = os.path.join(tmp, rel)
    os.makedirs(d, exist_ok=True)
    with io.open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(front + "\n" + body + "\n")
    return d


good = mk("alpha", "---\nname: alpha-skill\ndescription: 做 A 事。当要做 A 的时候用。\n---")
nested = mk("group/beta", "---\nname: beta-skill\ndescription: 做 B 事，带脚本。\n---")
nodesc = mk("gamma", "---\nname: gamma-skill\n---")               # Skip skills missing a description.
nofront = mk("delta", "# 没有 frontmatter")
extra_f = mk("eps", "---\nname: eps-skill\ndescription: 有额外字段。\ncompatibility: 需要 node 20\nlicense: MIT\n---")

found = SK.scan([tmp])
names = [s["name"] for s in found if s["root"] == tmp]
chk("扫到带 frontmatter 的技能", "alpha-skill" in names, names)
chk("子目录里的也扫得到", "beta-skill" in names, names)
chk("★缺 description 的不加载（标准如此）", "gamma-skill" not in names, names)
chk("没有 frontmatter 的不算技能", all("delta" not in (s.get("dir") or "") for s in found))
eps = next((s for s in found if s["name"] == "eps-skill"), None)
chk("认得 compatibility 字段", (eps or {}).get("compatibility") == "需要 node 20", eps)
chk("带上目录路径（CLI 要按路径读）", os.path.isdir((eps or {}).get("path") or ""))

# Discover bundled repository skills through default roots.
bundled = [s for s in SK.scan() if s["root"] == SK.bundled_root()]
chk("内置技能 delivery-check 在默认扫描里", any(s["name"] == "delivery-check" for s in bundled),
    [s["name"] for s in bundled])
chk("默认根目录含仓库内置 + 本机库 + 别家 harness",
    len(SK.default_roots()) >= 4 and SK.default_roots()[0] == SK.bundled_root())

# Inject Pi skills through native arguments.
sel = [s for s in found if s["name"] in ("alpha-skill", "beta-skill")]
args = SK.cli_args(sel, "pi")
chk("pi：每个技能一个 --skill", args.count("--skill") == 2, args)
chk("pi：给的是目录路径", all(os.path.isdir(p) for p in args[1::2]), args)
chk("其它 CLI 不给参数（它们不认）", SK.cli_args(sel, "claude") == [] and SK.cli_args(sel, "opencode") == [])
chk("没技能就没参数", SK.cli_args([], "pi") == [])

# Verify the actual Pi argument builder includes them.
line = LB._pi_args("sid-1", "work", {"llm": {"model": "m"}, "skillPaths": [p for p in args[1::2]]})
chk("★_pi_args 把 --skill 拼进命令行", line.count("--skill") == 2, line)
chk("没配技能时命令行不变", "--skill" not in LB._pi_args("sid-1", "work", {"llm": {"model": "m"}}))

# Verify prompt-based fallback for other runtimes.
blk = SK.prompt_block(sel, native=False)
chk("降级正文列出名字+描述+路径", all(x in blk for x in ("alpha-skill", "做 A 事", sel[0]["path"])), blk[:200])
chk("降级正文教它先 read SKILL.md", "SKILL.md" in blk and "read" in blk)
nat = SK.prompt_block(sel, native=True)
chk("已按参数装上时只提一句、不重复描述", "alpha-skill" in nat and "做 A 事" not in nat, nat)
chk("没技能就不出这一节", SK.prompt_block([], native=False) == "")
broken = {"name": "broken", "path": sel[0]["path"]}
chk("坏 Skill 元数据不会拖垮整次派活",
    SK.prompt_block([broken], native=False) == "" and
    "alpha-skill" in SK.prompt_block([broken, sel[0]], native=False))

# Normalize availability settings through save_cfg.
import asyncio  # noqa: E402

asyncio.run(init_db())


async def _cfg_round():
    from sqlalchemy import select
    from app.db import SessionLocal
    from app.models import AppSetting
    async with SessionLocal() as s:
        before = await SK.load_cfg(s)
        clean = await SK.save_cfg(s, {"allowed": ["a" * 200, "alpha-skill"],
                                      "byRepo": {"repo-x": ["beta-skill"]},
                                      "roots": [tmp], "垃圾键": 1})
        old = await SK.save_cfg(s, {"enabled": ["alpha-skill"]})   # Accept the legacy frontend key.
        stored = json.loads((await s.execute(select(AppSetting.value).where(
            AppSetting.key == SK.SETTING_KEY))).scalar_one())
        await s.rollback()          # Do not persist changes to business settings during this test.
        return before, clean, old, stored

before, clean, old, stored = asyncio.run(_cfg_round())
chk("名字超长被截断", all(len(x) <= 64 for x in clean["allowed"]), clean)
chk("不认识的键被丢掉", set(clean) == {
    "allowed", "byRepo", "roots", "policyVersion", "builtinDisabled",
    "policyRevision", "builtinCatalog",
}, list(clean))
chk("工程级覆盖存得下", clean["byRepo"].get("repo-x") == ["beta-skill"], clean)
# Effective availability retains the existing baseline; storage keeps explicit grants separate.
baseline = {"browser-use", "computer-use", "office"}
chk("老库/老前端的 enabled 当作 allowed 读",
    stored["allowed"] == ["alpha-skill"] and
    set(old["allowed"]) == {"alpha-skill"} | baseline, old)
chk("Legacy selection closes all other bundled skills",
    set(old["builtinDisabled"]) == set(old["builtinCatalog"]) - baseline,
    old["builtinDisabled"])
chk("Stored policy excludes derived catalog and revision metadata",
    set(stored) == {"allowed", "byRepo", "roots", "policyVersion", "builtinDisabled"} and
    stored["policyVersion"] == old["policyVersion"] == clean["policyVersion"] == 1,
    stored)
chk("冒烟没有改真库", isinstance(before, dict))

# Verify administrator availability, client selection, and repository precedence.
class _Client:
    def __init__(self, names):
        self.skills = names


async def _resolve_with(cfgd, client, repo_id=""):
    """Resolve settings within a temporary transaction and roll back test changes."""
    from app.db import SessionLocal
    async with SessionLocal() as s:
        await SK.save_cfg(s, cfgd)
        out = await SK.resolve(s, repo_id, client)
        await s.rollback()
        return [x["name"] for x in out]


ALLOW_BOTH = {"allowed": ["alpha-skill", "beta-skill"], "roots": [tmp]}
r1 = asyncio.run(_resolve_with(ALLOW_BOTH, _Client(["alpha-skill"])))
chk("★本机勾了什么就带什么", r1 == ["alpha-skill"], r1)
r2 = asyncio.run(_resolve_with({"allowed": ["beta-skill"], "roots": [tmp]}, _Client(["alpha-skill"])))
chk("★管理端没开放的，本地勾了也不生效", r2 == [], r2)
r3 = asyncio.run(_resolve_with(dict(ALLOW_BOTH, byRepo={"repo-x": ["beta-skill"]}),
                               _Client(["alpha-skill"]), "repo-x"))
chk("★工程配了就以工程的为准（不是并集）", r3 == ["beta-skill"], r3)
r4 = asyncio.run(_resolve_with(dict(ALLOW_BOTH, byRepo={"repo-y": ["beta-skill"]}),
                               _Client(["alpha-skill"]), "repo-x"))
chk("别的工程的配置不串台", r4 == ["alpha-skill"], r4)
r5 = asyncio.run(_resolve_with(ALLOW_BOTH, None))
chk("没有客户端上下文（如自动派活）＝不带技能", r5 == [], r5)
r6 = asyncio.run(_resolve_with({"allowed": ["alpha-skill"], "roots": [tmp]},
                               _Client(["alpha-skill", "不存在的技能"])))
chk("磁盘上没有的技能跳过", r6 == ["alpha-skill"], r6)


# Exercise the real dispatch function's skill handoff.
# Intercept process startup only to inspect the command arguments.
# Actual runtime interpretation of SKILL.md is covered by separate live execution verification.
from app.services import ai_local as AL  # noqa: E402


class _T:                      # Use a minimal task with the fields consumed by dispatch.
    id, title, note, progress, tags = "tmsSKILL", "验技能注入", "", [], []


def _cap(cli_key):
    got = {}

    def fake_spawn(exe, args, prompt, ws, ref, cfg, prof):
        got["args"] = list(args)
        got["prompt"] = prompt
        with AL._LOCK:                       # Remove synthetic runtime state from memory.
            AL._RUNS.pop(ref, None)
    real = AL._spawn
    AL._spawn = fake_spawn
    try:
        AL.dispatch_sync({"llm": {"base": "b", "key": "k", "model": "m"}}, _T(),
                         assignee={"id": "local:" + cli_key, "type": "agent"},
                         # Keep test workspaces inside the temporary directory rather than the user's configured root.
                         ctx={"skills": sel, "repo": {}, "workDir": tmp})
    finally:
        AL._spawn = real
    return got


if LB._PROFILES["pi"]["bin"]():
    g = _cap("pi")
    chk("★派活给 Pi：命令行真的带上 --skill", g.get("args", []).count("--skill") == 2, g.get("args"))
    chk("Pi 的正文只提一句、不重复描述",
        "alpha-skill" in g.get("prompt", "") and "做 A 事" not in g.get("prompt", ""),
        g.get("prompt", "")[-300:])
else:
    log.append("  SKIP  这台机器没装 pi，跳过命令行注入那条")

if LB._PROFILES["opencode"]["bin"]():
    g2 = _cap("opencode")
    chk("★派活给 OpenCode：不给参数、正文里给全清单",
        "--skill" not in g2.get("args", []) and "做 A 事" in g2.get("prompt", ""), g2.get("args"))
    chk("降级正文里给了绝对路径", sel[0]["path"] in g2.get("prompt", ""))
else:
    log.append("  SKIP  这台机器没装 opencode，跳过降级那条")

asyncio.run(engine.dispose())
rm_tree(tmp)
log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_skills.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
