"""Seed isolated native tests with validated public SDK packages, never user config."""
import json
import os
from pathlib import Path
import shutil

from app.services import opencode_dependencies as dependencies


def seed(binary, data_root):
    source = Path(os.environ.get("SODUWORK_TEST_OPENCODE_DEPENDENCIES") or
                  Path(binary).parent.parent / "config" / "opencode").resolve()
    package = dependencies._json(source / "package.json")
    version = package["dependencies"]["@opencode-ai/plugin"]
    expected = dependencies._validate(source, version)
    assert dependencies._json(source / "node_modules" / dependencies._RECEIPT) == expected
    lock = dependencies._json(source / "package-lock.json")
    target = Path(data_root) / "agents" / "opencode" / "config" / "opencode"
    target.mkdir(parents=True, exist_ok=True)
    for name in ("package.json", "package-lock.json"):
        shutil.copyfile(source / name, target / name)
    for relative, row in lock["packages"].items():
        if not relative:
            continue
        origin = dependencies._path(source, relative)
        if not origin.exists() and row.get("optional"):
            continue
        assert str(row.get("resolved") or "").startswith("https://registry.npmjs.org/")
        destination = dependencies._path(target, relative)
        shutil.copytree(origin, destination, ignore=shutil.ignore_patterns("node_modules"), dirs_exist_ok=True)
    assert dependencies._validate(target, version) == expected
    (target / "node_modules" / dependencies._RECEIPT).write_text(json.dumps(expected), encoding="utf-8")
