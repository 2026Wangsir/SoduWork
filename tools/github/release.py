"""GitHub-only release identity, immutable candidate inventory and publication."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
VERSION = r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
SHARDS = {"source": ["source"], "hub": ["hub"],
          "client": ["windows", "linux", "macos-arm64", "macos-x64"],
          "all": ["windows", "linux", "macos-arm64", "macos-x64", "hub"]}


def read(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def write(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def context(env=None):
    env = os.environ if env is None else env
    component, version = env.get("RELEASE_COMPONENT"), env.get("RELEASE_VERSION", "")
    require(component in SHARDS and re.fullmatch(VERSION, version), "Invalid component/version")
    repo = env.get("GITHUB_REPOSITORY", "")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "Invalid repository")
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Release requires workflow_dispatch")
    require(env.get("GITHUB_REF") == f"refs/heads/release/{version}", "Use the matching unified release branch")
    require(env.get("GITHUB_REF_PROTECTED") == "true", "Release branch must be protected")
    require(env.get("PUBLIC_RELEASE_REPOSITORY") == repo, "Configure PUBLIC_RELEASE_REPOSITORY explicitly")
    sha, run = env.get("GITHUB_SHA", ""), env.get("GITHUB_RUN_ID", "")
    require(re.fullmatch(r"[a-f0-9]{40}", sha) and re.fullmatch(r"[1-9]\d*", run), "Missing GitHub identity")
    return dict(schema=1, component=component, version=version, repository=repo,
                commit=sha, runId=run, tag=f"v{version}")


def api(route, optional=False):
    require(os.environ.get("GITHUB_API_URL") == "https://api.github.com", "Public GitHub API required")
    request = urllib.request.Request("https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"] + route,
        headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                 "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if optional and error.code == 404:
            return None
        raise RuntimeError(f"GitHub API {route}: HTTP {error.code}") from None


def first_release(ctx, key, baselines):
    contract = baselines.get("firstRelease", {})
    return (ctx["version"] == contract.get("version")
            and key in ("windows-x64-exe", "linux-x64-deb", "linux-x64-rpm", "linux-x64-tar.gz",
                        "macos-arm64-dmg", "macos-x64-dmg")
            and key in contract.get("keys", [])
            and contract.get("excludedProduct") == "SoduWork Global")


def policy(ctx, root=ROOT):
    if ctx["component"] in ("client", "all"):
        versions = [read(root / "client/package.json")["version"], read(root / "client/version.json")["version"],
                    read(root / "client/package-lock.json")["version"],
                    read(root / "client/package-lock.json")["packages"][""]["version"]]
        require(all(v == ctx["version"] for v in versions), "Client version files differ from release version")
    if ctx["component"] != "source":
        profile = read(root / "tools/distribution/PUBLIC-SOURCE.json")
        review = read(root / "third-party/public-release.json")
        require(profile.get("sourceOnly") is False, "Binary publication blocked: source-only release scope")
        require(review.get("schema") == 1 and review.get("pending") == [], "Binary publication blocked: pending third-party review")
    if ctx["component"] in ("client", "all"):
        baselines = read(root / "tools/ci/soduwork-acceptance-baselines.json")
        for key in ["windows-x64-exe", "linux-x64-deb", "linux-x64-rpm", "linux-x64-tar.gz", "macos-arm64-dmg", "macos-x64-dmg"]:
            if first_release(ctx, key, baselines):
                continue
            item = baselines.get(key, {})
            require(item.get("productName") == "SoduWork" and re.fullmatch(VERSION, item.get("version", "")), "Missing public upgrade baseline: " + key)
            require(tuple(map(int, item["version"].split("."))) < tuple(map(int, ctx["version"].split("."))), "Baseline must be older")
            require(re.fullmatch(r"[a-f0-9]{64}", item.get("sha256", "")), "Baseline digest required")
            require(re.fullmatch(r"https://github\.com/" + re.escape(ctx["repository"]) + r"/releases/download/client-v[0-9.]+/[^/?#]+", item.get("url", "")), "Baseline must be a public release asset in this repository")
            require(not any(k in item for k in ["path", "fallbackUrl"]), "Local/private baseline overrides are forbidden")


def preflight(ctx):
    require(api("")["private"] is False, "This workflow only publishes from a public repository")
    policy(ctx)
    # The environment must already exist and have a real reviewer gate; a YAML
    # environment name alone would silently create an unprotected environment.
    environment = api("/environments/public-release")
    require(any(rule.get("type") == "required_reviewers" and rule.get("reviewers")
                for rule in environment.get("protection_rules", [])), "Configure required reviewers on public-release")
    require(api("/git/ref/heads/release/" + ctx["version"])["object"]["sha"] == ctx["commit"], "Release branch moved")


def fingerprint(file):
    require(file.is_file() and not file.is_symlink(), "Not a regular artifact: " + file.name)
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    require(file.stat().st_size > 0, "Empty artifact")
    require(file.stat().st_size < 2 * 1024 ** 3, "Artifact exceeds the GitHub Release per-file limit")
    return dict(name=file.name, size=file.stat().st_size, sha256=digest.hexdigest())


def expected(ctx, shard):
    stem = "SoduWork-" + ctx["version"]
    return {"source": [stem + "-source.zip"], "hub": [stem + "-hub-image.tar.gz"],
            "windows": [stem + "-Setup.exe"], "linux": [stem + "-linux." + ext for ext in ["deb", "rpm", "tar.gz"]],
            "macos-arm64": [stem + "-mac-arm64.dmg"], "macos-x64": [stem + "-mac-x64.dmg"]}[shard]


def seal(ctx, shard, folder, checks):
    require(shard in SHARDS[ctx["component"]], "Unexpected shard")
    require(checks.get("ok") is True, "Acceptance did not pass")
    names = expected(ctx, shard)
    require(sorted(p.name for p in folder.iterdir()) == sorted(names), "Unexpected artifact files")
    record = {**ctx, "shard": shard, "artifacts": [fingerprint(folder / name) for name in names], "acceptance": checks}
    write(folder / (shard + "-receipt.json"), record)
    return record


def candidate(ctx, folder):
    receipts, files = [], set()
    for shard in SHARDS[ctx["component"]]:
        name = shard + "-receipt.json"
        receipt = read(folder / name)
        require(all(receipt.get(k) == v for k, v in ctx.items()), "Receipt belongs to another run/commit/version")
        require(receipt.get("shard") == shard and receipt.get("acceptance", {}).get("ok") is True, "Invalid acceptance")
        require([a["name"] for a in receipt["artifacts"]] == expected(ctx, shard), "Incomplete platform inventory")
        for item in receipt["artifacts"]:
            require(fingerprint(folder / item["name"]) == item, "Artifact changed: " + item["name"])
            files.add(item["name"])
        receipts.append(receipt)
        files.add(name)
    require(set(p.name for p in folder.iterdir()) == files, "Unexpected candidate files")
    result = {**ctx, "receipts": receipts, "assets": [fingerprint(folder / name) for name in sorted(files)]}
    write(folder / "release-manifest.json", result)
    return result


def verify(ctx, folder):
    manifest = read(folder / "release-manifest.json")
    require(all(manifest.get(k) == v for k, v in ctx.items()), "Candidate identity mismatch")
    require(len(manifest.get("assets", [])) == len({a["name"] for a in manifest["assets"]}), "Duplicate assets")
    for item in manifest["assets"]:
        require(Path(item["name"]).name == item["name"] and "\\" not in item["name"], "Unsafe asset name")
        require(fingerprint(folder / item["name"]) == item, "Candidate asset digest mismatch")
    # Recheck the complete inventory and receipt identities, not just its hashes.
    with tempfile.TemporaryDirectory() as scratch:
        import shutil
        target = Path(scratch)
        for item in manifest["assets"]:
            shutil.copyfile(folder / item["name"], target / item["name"])
        require(candidate(ctx, target) == manifest, "Candidate manifest differs from receipts")
    require(set(p.name for p in folder.iterdir()) == {a["name"] for a in manifest["assets"]} | {"release-manifest.json"}, "Unexpected publication files")
    return manifest


def authorize(ctx):
    preflight(ctx)
    tag = api("/git/ref/tags/" + ctx["tag"])["object"]
    for _ in range(5):
        if tag["type"] == "commit":
            break
        require(tag["type"] == "tag", "Invalid tag object")
        tag = api("/git/tags/" + tag["sha"])["object"]
    require(tag["type"] == "commit" and tag["sha"] == ctx["commit"], "Tag must identify the accepted commit")


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def find_release_by_tag(tag):
    # The tag endpoint only finds published releases. Authenticated listing also
    # includes drafts whose pending tag has not been created yet.
    found, page = None, 1
    while True:
        releases = api(f"/releases?per_page=100&page={page}")
        for item in releases:
            if item.get("tag_name") == tag:
                require(found is None, "Multiple Releases use the requested tag")
                found = item
        if len(releases) < 100:
            return found
        page += 1


def draft(ctx, folder):
    manifest = verify(ctx, folder)
    preflight(ctx)
    # A draft can precede the formal tag; an existing tag must match.
    if api("/git/ref/tags/" + ctx["tag"], optional=True):
        authorize(ctx)
    existing = find_release_by_tag(ctx["tag"])
    marker = f"Candidate: {ctx['repository']} / run {ctx['runId']} / {ctx['commit']}"
    if existing:
        require(existing.get("draft") is True, "Refusing to modify a public Release")
        require(marker in existing.get("body", ""), "Release belongs to another candidate; refusing overwrite")
    else:
        gh("release", "create", ctx["tag"], "--repo", ctx["repository"], "--target", ctx["commit"], "--draft",
           "--title", "SoduWork " + ("Client + Hub" if ctx["component"] == "all" else ctx["component"]) + " " + ctx["version"],
           "--notes", marker + "\n\nDraft for internal testing only. See release-manifest.json for checksums and acceptance scope.")
        existing = find_release_by_tag(ctx["tag"])
    require(existing is not None, "Created Draft Release could not be found")
    release_route = "/releases/" + str(existing["id"])
    # Never overwrite an asset: a retry downloads and compares assets already uploaded.
    existing = api(release_route)
    require(existing.get("tag_name") == ctx["tag"], "Release tag changed")
    require(existing.get("draft") is True, "Refusing to modify a public Release")
    require(marker in existing.get("body", ""), "Release belongs to another candidate; refusing overwrite")
    actual_names = {a["name"] for a in existing["assets"]}
    desired = {a["name"] for a in manifest["assets"]} | {"release-manifest.json"}
    require(actual_names <= desired, "Unexpected assets on existing Release")
    with tempfile.TemporaryDirectory() as scratch:
        for name in sorted(desired):
            if name not in actual_names:
                require(existing["draft"], "Published Release is incomplete; refusing mutation")
                gh("release", "upload", ctx["tag"], str(folder / name), "--repo", ctx["repository"])
            gh("release", "download", ctx["tag"], "--repo", ctx["repository"], "--pattern", name, "--dir", scratch)
            require(fingerprint(Path(scratch) / name) == fingerprint(folder / name), "Uploaded asset differs: " + name)
    saved = api(release_route)
    require(saved["draft"] is True, "Release must remain a draft")
    require({a["name"] for a in saved["assets"]} == desired, "Draft assets differ")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["preflight", "candidate", "verify", "draft"])
    parser.add_argument("--folder", type=Path)
    args = parser.parse_args()
    ctx = context()
    if args.command == "preflight":
        preflight(ctx)
    else:
        require(args.folder is not None, "Specify --folder")
        globals()[args.command](ctx, args.folder)
    print(json.dumps({"ok": True, "command": args.command, **ctx}))


if __name__ == "__main__":
    main()
