"""Internal macOS desktop fixture; never use a real profile or native Keychain.

The source verifier exercises the real launcher and Electron lifecycle with
synthetic data. Mocking Chromium's Keychain is confined to this child fixture,
so unattended checks cannot prompt for or alter the user's Keychain.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.dev import start_local  # noqa: E402


def launch_desktop_fixture(launch, state, client, env, base, output):
    popen = start_local.subprocess.Popen
    script = str(client / 'scripts/start-client.cjs')

    def spawn(command, *args, **kwargs):
        if not isinstance(command, list) or len(command) != 2 or command[1] != script:
            raise RuntimeError('Unexpected desktop fixture launch command')
        return popen([*command, '--use-mock-keychain'], *args, **kwargs)

    with patch.object(start_local.subprocess, 'Popen', spawn):
        return launch(state, client, env, base, output)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument('--data-dir', type=Path, required=True)
    args, _ = parser.parse_known_args(argv)
    state = args.data_dir.resolve()
    if (sys.platform != 'darwin' or state.parent != Path(tempfile.gettempdir()).resolve()
            or not state.name.startswith('soduwork-source-live-') or not state.is_dir()
            or '--desktop' not in argv):
        parser.error('This fixture requires an isolated source verification directory on macOS')
    launch = start_local.launch_desktop
    with patch.object(start_local, 'launch_desktop',
                      lambda *args: launch_desktop_fixture(launch, *args)):
        return start_local.main(argv)


if __name__ == '__main__':
    raise SystemExit(main())
