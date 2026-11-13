"""Runner output must stay UTF-8 even when Windows initializes CP1252 pipes."""
import ast
import io
import logging
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


class RunnerStdioTests(unittest.TestCase):
    def test_actual_help_with_cp1252_startup_streams(self):
        source = (ROOT / 'runner_main.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        # Run real startup and argument parsing without unrelated runtime
        # dependencies or a full frozen build.
        imports_end = next(n.lineno for n in tree.body if isinstance(n, ast.Import)
                           and any(a.name == 'websockets' for a in n.names))
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
        script = '\n'.join(source.splitlines()[:imports_end - 1])
        script += '\n' + ast.unparse(main) + "\nsys.argv=['soduwork-runner', '--help']; main()\n"
        result = subprocess.run([sys.executable, '-c', "__file__='runner_main.py'; exec(" + repr(script) + ")"], cwd=ROOT, capture_output=True,
                                env={**os.environ, 'PYTHONIOENCODING': 'cp1252', 'PYTHONUTF8': '0'}, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
        text = result.stdout.decode('utf-8')
        self.assertIn('--config-stdin', text)
        self.assertIn('SoduWork 执行机', text)

    def test_help_logs_and_rpc_share_unchanged_utf8_buffers(self):
        from app.services.runner_stdio import configure_output_streams
        out_bytes, err_bytes = io.BytesIO(), io.BytesIO()
        out = io.TextIOWrapper(out_bytes, encoding='cp1252', newline='\n')
        err = io.TextIOWrapper(err_bytes, encoding='cp1252', newline='\n')
        self.addCleanup(out.close)
        self.addCleanup(err.close)
        with self.assertRaises(UnicodeEncodeError):
            out.write('执行机')
        original_stdin = sys.stdin
        with patch.object(sys, 'stdout', out), patch.object(sys, 'stderr', err):
            configure_output_streams()
            self.assertIs(sys.stdout.buffer, out_bytes)
            self.assertIs(sys.stderr.buffer, err_bytes)
            self.assertIs(sys.stdin, original_stdin)
            print('执行机')
            sys.stdout.flush()
            sys.stdout.buffer.write('@@SODUWORK_LOCAL_RPC@@中文\n'.encode('utf-8'))
            handler = logging.StreamHandler(sys.stderr)
            handler.emit(logging.LogRecord('fixture', logging.ERROR, '', 0, '启动失败', (), None))
        self.assertEqual(out_bytes.getvalue().decode('utf-8'), '执行机\n@@SODUWORK_LOCAL_RPC@@中文\n')
        self.assertEqual(err_bytes.getvalue().decode('utf-8'), '启动失败\n')

    def test_absent_streams_and_text_captures_are_preserved(self):
        from app.services.runner_stdio import configure_output_streams
        capture = io.StringIO()
        with patch.object(sys, 'stdout', None), patch.object(sys, 'stderr', capture):
            configure_output_streams()
            self.assertIsNone(sys.stdout)
            self.assertIs(sys.stderr, capture)


if __name__ == '__main__':
    unittest.main()
