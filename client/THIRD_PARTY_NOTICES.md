# Third-party notices

The sections below list third-party components bundled in the desktop installers and their licenses. Components used only by source builds are recorded in `third-party/manifest.json`.

## 7-Zip (Windows installer)

The Windows installer embeds the unmodified 7-Zip 24.09 standalone extractor
provided by electron-builder's checksum-verified toolset. It is used only to
stage update files, including deep Unicode paths.

- Project and source: https://www.7-zip.org/
- License: GNU LGPL (with upstream BSD/unRAR notices where applicable).
- Complete upstream notices: `7zip-LICENSE.txt` and `7zip-COPYING` beside the installed launcher.

## Git for Windows PortableGit

SoduWork for Windows includes PortableGit binaries with the distribution trimmed of unused components so the installed
application can execute its local AI tools without requiring a separate Git or
Bash installation.

- Project: Git for Windows
- Version: 2.55.0(4)
- Source: https://github.com/git-for-windows/git/tree/v2.55.0.windows.4
- Release: https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.4

Git is licensed under GNU GPL version 2. PortableGit also contains Bash, MSYS2,
OpenSSH, OpenSSL, curl and other components under their respective licenses.
The complete license texts distributed by the upstream project remain inside
the packaged resources/shell directory, including LICENSE.txt and the component
license directories.

## Feishu personal connection

- Official MCP: @larksuiteoapi/lark-mcp 0.5.1, https://github.com/larksuite/lark-openapi-mcp (MIT).
- Official application registration: @larksuiteoapi/node-sdk 1.73.3 (MIT), used as an installed dependency; its original license remains in node_modules/@larksuiteoapi/node-sdk/LICENSE.
- Device OAuth interoperability follows https://github.com/larksuite/cli/blob/main/internal/auth/device_flow.go (MIT, Copyright (c) 2026 Lark Technologies Pte. Ltd.). SoduWork implements the protocol in its own main-process code; no CLI source file is bundled.

The desktop installs these fixed dependencies on explicit connection preparation with npm lifecycle scripts disabled. Package integrity records are in main/platform-connections/providers/feishu/upstream-lock.json.

## ssh2

SoduWork uses the `ssh2` Node.js client for an authenticated cloud-computer
connection test and the one-time Runner setup step. The package and its direct
dependencies (`asn1`, `bcrypt-pbkdf`, `safer-buffer`, and `tweetnacl`) retain
their upstream license files in the packaged `resources/ssh2` directory.

- Project: https://github.com/mscdex/ssh2
- Version: 1.17.0
- License: MIT (ssh2/asn1/safer-buffer); BSD-3-Clause (bcrypt-pbkdf); Unlicense (tweetnacl).

## PyInstaller (Runner executable)

The desktop installers for Windows, macOS and Linux include a standalone Runner
(`soduwork-runner.exe` on Windows, `soduwork-runner` on macOS and Linux) built with
PyInstaller. PyInstaller is a build tool only; users do not need to install Python
or PyInstaller. Each Runner executable embeds the unmodified PyInstaller bootloader
and run-time hooks taken from the PyInstaller wheel.

- Project: https://pyinstaller.org/
- Source: https://github.com/pyinstaller/pyinstaller/tree/v6.21.0
- Version: 6.21.0 (pinned in `hub-backend/requirements-runner-build.txt`)
- License: GNU GPL version 2 or later, with the PyInstaller Bootloader Exception.
  Run-time hooks are licensed under Apache-2.0.

The Bootloader Exception permits the bootloader to be combined with and distributed
as part of an executable without placing the combined program under the GPL. The
Runner's own code remains under the SoduWork MIT license, and its Python
dependencies keep their own licenses. The complete PyInstaller license, including
the exception, is included as `COPYING.txt` in the Runner's `third-party/python/pyinstaller-<version>`
directory.

## Pi runtime and bundled dependencies

Pi SDK 1.4.0 is MIT licensed, Copyright (c) 2025 Mario Zechner. Its original license is
included in resources/third-party/licenses/pi-LICENSE.txt. Version and pinned
upstream provenance are in resources/third-party/manifest.json. SoduWork applies
an extension-factory cache patch through scripts/patch-pi-extension-cache.cjs;
this is a local modification, not an upstream Pi release.

The build stages the complete locked production tree under resources/pi/node_modules,
including hoisted and nested packages, without copying development dependencies.
The build collects the LICENSE/COPYING/NOTICE texts and version metadata for
packaged Pi and SSH dependencies in resources/third-party/inventory. Entries
marked upstream-confirmation-needed are recorded gaps, not a grant of rights.
See resources/third-party/README.md for the remaining distribution work.

## Bundled renderer components and skills

Original licenses for marked, highlight.js (BSD-3-Clause), jsdiff, diff2html,
DOMPurify, CodeMirror and xterm remain alongside their files in vendor/. The
complete diff2html 3.4.56 MIT notice includes its original copyright.

The development skill bundle includes fixed-version Matt Pocock and Superpowers
guides under MIT and Anthropic frontend-design under Apache-2.0. Each skill
retains its original license, UPSTREAM.md, and any adaptation records. See
../skills/THIRD-PARTY.md and ../third-party/manifest.json for the reviewed scope
and resource hashes. Other skill suites and official platform documentation
snapshots remain excluded. Runtime dependencies and compatibility adapters
retain their applicable original notices.
