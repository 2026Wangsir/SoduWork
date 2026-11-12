'use strict';

function initialize() {
  if (process.platform !== 'linux') return;
  // Node makes POSIX TTY writes synchronous. A paused terminal (including a
  // WSL console in selection mode) must not stop Electron's window/IPC loop.
  // Node exposes no public switch; feature-detect the bundled runtime's handle.
  for (const output of [process.stdout, process.stderr]) {
    if (output.isTTY && typeof output._handle?.setBlocking === 'function') {
      output._handle.setBlocking(false);
    }
  }
}

module.exports = { initialize };
