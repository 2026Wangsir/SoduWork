"""Versioned built-in defaults without granting imported or host-local Skills."""
from __future__ import annotations

import json
import hashlib
import os


VERSION = 1


def revision(raw: str | None) -> str:
    """Identify an exact stored policy without exposing or persisting its text."""
    payload = b"missing" if raw is None else b"stored:" + raw.encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _names(value) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(name, str) for name in value):
        raise ValueError("Skill names must be a list of strings")
    return list(dict.fromkeys(value))


def decode(raw: str | None) -> tuple[dict, bool]:
    """Distinguish first installation and valid legacy settings from corrupt policy."""
    empty = {"allowed": [], "byRepo": {}, "roots": [],
             "policyVersion": VERSION, "builtinDisabled": []}
    if raw is None:
        return empty, True
    try:
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Skill policy must be an object")
        version = value.get("policyVersion")
        legacy = "policyVersion" not in value
        if not legacy and (type(version) is not int or version != VERSION):
            raise ValueError("Unsupported Skill policy version")
        allowed = value.get("allowed")
        by_repo = value.get("byRepo", {})
        roots = value.get("roots", [])
        if legacy:
            if allowed is None:
                allowed = value.get("enabled")
                if allowed is None:
                    allowed = []
            if by_repo is None:
                by_repo = {}
            if roots is None:
                roots = []
        if not isinstance(by_repo, dict):
            raise ValueError("Repository selections must be an object")
        return {"allowed": _names(allowed),
                "byRepo": {str(key): _names(names) for key, names in by_repo.items()},
                "roots": _names(roots),
                "policyVersion": VERSION,
                "builtinDisabled": [] if legacy else _names(value["builtinDisabled"])}, legacy
    except (ValueError, TypeError, KeyError):
        # Invalid settings are not a first installation and cannot reopen Skills.
        return {**empty, "policyVersion": None}, False


def builtin_names(rows: list[dict], bundled_root: str) -> set[str]:
    """Trust the final Hub filesystem row, never a portable flag or Runner label."""
    expected = os.path.normcase(os.path.abspath(bundled_root))
    names = set()
    for row in rows:
        if row.get("scope") or row.get("runtimeLocal") or row.get("packageChecksum"):
            continue
        root, path = str(row.get("root") or ""), str(row.get("path") or "")
        if not root or not path or not row.get("name"):
            continue
        root = os.path.normcase(os.path.abspath(root))
        path = os.path.normcase(os.path.abspath(path))
        try:
            inside = os.path.commonpath([expected, path]) == expected
        except ValueError:
            inside = False
        if root == expected and inside:
            names.add(row["name"])
    return names


def effective(cfg: dict, rows: list[dict], bundled_root: str, baseline) -> dict:
    """Expose the effective allowlist while keeping defaults out of explicit grants."""
    names = builtin_names(rows, bundled_root)
    allowed = set(cfg.get("allowed") or [])
    if cfg.get("policyVersion") == VERSION:
        allowed.difference_update(names)
        allowed.update(names - (set(cfg.get("builtinDisabled") or []) - set(baseline)))
    return {**cfg, "allowed": sorted(allowed), "builtinCatalog": sorted(names)}
