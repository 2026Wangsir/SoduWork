"""Agent installation uses its own writable tree and a compatible native Node."""
import json
import os
from pathlib import Path
import tempfile
import shutil
import subprocess
import unittest
from unittest.mock import patch

from app.services import acp_agents, agent_npm_runtime as N, agent_setup as A
from app.services import agent_setup_runtime as R, local_base as L


class NodeResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def runtime(self, folder, *, script=False):
        directory = self.root / folder
        directory.mkdir()
        node = directory / ('node.exe' if os.name == 'nt' else 'node')
        node.write_bytes(b'#!/bin/sh\n' if script else b'fixture native binary')
        npm = directory / 'node_modules/npm/bin/npm-cli.js'
        npm.parent.mkdir(parents=True)
        npm.write_text('// npm fixture', encoding='utf8')
        return node, npm

    def test_obsolete_path_node_does_not_hide_new_native_pair(self):
        old, _ = self.runtime('old')
        new, npm = self.runtime('new')
        def probe(argv, _stamp):
            if argv[-1] == '--version':
                return '10.9.8'
            return json.dumps({'node': '18.20.0' if argv[0] == str(old) else '22.23.2', 'electron': False})
        with patch.dict(os.environ, {'PATH': os.pathsep.join((str(old.parent), str(new.parent)))}), \
                patch.object(N, '_probe', side_effect=probe) as called:
            pair = N.resolve()
        self.assertEqual(pair['nodePath'], str(new))
        self.assertEqual(pair['npmPath'], str(npm))
        self.assertTrue(any(call.args[0] == (str(new), str(npm), '--version') for call in called.call_args_list))

    def test_electron_binary_and_script_shim_are_not_npm_node(self):
        native, _ = self.runtime('electron')
        shim, _ = self.runtime('shim', script=True)
        with patch.dict(os.environ, {'PATH': os.pathsep.join((str(native.parent), str(shim.parent)))}), \
                patch.object(N, '_probe', return_value=json.dumps({'node': '24.0.0', 'electron': True})):
            self.assertEqual(N.resolve(), {})

    def test_runtime_minimums_reject_old_node_before_install(self):
        with patch.object(N, 'resolve', return_value={'nodePath': '/node', 'node': 'v20.20.0', 'npm': '10'}):
            self.assertFalse(N.node_env('qwen')['ok'])
            self.assertFalse(N.node_env('dsh')['ok'])
            self.assertTrue(N.node_env('codex')['ok'])
            self.assertTrue(N.node_env('qwen', engine='>=20.0.0')['ok'])
        with patch.object(N, 'resolve', return_value={'nodePath': '/node', 'node': 'v22.15.0', 'npm': '10'}):
            self.assertTrue(N.node_env('dsh')['ok'])
            self.assertFalse(N.node_env('pi')['ok'])

    def test_install_environment_is_private_and_does_not_change_parent(self):
        prefix = str(self.root / 'npm')
        with patch.object(N, 'private_prefix', return_value=prefix), patch.dict(os.environ, {
                'PATH': '/old/bin', 'NPM_CONFIG_PREFIX': '/readonly', 'NODE_OPTIONS': '--require private',
                'ELECTRON_RUN_AS_NODE': '1'}):
            env = N.environment({'nodePath': str(self.root / 'node')}, install=True)
            self.assertEqual(os.environ['NPM_CONFIG_PREFIX'], '/readonly')
        self.assertEqual(env['NPM_CONFIG_PREFIX'], prefix)
        self.assertEqual(env['NPM_CONFIG_CACHE'], os.path.join(prefix, 'cache'))
        self.assertNotIn('NODE_OPTIONS', env)
        self.assertNotIn('ELECTRON_RUN_AS_NODE', env)
        self.assertEqual(env['PATH'].split(os.pathsep)[0], str(self.root))
        with patch.object(N, 'private_prefix', return_value=prefix), patch.dict(os.environ, env):
            self.assertEqual(N.environment({'nodePath': str(self.root / 'node')})['PATH'], env['PATH'])

    def test_restart_discovers_private_acp_and_preserves_legacy_pi(self):
        prefix = self.root / 'private'
        binary = prefix / 'bin/qwen'
        binary.parent.mkdir(parents=True)
        binary.write_text('fixture', encoding='utf8')
        binary.chmod(0o700)
        legacy = self.root / 'legacy'
        package = legacy / '@earendil-works/pi-coding-agent'
        entry = package / 'dist/cli.js'
        entry.parent.mkdir(parents=True)
        entry.write_text('// old Pi', encoding='utf8')
        (package / 'package.json').write_text(json.dumps({'bin': {'pi': 'dist/cli.js'}}), encoding='utf8')
        with patch.object(N, 'private_prefix', return_value=str(prefix)), \
                patch.object(N.sys, 'platform', 'linux'), \
                patch.object(N, 'resolve', return_value={}), patch.dict(os.environ, {'PATH': '/legacy/bin'}), \
                patch.object(L, '_npm_root', return_value=str(legacy)), \
                patch.object(L, '_bundled_pi_cli_js', return_value=None):
            N.activate_environment()
            self.assertEqual(acp_agents.find_bin('qwen'), str(binary))
            self.assertEqual(Path(L._pi_cli_js()), entry)
            self.assertIn('/legacy/bin', os.environ['PATH'])

    def test_pi_manifest_new_entry_and_private_codex_dependencies(self):
        root = self.root / 'lib/node_modules'
        pi = root / '@earendil-works/pi-coding-agent'
        entry = pi / 'dist/bundle/cli.js'
        entry.parent.mkdir(parents=True)
        entry.write_text('// new Pi', encoding='utf8')
        (pi / 'package.json').write_text(json.dumps({'bin': {'pi': 'dist/bundle/cli.js'}}), encoding='utf8')
        codex = root / '@agentclientprotocol/codex-acp/node_modules/@openai/codex/package.json'
        codex.parent.mkdir(parents=True)
        codex.write_text('{"version":"0.162.1"}', encoding='utf8')
        with patch.object(N, 'private_root', return_value=str(root)), \
                patch.object(L, '_npm_root', return_value=''), patch.object(R, '_npm_root', return_value=''), \
                patch.object(L, '_bundled_pi_cli_js', return_value=None):
            self.assertEqual(Path(L._pi_cli_js()), entry)
            self.assertEqual(R._codex_dependency_version(), '0.162.1')

    def test_private_codex_launcher_wins_over_an_older_global_native_binary(self):
        with patch.object(N, 'private_bin', return_value='/private/bin/codex'), \
                patch.object(L, '_WIN', False), \
                patch.object(L, '_real_bin') as legacy:
            self.assertEqual(L._codex_bin(), '/private/bin/codex')
        legacy.assert_not_called()

    def test_windows_explicit_npm_prefix_matches_the_tree_used_by_install(self):
        with patch.object(L, '_WIN', True), patch.dict(os.environ, {
                'NPM_CONFIG_PREFIX': str(self.root / 'custom npm'), 'APPDATA': str(self.root / 'roaming')}):
            self.assertEqual(L._npm_root(), str(self.root / 'custom npm/node_modules'))

    def test_windows_installed_launchers_remain_visible_after_activation(self):
        prefix = self.root / 'custom npm'
        prefix.mkdir()
        with patch.object(N.os, 'name', 'nt'), patch.object(N, 'private_prefix', return_value=''), \
                patch.object(L, '_npm_root', return_value=str(prefix / 'node_modules')), \
                patch.object(N, 'resolve', return_value={'nodePath': str(self.root / 'node'), 'npm': '10'}), \
                patch.dict(os.environ, {'PATH': '/legacy/bin'}):
            N.activate_environment()
            self.assertIn(str(prefix), os.environ['PATH'].split(os.pathsep))
            self.assertIn('/legacy/bin', os.environ['PATH'].split(os.pathsep))


    def test_windows_npmrc_prefix_discovers_installed_codex_without_path_entry(self):
        root = self.root / 'custom npm/node_modules'
        executable = root / '@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b'fixture')
        # The personal package owns this native dependency; a shared native alone does not.
        (root / '@openai/codex/package.json').write_text('{"name":"@openai/codex"}', encoding='utf8')
        with patch.object(L, '_WIN', True), patch.dict(os.environ, {}, clear=True), \
                patch.object(N, 'runtime_target', return_value=('win32', 'x64')), \
                patch.object(N, 'configured_global_root', return_value=str(root)), \
                patch.object(N, 'private_bin', return_value=''):
            self.assertEqual(L._npm_root(), str(root))
            self.assertEqual(L._codex_bin(), str(executable))

    def test_windows_failed_npm_query_preserves_default_root(self):
        with patch.object(L, '_WIN', True), \
                patch.dict(os.environ, {'APPDATA': str(self.root)}, clear=True), \
                patch.object(N, 'configured_global_root', return_value=''):
            self.assertEqual(L._npm_root(), str(self.root / 'npm/node_modules'))

    def test_configured_root_uses_installer_pair_and_tracks_npmrc(self):
        node, npm = self.runtime('native')
        root = str(self.root / 'custom npm/node_modules')
        config = str(self.root / 'custom.npmrc')
        with patch.object(N, 'resolve', return_value={'nodePath': str(node), 'npmPath': str(npm)}), \
                patch.dict(os.environ, {'NPM_CONFIG_USERCONFIG': config}), \
                patch.object(N, 'cached_probe', return_value=root) as probe:
            self.assertEqual(N.configured_global_root(), root)
        self.assertEqual(probe.call_args.args, (str(node), [str(npm), 'root', '--global']))
        self.assertIn(config, probe.call_args.kwargs['files'])
        self.assertIn(str(Path.home() / '.npmrc'), probe.call_args.kwargs['files'])

    def test_configured_root_rejects_failed_or_non_path_output(self):
        with patch.object(N, 'resolve', return_value={'nodePath': '/node', 'npmPath': '/npm-cli.js'}):
            for value in ('', 'undefined', 'relative/node_modules', '/root\nwarning'):
                with self.subTest(value=value), patch.object(N, 'cached_probe', return_value=value):
                    self.assertEqual(N.configured_global_root(), '')


class InstallationTests(unittest.TestCase):
    pair = {'ok': True, 'nodePath': '/native/node', 'npmPath': '/native/npm-cli.js', 'npm': '10'}

    def install(self, *, code=0, binary='/private/qwen', version='0.25.1', starts='0.25.1'):
        jid = A._new_job('qwen', 'install')
        with patch.object(A, 'node_env', return_value=dict(self.pair)), \
                patch.object(A, '_stream', return_value=(code, 'fixture')) as stream, \
                patch.object(N, 'activate_environment'), patch.object(A, '_pkg_version', return_value=version), \
                patch.object(A, '_runtime_issue', return_value=''), patch.object(A, '_bin_of', return_value=binary), \
                patch.object(A, '_short', return_value=starts):
            A._run_npm(jid, 'qwen', 'install')
        return A.job(jid), stream

    def test_install_uses_selected_node_optional_packages_and_engine_enforcement(self):
        job, stream = self.install()
        self.assertTrue(job['ok'], job)
        argv = stream.call_args.args[1]
        self.assertEqual(argv[:2], ['/native/node', '/native/npm-cli.js'])
        self.assertIn('--engine-strict', argv)
        self.assertIn('--include=optional', argv)

    def test_successful_npm_and_metadata_cannot_hide_unstartable_cli(self):
        job, _ = self.install(starts='')
        self.assertFalse(job['ok'])
        self.assertIn('启动自检失败', job['detail'])

    def test_successful_npm_and_metadata_cannot_hide_missing_launcher(self):
        job, _ = self.install(binary='')
        self.assertFalse(job['ok'])

    def test_npm_failure_is_never_reported_as_success_with_old_package(self):
        job, _ = self.install(code=1)
        self.assertFalse(job['ok'])

    def test_old_runtime_does_not_start_install_or_update_check(self):
        for action in ('install', 'update', 'check'):
            jid = A._new_job('qwen', action)
            with patch.object(A, 'node_env', return_value={'ok': False, 'why': 'Node too old'}), \
                    patch.object(A, '_stream') as stream:
                A._run_npm(jid, 'qwen', action)
            self.assertFalse(A.job(jid)['ok'])
            stream.assert_not_called()

    def test_metadata_does_not_advertise_a_cli_that_fails_to_start(self):
        with patch.object(A, '_bin_of', return_value='/private/qwen'), \
                patch.object(A, 'is_bundled', return_value=False), \
                patch.object(A, '_runtime_issue', return_value=''), \
                patch.object(A, 'node_env', return_value={'ok': True, 'why': ''}), \
                patch.object(A, '_cached_version_probe', return_value=''), \
                patch.object(A, '_version_of', return_value=('0.25.1', 'pkg', '')):
            result = A.detect('qwen', probes={})
        self.assertFalse(result['installed'])
        self.assertIn('启动自检失败', result['why'])


@unittest.skipUnless(os.name == 'posix' and shutil.which('bash'), 'Linux installer shell')
class InstallerEnvironmentTests(unittest.TestCase):
    def test_systemd_path_uses_explicit_runtime_dirs_without_environment_secrets(self):
        import sys
        script = Path(__file__).with_name('installers').joinpath('runner-install.sh').read_text(encoding='utf8')
        block = script.split('# systemd does not load interactive profiles', 1)[1].split('START_CMD=', 1)[0]
        block = '# systemd does not load interactive profiles' + block
        env = dict(os.environ, ROOT='/tmp/runner with space%value', PY=sys.executable,
                   SODUWORK_FIXTURE_SECRET='must-not-be-in-unit')
        result = subprocess.run(['bash', '-c', block + '\nprintf "%s" "$UNIT_PATH"'],
                                env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Environment="PATH=', result.stdout)
        self.assertIn('/tmp/runner with space%%value/data/agent-runtimes/npm/bin', result.stdout)
        self.assertNotIn(env['SODUWORK_FIXTURE_SECRET'], result.stdout)


if __name__ == '__main__':
    unittest.main()
