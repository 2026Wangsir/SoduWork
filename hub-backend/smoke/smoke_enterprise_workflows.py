"""Offline contracts for the enterprise development plugins and shared post-deployment verification
protocol.
"""
from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./.smoke-enterprise-workflows.db"

from app.services import (
    deploy_verify,
    preflight_evidence,
    plugin_packages,
    project_setup,
    workflow_contracts,
)


ROOT = os.path.dirname(os.path.dirname(__file__))
SHA = "a" * 40
passed = 0
failed = 0


def check(name: str, condition, detail=None) -> None:
    global passed, failed
    if condition:
        passed += 1
        print("PASS", name)
    else:
        failed += 1
        print("FAIL", name, detail if detail is not None else "")


def load(name: str) -> tuple[dict, dict]:
    path = os.path.join(ROOT, "plugins", name)
    with open(path, encoding="utf-8") as stream:
        raw = json.load(stream)
    manifest, workflow, _capabilities = plugin_packages.normalize(raw)
    return manifest, workflow


def plugin_contracts() -> None:
    software, software_flow = load("software-delivery.json")
    bugfix, bugfix_flow = load("project-validation-release.json")
    software_nodes = list(software_flow["nodes"])
    bugfix_nodes = list(bugfix_flow["nodes"])
    software_by = {node["key"]: node for node in software_nodes}
    bugfix_by = {node["key"]: node for node in bugfix_nodes}

    check("需求到发布插件升级为不可变新版本",
          software["version"] == "1.7.7")
    check("需求到发布节点顺序完整",
          [node["key"] for node in software_nodes] == [
              "analyze", "baseline", "implement", "quality", "review",
              "merge", "releaseChain", "verifyRelease", "publish",
          ])
    analyze_outputs = {item["key"]: item for item in software_by["analyze"]["outputs"]}
    check("需求分析同时交付基线与结构化前置结论",
          analyze_outputs.get("requirements", {}).get("kind") == "file"
          and analyze_outputs.get("preflight", {}).get("kind") == "decision")
    check("需求仍保留人工基线确认",
          software_by["baseline"]["type"] == "spec"
          and software_by["implement"]["dependsOn"] == ["baseline"])
    implement_policy = dict(software_by["implement"]["config"].get(
        "executionPolicy") or {})
    check("Pi 实施节点允许少量针对性自测且全量检查仍由质量门禁负责",
          implement_policy.get("maxVerificationCommands") == 6
          and software_by["implement"]["config"].get("agentKind") == "local:pi"
          and implement_policy.get("authoritativeQuality") is True
          and software_by["quality"]["type"] == "quality")
    check("AI 独立审查固定使用 Codex 高能力模型且支持受控返修",
          software_by["review"]["config"].get("agentKind") == "local:codex"
          and software_by["review"]["config"].get("model") == "gpt-5.6-sol"
          and software_by["review"]["config"].get("reasoningEffort") == "max"
          and software_by["review"]["config"]["onFailure"].get("maxRounds") == 5)
    check("需求实现明确覆盖完整前后端或服务边界",
          "完整前后端或服务边界" in software_by["analyze"]["config"]["prompt"]
          and "不得只做后端或只做界面" in software_by["analyze"]["config"]["prompt"]
          and "完整用户路径" in software_by["implement"]["config"]["prompt"]
          and "关键路径可复核证据" in software_by["implement"]["config"]["prompt"])

    check("Bug 闭环升级为不可变新版本",
          bugfix["version"] == "1.5.7")
    check("Bug 到发布后验证节点顺序完整",
          [node["key"] for node in bugfix_nodes] == [
              "scope", "implement", "quality", "review", "merge",
              "releaseChain", "verifyRelease", "publish",
          ])
    bug_outputs = {item["key"]: item for item in bugfix_by["scope"]["outputs"]}
    bug_scope_policy = dict(bugfix_by["scope"]["config"].get(
        "executionPolicy") or {})
    check("Bug preflight permits bounded real verification",
          bug_scope_policy.get("maxVerificationCommands") == 2
          and bug_scope_policy.get("adHocProbe") == "forbid"
          and bug_scope_policy.get("containerOrchestration") == "forbid")
    evidence_mode = bugfix_by["scope"]["config"].get("preflightEvidenceMode")
    evidence_prompt = preflight_evidence.prompt(evidence_mode)
    check("Bug clean preflight uses strict contract/source/runtime evidence",
          evidence_mode == preflight_evidence.CONTRACT_SOURCE_RUNTIME
          and "exact externally observable contract" in evidence_prompt
          and "exact source file and code path" in evidence_prompt
          and "regression test that fails before" in evidence_prompt
          and "authoritative quality gate remains mandatory" in evidence_prompt)

    check("Bug 必须先形成稳定复现和结构化执行结论",
          bug_outputs.get("preflight", {}).get("kind") == "decision"
          and "稳定可复现" in bugfix_by["scope"]["config"]["prompt"]
          and "no_reproducible_issue" in bugfix_by["scope"]["config"]["prompt"])
    check("Bug 修复必须形成修复前失败与修复后通过的回归证据",
          "修复前失败" in bugfix_by["implement"]["config"]["prompt"]
          and "修复后通过" in bugfix_by["implement"]["config"]["prompt"]
          and "最小根因修复" in bugfix_by["implement"]["config"]["prompt"])
    check("Bug 独立审查固定使用 Codex 高能力模型且支持受控返修",
          bugfix_by["review"]["config"].get("agentKind") == "local:codex"
          and bugfix_by["review"]["config"].get("model") == "gpt-5.6-sol"
          and bugfix_by["review"]["config"].get("reasoningEffort") == "max"
          and bugfix_by["review"]["config"]["onFailure"].get("maxRounds") == 5
          and bugfix_by["review"]["retry"].get("maxAttempts") == 5)

    for label, nodes, by in (
            ("需求", software_nodes, software_by),
            ("Bug", bugfix_nodes, bugfix_by)):
        verify = by["verifyRelease"]
        check(label + "发布核对直连发布链与合并版本",
              verify["type"] == "validate"
              and set(verify["dependsOn"]) == {"releaseChain", "merge"}
              and verify["config"].get("deployVerify") is True
              and verify["config"].get("shaCheck") is True)
        check(label + "只有核对成功后才完成交付",
              by["publish"]["dependsOn"] == ["verifyRelease"])
        check(label + "保留真实自测、AI 审查和自动合并",
              any(node["type"] == "quality"
                  and any(command.get("argv") == ["project:selftest"]
                          for command in node["config"].get("commands", []))
                  for node in nodes)
              and by["review"]["type"] == "ai_review"
              and by["merge"]["config"].get("autoSubmit") is True)
        encoded = json.dumps({"nodes": nodes}, ensure_ascii=False)
        check(label + "流程不写死 trial、IP、端口或环境标识",
              "192.0.2.10" not in encoded
              and "environmentKey" not in encoded
              and "environmentId" not in encoded)

    standard_labels = [item["label"] for item in project_setup.MODES["standard"]["journey"]]
    validation_labels = [item["label"] for item in project_setup.MODES["validation"]["journey"]]
    check("项目配置页展示需求到发布完整旅程",
          "需求规格与执行预检" in standard_labels
          and "环境健康检查" in standard_labels
          and "交付事实核对" in standard_labels)
    check("项目配置页展示 Bug 发布后回归旅程",
          "稳定复现与执行预检" in validation_labels
          and "发布后回归检查" in validation_labels
          and "交付事实核对" in validation_labels)


class FakeSession:
    def __init__(self):
        self.commits = 0

    async def commit(self):
        self.commits += 1

    async def get(self, *_args, **_kwargs):
        return None


async def verify_protocol() -> None:
    session = FakeSession()
    node = {"config": {"deployVerify": True, "shaCheck": True, "http": []}}

    direct = SimpleNamespace(input={"dependencies": {
        "publish": {"deployStatus": "SUCCESS", "artifactSha": SHA},
        "merge": {"commit": SHA},
    }}, output={})
    direct_output = await deploy_verify.verify(session, None, direct, node)
    check("原公司 CICD 发布核对协议保持兼容",
          direct_output["mode"] == "cicd"
          and direct_output["shaMatch"] is True
          and direct_output["deployStatus"] == "SUCCESS")

    chain = SimpleNamespace(input={"dependencies": {
        "releaseChain": {
            "complete": True,
            "runs": [{
                "targetId": "",
                "targetName": "生产数据分析 CICD",
                "state": "succeeded",
                "commit": SHA,
                "verification": {
                    "state": "passed",
                    "planned": 1,
                    "completed": 1,
                    "checks": [{
                        "name": "服务健康检查",
                        "type": "http",
                        "ok": True,
                        "detail": "HTTP 200",
                    }],
                },
            }],
        },
        "merge": {"commit": SHA},
    }}, output={})
    chain_output = await deploy_verify.verify(session, None, chain, node)
    check("通用企业环境链可以执行发布后事实核对",
          chain_output["mode"] == "environment-chain"
          and chain_output["shaMatch"] is True
          and chain_output["assertions"] == 1
          and all(item["ok"] for item in chain_output["checks"]))

    mismatch = SimpleNamespace(input={"dependencies": {
        "releaseChain": {
            "complete": True,
            "runs": [{
                "targetId": "",
                "targetName": "生产数据分析 CICD",
                "state": "succeeded",
                "commit": "b" * 40,
                "verification": {"state": "passed", "checks": []},
            }],
        },
        "merge": {"commit": SHA},
    }}, output={})
    try:
        await deploy_verify.verify(session, None, mismatch, node)
    except ValueError as exc:
        check("环境链部署了错误版本时必须拦住",
              "版本与合并版本一致" in str(exc)
              and mismatch.output.get("shaMatch") is False)
    else:
        check("环境链部署了错误版本时必须拦住", False, mismatch.output)

    missing_merge = SimpleNamespace(input={"dependencies": {
        "releaseChain": {"complete": True, "runs": []},
    }}, output={})
    try:
        await deploy_verify.verify(session, None, missing_merge, node)
    except workflow_contracts.WorkflowContractError as exc:
        check("发布核对拿不到合并版本时明确报告插件接线错误",
              "dependsOn 带上 merge" in str(exc))
    else:
        check("发布核对拿不到合并版本时明确报告插件接线错误", False)

    check("成功和失败的发布后核对都先持久化证据",
          session.commits == 3, session.commits)


async def main() -> None:
    plugin_contracts()
    await verify_protocol()
    print(f"\nenterprise workflow smoke: {passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
