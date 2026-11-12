from __future__ import annotations

import copy
import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import check_public_ci
import release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = dict(RELEASE_COMPONENT="source", RELEASE_VERSION="1.2.3",
                        GITHUB_REPOSITORY="example/project", PUBLIC_RELEASE_REPOSITORY="example/project",
                        GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF="refs/heads/release/1.2.3",
                        GITHUB_REF_PROTECTED="true", GITHUB_SHA="a" * 40, GITHUB_RUN_ID="123")
        self.ctx = release.context(self.env)

    def bundle(self):
        for name in release.expected(self.ctx, "source"):
            (self.root / name).write_bytes(b"accepted archive bytes")
        release.seal(self.ctx, "source", self.root, {"ok": True, "checks": ["fixture"]})

    def test_context_requires_manual_protected_matching_branch_and_repository(self):
        for key, value in [("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF_PROTECTED", "false"),
                           ("PUBLIC_RELEASE_REPOSITORY", "other/repo"), ("GITHUB_SHA", "short"),
                           ("GITHUB_RUN_ID", ""), ("GITHUB_REF", "refs/tags/v1.2.3"),
                           ("RELEASE_VERSION", "1.2.3;command"), ("RELEASE_VERSION", "01.2.3")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                release.context({**self.env, key: value})

    def test_complete_candidate_verifies(self):
        self.bundle()
        manifest = release.candidate(self.ctx, self.root)
        self.assertEqual(release.verify(self.ctx, self.root), manifest)

    def test_other_run_and_commit_are_rejected(self):
        self.bundle()
        for key, value in [("runId", "124"), ("commit", "b" * 40), ("repository", "fork/repo")]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "another run"):
                release.candidate({**self.ctx, key: value}, self.root)

    def test_replaced_asset_is_rejected(self):
        self.bundle()
        release.candidate(self.ctx, self.root)
        (self.root / release.expected(self.ctx, "source")[0]).write_bytes(b"replaced bytes")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            release.verify(self.ctx, self.root)

    def test_unknown_asset_and_missing_platform_are_rejected(self):
        self.bundle()
        (self.root / "private.env").write_text("fixture")
        with self.assertRaisesRegex(ValueError, "Unexpected candidate"):
            release.candidate(self.ctx, self.root)
        with self.assertRaises(FileNotFoundError):
            release.candidate({**self.ctx, "component": "client"}, self.root)

    def test_failed_acceptance_and_symlinks_are_rejected(self):
        name = release.expected(self.ctx, "source")[0]
        (self.root / name).write_bytes(b"candidate")
        with self.assertRaisesRegex(ValueError, "Acceptance"):
            release.seal(self.ctx, "source", self.root, {"ok": False})
        # Symlink creation may require privileges on Windows.
        if os.name != "nt":
            (self.root / name).unlink()
            (self.root / name).symlink_to(__file__)
            with self.assertRaisesRegex(ValueError, "regular artifact"):
                release.seal(self.ctx, "source", self.root, {"ok": True})

    def test_forged_inventory_cannot_drop_or_add_files(self):
        self.bundle()
        manifest = release.candidate(self.ctx, self.root)
        bad = copy.deepcopy(manifest)
        bad["assets"].append(bad["assets"][0])
        release.write(self.root / "release-manifest.json", bad)
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            release.verify(self.ctx, self.root)
        bad = copy.deepcopy(manifest)
        bad["assets"][0]["name"] = "../outside"
        release.write(self.root / "release-manifest.json", bad)
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            release.verify(self.ctx, self.root)

    def test_binary_gate_stays_closed_and_source_remains_available(self):
        release.policy(self.ctx, self.root)
        release.write(self.root / "tools/distribution/PUBLIC-SOURCE.json", {"sourceOnly": True})
        release.write(self.root / "third-party/public-release.json", {"schema": 1, "pending": []})
        hub = {**self.ctx, "component": "hub"}
        with self.assertRaisesRegex(ValueError, "source-only"):
            release.policy(hub, self.root)
        release.write(self.root / "tools/distribution/PUBLIC-SOURCE.json", {"sourceOnly": False})
        release.write(self.root / "third-party/public-release.json", {"schema": 1, "pending": [{"id": "unresolved"}]})
        with self.assertRaisesRegex(ValueError, "pending"):
            release.policy(hub, self.root)

    def test_preflight_requires_public_repo_reviewers_and_current_head(self):
        branch = {"object": {"sha": self.ctx["commit"]}}
        gate = {"protection_rules": [{"type": "required_reviewers", "reviewers": [{"id": 1}]}]}
        for responses in [[{"private": True}], [{"private": False}, {"protection_rules": []}],
                          [{"private": False}, gate, {"object": {"sha": "b" * 40}}]]:
            with patch.object(release, "api", side_effect=responses), self.assertRaises(ValueError):
                release.preflight(self.ctx)
        with patch.object(release, "api", side_effect=[{"private": False}, gate, branch]) as api:
            release.preflight(self.ctx)
            api.assert_called_with('/git/ref/heads/release/1.2.3')

    def test_annotated_tag_is_peeled_and_wrong_commit_is_rejected(self):
        with patch.object(release, "preflight"), patch.object(release, "api", side_effect=[
                {"object": {"type": "tag", "sha": "c" * 40}},
                {"object": {"type": "commit", "sha": self.ctx["commit"]}}]):
            release.authorize(self.ctx)
        with patch.object(release, "preflight"), patch.object(release, "api", return_value={
                "object": {"type": "commit", "sha": "b" * 40}}), self.assertRaisesRegex(ValueError, "Tag"):
            release.authorize(self.ctx)

    def test_publication_never_takes_over_another_run(self):
        self.bundle()
        release.candidate(self.ctx, self.root)
        with patch.object(release, "preflight"), patch.object(release, "authorize"), patch.object(release, "api", return_value={"body": "other candidate", "draft": True}), \
                patch.object(release, "gh") as gh, self.assertRaisesRegex(ValueError, "another candidate"):
            release.draft(self.ctx, self.root)
        gh.assert_not_called()

    def test_draft_resumes_without_overwriting_and_never_publishes(self):
        self.bundle()
        manifest = release.candidate(self.ctx, self.root)
        names = [a['name'] for a in manifest['assets']] + ['release-manifest.json']
        marker = f"Candidate: {self.ctx['repository']} / run {self.ctx['runId']} / {self.ctx['commit']}"
        existing = {'body': marker, 'draft': True, 'assets': []}
        # Simulate one asset already uploaded by a previous attempt of this run.
        def add(name):
            existing['assets'].append({'name': name, 'browser_download_url': 'https://example.test/' + name})
        add(names[0])
        calls = []
        def gh(*args):
            calls.append(args)
            if args[1] == 'upload':
                add(Path(args[3]).name)
            elif args[1] == 'download':
                name = args[args.index('--pattern') + 1]
                folder = Path(args[args.index('--dir') + 1])
                (folder / name).write_bytes((self.root / name).read_bytes())
            elif args[1] == 'edit':
                existing['draft'] = False
            else:
                self.fail('Unexpected publication command')
        def response(url, **kwargs):
            return io.BytesIO((self.root / url.rsplit('/', 1)[-1]).read_bytes())
        with patch.object(release, 'preflight'), patch.object(release, 'authorize'), patch.object(release, 'api', return_value=existing), \
                patch.object(release, 'gh', side_effect=gh), patch.object(release.urllib.request, 'urlopen', side_effect=response):
            release.draft(self.ctx, self.root)
            self.assertEqual(len([c for c in calls if c[1] == 'upload']), len(names) - 1)
            self.assertTrue(existing['draft'])
            self.assertFalse(any(c[1] == 'edit' for c in calls))
            calls.clear()
            release.draft(self.ctx, self.root)
            self.assertTrue(all(c[1] == 'download' for c in calls))
        self.assertTrue(all('--clobber' not in c for c in calls))

    def test_new_draft_targets_accepted_sha_without_creating_a_tag_or_publishing(self):
        self.bundle()
        release.candidate(self.ctx, self.root)
        existing = None
        calls = []
        def api(route, optional=False):
            if route.startswith('/git/ref/tags/'):
                return None
            return existing
        def gh(*args):
            nonlocal existing
            calls.append(args)
            if args[1] == 'create':
                self.assertIn('--draft', args)
                self.assertEqual(args[args.index('--target') + 1], self.ctx['commit'])
                existing = {'draft': True, 'assets': []}
            elif args[1] == 'upload':
                existing['assets'].append({'name': Path(args[3]).name})
            elif args[1] == 'download':
                name = args[args.index('--pattern') + 1]
                (Path(args[args.index('--dir') + 1]) / name).write_bytes((self.root / name).read_bytes())
            else:
                self.fail('Draft must never publish or mutate tags')
        with patch.object(release, 'preflight'), patch.object(release, 'api', side_effect=api), \
                patch.object(release, 'gh', side_effect=gh):
            release.draft(self.ctx, self.root)
        self.assertTrue(existing['draft'])

    def test_draft_rejects_public_release_even_for_same_candidate(self):
        self.bundle()
        release.candidate(self.ctx, self.root)
        marker = f"Candidate: {self.ctx['repository']} / run {self.ctx['runId']} / {self.ctx['commit']}"
        with patch.object(release, 'preflight'), patch.object(release, 'authorize'), \
                patch.object(release, 'api', return_value={'body': marker, 'draft': False}), \
                patch.object(release, 'gh') as gh, self.assertRaisesRegex(ValueError, 'public Release'):
            release.draft(self.ctx, self.root)
        gh.assert_not_called()

    def test_combined_candidate_requires_hub_and_every_desktop_shard(self):
        ctx = {**self.ctx, 'component': 'all'}
        import shutil
        for shard in release.SHARDS['all']:
            folder = self.root / shard
            folder.mkdir()
            for name in release.expected(ctx, shard):
                (folder / name).write_bytes(b'accepted fixture')
            release.seal(ctx, shard, folder, {'ok': True})
            for file in folder.iterdir():
                shutil.move(file, self.root / file.name)
            folder.rmdir()
        manifest = release.candidate(ctx, self.root)
        self.assertEqual(len(manifest['receipts']), 5)
        self.assertEqual(release.verify(ctx, self.root), manifest)
        (self.root / 'hub-receipt.json').unlink()
        with self.assertRaisesRegex(ValueError, 'regular artifact'):
            release.verify(ctx, self.root)

    def test_first_release_exception_is_desktop_and_version_scoped(self):
        contract = {'firstRelease': {'version': '1.13.15',
            'keys': ['macos-arm64-dmg', 'windows-x64-exe'], 'excludedProduct': 'SoduWork Global'}}
        ctx = {**self.ctx, 'version': '1.13.15'}
        self.assertTrue(release.first_release(ctx, 'macos-arm64-dmg', contract))
        self.assertTrue(release.first_release(ctx, 'windows-x64-exe', contract))
        self.assertFalse(release.first_release(ctx, 'linux-x64-deb', contract))
        self.assertFalse(release.first_release(ctx, 'android-apk', contract))
        self.assertFalse(release.first_release({**ctx, 'version': '1.13.16'}, 'macos-arm64-dmg', contract))

    def test_client_baselines_must_be_older_public_assets(self):
        ctx = {**self.ctx, 'component': 'client'}
        release.write(self.root / 'client/package.json', {'version': ctx['version']})
        release.write(self.root / 'client/version.json', {'version': ctx['version']})
        release.write(self.root / 'client/package-lock.json', {'version': ctx['version'], 'packages': {'': {'version': ctx['version']}}})
        release.write(self.root / 'tools/distribution/PUBLIC-SOURCE.json', {'sourceOnly': False})
        release.write(self.root / 'third-party/public-release.json', {'schema': 1, 'pending': []})
        keys = ['windows-x64-exe', 'linux-x64-deb', 'linux-x64-rpm', 'linux-x64-tar.gz', 'macos-arm64-dmg', 'macos-x64-dmg']
        baselines = {key: {'productName': 'SoduWork', 'version': '1.2.2', 'sha256': 'a' * 64,
                          'url': 'https://github.com/example/project/releases/download/client-v1.2.2/installer'} for key in keys}
        file = self.root / 'tools/ci/soduwork-acceptance-baselines.json'
        release.write(file, baselines)
        release.policy(ctx, self.root)
        for field, value in [('version', '1.2.3'), ('url', 'https://example.test/installer'), ('path', '/local/installer')]:
            changed = copy.deepcopy(baselines)
            changed[keys[0]][field] = value
            release.write(file, changed)
            with self.subTest(field=field), self.assertRaises(ValueError):
                release.policy(ctx, self.root)

    def test_private_host_fingerprints_and_pipeline_addresses(self):
        host = "private.example.test"
        with patch.object(check_public_ci, "PRIVATE_DOMAIN_HASHES", {hashlib.sha256(host.encode()).hexdigest()}):
            self.assertEqual(check_public_ci.findings("README.md", "https://api." + host), ["private domain"])
        self.assertEqual(check_public_ci.findings(".github/workflows/ci.yml", "http://10.1.2.3"), ["private address in pipeline"])
        self.assertEqual(check_public_ci.findings("tools/github/hub.py", "http://127.0.0.1"), [])

    def test_client_candidate_contains_desktop_assets_only(self):
        self.assertEqual(release.SHARDS["client"], ["windows", "linux", "macos-arm64", "macos-x64"])
        with self.assertRaises(KeyError):
            release.expected({"version": "1.2.3"}, "android")


if __name__ == "__main__":
    unittest.main()
