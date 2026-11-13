"""Offline release gate for representative evaluations on critical delivery plugins."""
from __future__ import annotations

import json
import os

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./.smoke-critical-plugin-evals.db")

from app.services import plugin_packages  # noqa: E402


ROOT = os.path.dirname(os.path.dirname(__file__))
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


def load(filename: str) -> dict:
    with open(os.path.join(ROOT, "plugins", filename), encoding="utf-8") as stream:
        return json.load(stream)


EXPECTED = {
    "software-delivery.json": {
        "version": "1.7.7",
        "cases": {"complete-product-change", "missing-delivery-input"},
        "outputs": {"analyze.requirements", "analyze.preflight"},
        "release": True,
    },
    "project-validation-release.json": {
        "version": "1.5.7",
        "cases": {"reproducible-regression", "unreproducible-report"},
        "outputs": {"scope.requirements", "scope.preflight"},
        "release": True,
    },
    "engineering-delivery.json": {
        "version": "1.5.4",
        "cases": {"reproducible-regression", "unreproducible-report"},
        "outputs": {"scope.requirements", "scope.preflight"},
        "release": False,
    },

}


def contracts() -> None:
    check("retired Gerrit template is absent", not os.path.exists(os.path.join(ROOT, "plugins", "gerrit-autopilot.json")))
    for filename, expected in EXPECTED.items():
        raw = load(filename)
        manifest, workflow, report = plugin_packages.normalize(raw)
        cases = list(report.get("evaluationCases") or [])
        result_ids = {item["id"] for item in report.get("resultContract") or []}
        nodes = list(workflow.get("nodes") or [])
        keys = [node["key"] for node in nodes]
        types = [node["type"] for node in nodes]

        check(filename + " immutable version is raised",
              manifest["version"] == expected["version"], manifest["version"])
        check(filename + " has positive and blocked representative cases",
              len(cases) == 2
              and {case["key"] for case in cases} == expected["cases"], cases)
        check(filename + " evaluations target real result contracts",
              all(set(case["expectedOutputs"]) == expected["outputs"]
                  and set(case["expectedOutputs"]).issubset(result_ids)
                  for case in cases), cases)
        check(filename + " evaluation criteria are reviewable",
              all(len(case.get("criteria") or []) >= 4 for case in cases), cases)
        check(filename + " preserves AI review before automatic merge",
              "review" in keys and "merge" in keys
              and keys.index("review") < keys.index("merge")
              and bool(next(node for node in nodes
                            if node["key"] == "merge")["config"].get("autoSubmit")), keys)

        if expected["release"]:
            release_key = "releaseChain" if "releaseChain" in keys else "publish"
            verify_key = "verifyRelease" if "verifyRelease" in keys else "verify"
            verify = next((node for node in nodes if node["key"] == verify_key), {})
            check(filename + " release is downstream of merge and verified",
                  release_key in keys and verify_key in keys
                  and keys.index("merge") < keys.index(release_key) < keys.index(verify_key)
                  and bool(verify.get("config", {}).get("deployVerify"))
                  and bool(verify.get("config", {}).get("shaCheck")), keys)
        else:
            check(filename + " code-only workflow cannot deploy",
                  not set(types).intersection({"deploy", "deploy_chain"}), types)


if __name__ == "__main__":
    contracts()
    print("\ncritical plugin evaluations: PASS=%d FAIL=%d" % (passed, failed))
    raise SystemExit(1 if failed else 0)
