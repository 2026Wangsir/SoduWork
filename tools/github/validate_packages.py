"""Compile all native packages without authorizing public binary distribution.

Only the SHA-256 report leaves the ephemeral runner. Release publication still
uses build.py, reviewed signing credentials and the full installation gates.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import tempfile

from build import package_native
from release import ROOT, SHARDS, expected, read, require, write


def validation_context(env=None):
    env = os.environ if env is None else env
    repo = env.get("GITHUB_REPOSITORY", "")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "GitHub repository required")
    require(env.get("PACKAGE_VALIDATION_REPOSITORY") == repo, "Explicit validation repository required")
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual build validation only")
    require(re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")), "Commit required")
    require(re.fullmatch(r"[1-9]\d*", env.get("GITHUB_RUN_ID", "")), "Run ID required")
    version = read(ROOT / "client/package.json")["version"]
    return dict(component="client", version=version, repository=repo,
                commit=env["GITHUB_SHA"], runId=env["GITHUB_RUN_ID"])


def fingerprint(file):
    require(file.is_file() and not file.is_symlink() and file.stat().st_size > 1024 * 1024,
            "Missing or empty installer: " + file.name)
    with file.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return dict(name=file.name, bytes=file.stat().st_size, sha256=digest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shard", choices=SHARDS["client"])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    ctx = validation_context()
    with tempfile.TemporaryDirectory(prefix="soduwork-package-validation-") as temporary:
        scratch = Path(temporary)
        package_native(ctx, args.shard, scratch, validation=True)
        packages = ROOT / "client/dist"
        checks = {"ok": True, "checks": ["native-package-build", "packaged-runtime-verification"]}
        signing = "ad-hoc" if args.shard.startswith("macos-") else "unsigned"
        files = [fingerprint(packages / name) for name in expected(ctx, args.shard)]
        report = {**ctx, "shard": args.shard, "validationOnly": True,
                  "publicDistributionAllowed": False, "signing": signing,
                  "checks": checks, "files": files}
        write(args.output, report)
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as stream:
                stream.write(f"### {args.shard}: packages built\n\n")
                stream.write("Build validation only. Installers are not uploaded or published.\n\n")
                stream.write("| File | Bytes | SHA-256 |\n|---|---:|---|\n")
                for item in files:
                    stream.write(f"| {item['name']} | {item['bytes']} | `{item['sha256']}` |\n")


if __name__ == "__main__":
    main()
