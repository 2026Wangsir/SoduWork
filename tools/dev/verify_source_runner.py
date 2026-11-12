"""Exercise the source launcher, desktop login, Runner and Agent inventory on macOS.

Run with a test Python containing websockets and Node.js 22 on PATH. All service
data and screenshots stay in a newly created temporary directory. No tasks or
models are created. Chromium's mock Keychain prevents native credential prompts;
this verifies the real process/network/UI chain, not native Keychain access.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
from pathlib import Path
import plistlib
import re
import secrets
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.dev import start_local  # noqa: E402
from tools.dev.verify_local_start import (desktop_ready, desktop_stopped, free_port,
                                         request, stop, wait_ready)  # noqa: E402


def child_fixture(state: Path, port: int, debug_port: int) -> int:
    """Add a loopback automation port only inside this isolated test process."""
    state = state.resolve()
    if (sys.platform != 'darwin' or state.parent != Path(tempfile.gettempdir()).resolve()
            or not state.name.startswith('soduwork-source-runner-') or not state.is_dir()):
        raise ValueError('The fixture requires a temporary macOS verification directory')
    original_launch = start_local.launch_desktop

    def launch(*args):
        original_spawn = start_local.subprocess.Popen
        client = args[1]

        def spawn(command, *positional, **kwargs):
            if command[1:] != [str(client / 'scripts/start-client.cjs')]:
                raise ValueError('Unexpected desktop fixture command')
            # Local discovery may ask an installed Codex CLI for login status.
            # Preserve Electron's native HOME while isolating that CLI account.
            codex_home = state / 'home/.codex'
            codex_home.mkdir(parents=True, exist_ok=True)
            kwargs['env'] = dict(kwargs['env'], CODEX_HOME=str(codex_home))
            return original_spawn([*command, '--use-mock-keychain',
                                   '--remote-debugging-address=127.0.0.1',
                                   f'--remote-debugging-port={debug_port}'], *positional, **kwargs)

        with patch.object(start_local.subprocess, 'Popen', spawn):
            return original_launch(*args)

    with patch.object(start_local, 'launch_desktop', launch):
        return start_local.main(['--desktop', '--no-browser', '--password-stdin',
                                 '--data-dir', str(state), '--port', str(port)])


class Page:
    def __init__(self, socket):
        self.socket = socket
        self.sequence = 0

    async def call(self, method, **params):
        self.sequence += 1
        sequence = self.sequence
        await self.socket.send(json.dumps({'id': sequence, 'method': method, 'params': params}))
        while True:
            response = json.loads(await asyncio.wait_for(self.socket.recv(), 40))
            if response.get('id') == sequence:
                if 'error' in response:
                    raise AssertionError(f'CDP {method} failed: {response["error"]}')
                return response.get('result', {})

    async def js(self, expression):
        result = await self.call('Runtime.evaluate', expression=expression, awaitPromise=True,
                                 returnByValue=True)
        if result.get('exceptionDetails'):
            # Do not include evaluated expressions: they may contain test credentials.
            raise AssertionError('Renderer evaluation failed')
        return result.get('result', {}).get('value')

    async def until(self, expression, label, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if await self.js('(async()=>Boolean(await (' + expression + ')))()'):
                    return
            except AssertionError:
                pass  # Navigation can replace the execution context during login.
            await asyncio.sleep(.25)
        raise AssertionError(f'Timed out: {label}')

    async def click(self, selector):
        await self.js(f'document.querySelector({json.dumps(selector)}).click(); void 0')

    async def fill(self, selector, value):
        await self.js('(()=>{const el=document.querySelector(' + json.dumps(selector) + ');'
                      'el.value=' + json.dumps(value) + ';'
                      'el.dispatchEvent(new Event("input",{bubbles:true}));})()')

    async def screenshot(self, output):
        result = await self.call('Page.captureScreenshot', format='png')
        output.write_bytes(base64.b64decode(result['data']))


async def verify_ui(debug_port, password, state):
    from websockets.asyncio.client import connect

    debug_base = f'http://127.0.0.1:{debug_port}'
    target = None
    for _ in range(180):
        try:
            target = next((row for row in request(debug_base, '/json/list')
                           if row.get('type') == 'page' and '/desk.html' in row.get('url', '')), None)
        except OSError:
            pass
        if target:
            break
        await asyncio.sleep(.25)
    assert target, 'Desktop workspace did not open'
    async with connect(target['webSocketDebuggerUrl'], max_size=16 * 1024 * 1024,
                       proxy=None) as socket:
        page = Page(socket)
        await page.until('document.querySelector("#soduWorkAuthAccount") && '
                         '!document.querySelector(".soduwork-auth-submit").disabled', 'login form')
        if await page.js('!!document.querySelector("[data-auth-mode=password]")'):
            await page.click('[data-auth-mode=password]')
        await page.fill('#soduWorkAuthAccount', 'admin')
        await page.fill('#soduWorkAuthPassword', password)
        await page.click('.soduwork-auth-submit')
        await page.until('window.ClientAuth?.snapshot()?.user && '
                         '!document.documentElement.classList.contains("soduwork-auth-pending")',
                         'authenticated desktop')
        print('PASS actual desktop login and device enrollment', flush=True)
        await page.until('window.soduWorkAPI.runnerStatus().then(s=>s.connected===true && s.state==="online")',
                         'real Runner WebSocket handshake', timeout=90)
        status = await page.js('window.soduWorkAPI.runnerStatus()')
        print('PASS real Runner process and WebSocket handshake', flush=True)
        inventory = await page.js('SoduWorkAPI.runners()')
        nodes = [row for row in inventory.get('runners', []) if row.get('online')
                 and row.get('scope') == 'current-instance']
        assert len(nodes) == 1, 'Exactly one current desktop Runner must be online'
        await page.js('openAgentsPanel(); void 0')
        await page.until('document.querySelectorAll("#agBody .ag-row").length>0', 'Agent cards')
        agents = await page.js('SoduWorkAPI.localAgentSetup().then(s=>({machines:s.machines.map(m=>'
                               '({runnerId:m.runnerId,scope:m.scope,keys:m.agents.map(a=>a.key)})), '
                               'keys:s.agents.map(a=>a.key)}))')
        assert agents['machines'][0]['runnerId'] == nodes[0]['runnerId']
        assert 'pi' in agents['keys'], 'Source-bundled Pi must appear in actual discovery'
        card_count = await page.js('document.querySelectorAll("#agBody .ag-row").length')
        assert card_count == len(agents['keys']), 'UI cards must match live Runner discovery'
        await page.screenshot(state / 'agents.png')
        await page.click('[data-agtab=runners]')
        await page.until('document.querySelectorAll("#agBody .rn-card").length===1', 'Runner card')
        assert not await page.js('document.querySelector("#agBody").textContent.includes("缺少 Runner Python")')
        await page.screenshot(state / 'runner.png')
        print('PASS Agent discovery and Runner management UI', flush=True)
        # Reload exercises persisted device identity and automatic Runner recovery.
        await page.call('Page.reload')
        await page.until('window.ClientAuth?.snapshot()?.user && window.soduWorkAPI?.runnerStatus && '
                         '!document.documentElement.classList.contains("soduwork-auth-pending")',
                         'authenticated reload')
        await page.until('soduWorkAPI.runnerStatus().then(s=>s.connected===true)', 'Runner after reload')
        await page.until('SoduWorkAPI.runners().then(i=>i.runners.some(r=>r.online && '
                         'r.scope==="current-instance"))', 'authenticated Runner inventory after reload')
        reloaded = await page.js('SoduWorkAPI.runners()')
        assert [row['runnerId'] for row in reloaded['runners'] if row.get('online')
                and row.get('scope') == 'current-instance'] == [nodes[0]['runnerId']]
        return {'runnerPid': status['pid'], 'runnerState': status['state'],
                'currentRunnerCount': len(nodes), 'agentKeys': agents['keys'],
                'agentCardCount': card_count, 'reloadPreservedRunner': True}


def process_evidence(pid, *, expected_home=None):
    executable = subprocess.check_output(['ps', '-p', str(pid), '-o', 'comm='], text=True).strip()
    result = {'pid': pid, 'executable': executable}
    if expected_home is not None:
        environment = subprocess.check_output(['ps', 'eww', '-p', str(pid), '-o', 'command='], text=True)
        match = re.search(r'(?:^| )HOME=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)', environment)
        assert match and match[1].strip() == str(expected_home), 'Desktop HOME is not the real user home'
        result['realUserHome'] = True
    return result


def verify():
    if sys.platform != 'darwin':
        raise SystemExit('This native source-session verification currently targets macOS')
    state = Path(tempfile.mkdtemp(prefix='soduwork-source-runner-')).resolve()
    port, debug_port = free_port(), free_port()
    base = f'http://127.0.0.1:{port}'
    password = secrets.token_urlsafe(24)
    report = {'ok': False, 'state': str(state), 'nativeKeychain': 'mock Chromium Keychain', 'checks': []}
    output = (state.parent / (state.name + '.launcher.log')).open('wb')
    child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--child-fixture',
                              '--state', str(state), '--port', str(port), '--debug-port', str(debug_port)],
                             cwd=ROOT, stdin=subprocess.PIPE, stdout=output, stderr=subprocess.STDOUT,
                             start_new_session=True)
    child.launcher_log = output.name
    print(f'Isolated source Runner verification: {state}', flush=True)
    desktop_pid = None
    validated = False
    try:
        child.stdin.write((password + '\n').encode())
        child.stdin.close()
        wait_ready(child, base, state, timeout=900)
        desktop_pid = desktop_ready(child, state)
        print('PASS cold source preparation and native Electron startup', flush=True)
        report['checks'].append('cold-source-launcher-hub-migrations-electron-ready')
        report.update(asyncio.run(verify_ui(debug_port, password, state)))
        report['checks'] += ['real-password-login-device-enrollment', 'real-runner-websocket-online',
                             'runner-scoped-agent-discovery-ui', 'runner-ui-and-authenticated-reload']
        report['desktop'] = process_evidence(desktop_pid, expected_home=Path.home())
        executable = Path(report['desktop']['executable'])
        assert executable.name == 'Electron' and executable.parents[2].name == 'SoduWork.app'
        with (executable.parents[1] / 'Info.plist').open('rb') as stream:
            info = plistlib.load(stream)
        assert info['CFBundleName'] == 'SoduWork'
        report['nativeBundleName'] = info['CFBundleName']
        report['runner'] = process_evidence(report['runnerPid'])
        command = subprocess.check_output(['ps', '-p', str(report['runnerPid']), '-o', 'command='], text=True)
        assert str(state / 'venv/bin/python') in command, 'Runner did not use the prepared source venv'
        assert not (state / 'application/hub-backend/.venv').exists()
        report['checks'].append('real-process-home-bundle-and-prepared-runner-interpreter')
        versions = subprocess.check_output([str(state / 'venv/bin/python'), '-c',
            'import cryptography,websockets,inspect,json; '
            'p=inspect.signature(websockets.connect).parameters; '
            'assert "additional_headers" in p and "proxy" in p; '
            'print(json.dumps({"cryptography":cryptography.__version__,"websockets":websockets.__version__}))'], text=True)
        report['dependencies'] = json.loads(versions)
        assert report['dependencies']['cryptography'] == '49.0.0'
        login = request(base, '/api/v1/admin/login', {'user': 'admin', 'pass': password})
        tasks = request(base, '/api/v1/admin/tasks', token=login['token'])
        assert not (tasks.get('items', tasks.get('tasks', [])) if isinstance(tasks, dict) else tasks)
        report['checks'].append('runner-dependency-interface-and-no-created-tasks')
        validated = True
    finally:
        try:
            stop(child, base)
            if desktop_pid:
                desktop_stopped(desktop_pid)
            if report.get('runnerPid'):
                desktop_stopped(report['runnerPid'])
            report['checks'].append('owned-hub-electron-runner-processes-stopped')
            report['ok'] = validated
        finally:
            output.close()
            (state / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--child-fixture', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--state', type=Path, help=argparse.SUPPRESS)
    parser.add_argument('--port', type=int, help=argparse.SUPPRESS)
    parser.add_argument('--debug-port', type=int, help=argparse.SUPPRESS)
    options = parser.parse_args()
    if options.child_fixture:
        raise SystemExit(child_fixture(options.state, options.port, options.debug_port))
    verify()
