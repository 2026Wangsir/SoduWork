"""Isolated real OpenCode + Runner acceptance; select --binary explicitly."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    binary = str(Path(parser.parse_args().binary).resolve(strict=True))
    reports = []
    with tempfile.TemporaryDirectory(prefix='soduwork-opencode-outcome-e2e-') as folder:
        root = Path(folder)
        os.environ['SODUWORK_DATA_ROOT'] = str(root / 'parent')
        os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'
        from app.services import acp_bridge, local_base, local_stream, local_turn_outcome

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                self.server.calls.append((self.path, body.get('model')))
                step = self.server.step
                self.server.step += 1
                compact = self.server.compact
                delta = {'role': 'assistant', self.server.content_key: 'A partial fixture response'}
                finish = self.server.reason
                if compact and step == 0:
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'fixture-write', 'type': 'function',
                             'function': {'name': 'write', 'arguments': json.dumps({
                                 'filePath': str(self.server.work / 'progress.txt'), 'content': 'preserved progress'})}}]}
                    finish = 'tool_calls'
                elif compact and step == 1:
                    finish = 'stop'
                frames = [{'choices': [{'index': 0, 'delta': {'role': 'assistant', self.server.content_key:
                           'A partial fixture response'}, 'finish_reason': None}]},
                          {'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}],
                           'usage': {'prompt_tokens': 124000 if compact and step == 0 else 1,
                                     'completion_tokens': 3, 'total_tokens': 124003 if compact and step == 0 else 4}}]
                frames[0]['choices'][0]['delta'] = delta
                raw = (''.join('data: ' + json.dumps({'id': 'fixture', 'model': 'fixture', **row})
                               + '\n\n' for row in frames) + 'data: [DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
        server.calls = []
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for transport in ('native', 'acp'):
                for content in ('content', 'reasoning_content', 'auto_compaction'):
                    name = transport + '-' + content
                    case = root / name
                    work = case / 'workspace'
                    work.mkdir(parents=True)
                    clean = {'PATH': os.environ['PATH'], 'HOME': str(case / 'home'),
                             'SODUWORK_DATA_ROOT': str(case / 'runner'), 'OPENCODE_DB': str(case / 'native.db'),
                             'OPENCODE_DISABLE_AUTOUPDATE': '1', 'OPENCODE_DISABLE_MODELS_FETCH': '1',
                             'OPENCODE_DISABLE_PROJECT_CONFIG': '1', 'OPENCODE_DISABLE_SHARE': '1',
                             'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
                             'ALL_PROXY': 'http://127.0.0.1:9', 'NO_PROXY': '127.0.0.1,localhost',
                             'no_proxy': '127.0.0.1,localhost', 'PYTHONDONTWRITEBYTECODE': '1'}
                    for key in ('SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'):
                        if os.environ.get(key):
                            clean[key] = os.environ[key]
                    for key in ('XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
                                'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'):
                        target = case / key
                        target.mkdir()
                        clean[key] = str(target)
                    cfg = {'llm': {'base': f'http://127.0.0.1:{server.server_port}/v1', 'model': 'fixture',
                                   'key': 'synthetic-e2e-key', 'kind': 'openai-compat'}}
                    with patch.dict(os.environ, clean, clear=True):
                        env = local_base._env_for(local_base._PROFILES['opencode'], cfg)
                    config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
                    config['agent'] = {'title': {'disable': True}}
                    env['OPENCODE_CONFIG_CONTENT'] = json.dumps(config)
                    from tests.opencode_native_dependencies import seed
                    seed(binary, case / 'runner')
                    sid = ''
                    for reason in ('length', 'stop'):
                        server.reason = reason
                        server.content_key = content if reason == 'length' and content != 'auto_compaction' else 'content'
                        server.compact = content == 'auto_compaction'
                        server.step = 0
                        server.work = work
                        if transport == 'native':
                            command = [binary, 'run', '--format', 'json', '--thinking', '--dir', str(work)]
                            if sid:
                                command += ['--session', sid]
                        else:
                            command = [sys.executable, acp_bridge.__file__, '--cwd', str(work), '--agent-name', 'opencode']
                            if sid:
                                command += ['--session', sid]
                            command += ['--', binary, 'acp']
                        flags = ({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt'
                                 else {'start_new_session': True})
                        process = subprocess.Popen(command, cwd=work, env=env, stdin=subprocess.PIPE,
                                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                                   text=True, encoding='utf-8', errors='replace', **flags)
                        before = len(server.calls)
                        try:
                            stdout, stderr = process.communicate('Reply briefly without using tools.', timeout=60)
                        except subprocess.TimeoutExpired:
                            local_stream._kill_pid_tree(process.pid, process)
                            process.communicate(timeout=5)
                            raise AssertionError('Isolated native OpenCode timed out')
                        assert 'SODUWORK_OPENCODE_OUTCOME:' not in stdout + stderr
                        assert 'synthetic-e2e-key' not in stdout + stderr
                        events = [json.loads(line) for line in stdout.splitlines() if line.startswith('{')]
                        current_sid = next((event['sessionID'] for event in events if event.get('sessionID')), '')
                        assert current_sid and (not sid or sid == current_sid), (name, reason, events, stderr)
                        sid = current_sid
                        ref = name + '-' + reason
                        run = {'state': 'running', 'cli': 'opencode', 'ws': str(work), 'seq': 0,
                               'lines': [], 'cfg': {}, 'artifactMode': 'files', 'cliSid': sid,
                               'expectedOutputPaths': ['result.txt'], 'conversationMode': 'adaptive', 'turnStartSeq': 0}
                        local_base._RUNS[ref] = run
                        terminal = {}
                        try:
                            for event in events:
                                local_stream._on_line(ref, json.dumps(event), terminal)
                            with patch.object(local_stream, '_resume') as resume:
                                local_stream._finish(ref, process.returncode, terminal, '')
                            resume.assert_not_called()
                            expected = 'failed' if reason == 'length' else 'done'
                            assert run['state'] == expected, (name, reason, run, stderr)
                            if reason == 'length':
                                assert run.get('failureKind') == 'execution_incomplete', (name, events, stderr, terminal)
                                assert run['error'] == local_turn_outcome.TRUNCATED
                            if content == 'auto_compaction':
                                assert (work / 'progress.txt').read_text() == 'preserved progress'
                                assert server.step >= 3, (name, events, server.step)
                            assert server.calls[before:] and all(call == ('/v1/chat/completions', 'fixture')
                                                                for call in server.calls[before:])
                            reports.append({'transport': transport, 'content': content, 'stopReason': reason,
                                            'exit': process.returncode, 'state': run['state'], 'sameSession': True})
                        finally:
                            local_base._RUNS.pop(ref, None)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)
    print(json.dumps({'ok': True, 'cases': reports}, indent=2))


if __name__ == '__main__':
    main()
