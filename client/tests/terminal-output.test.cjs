'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

// A real stopped PTY reproduces terminal selection / flow-control backpressure.
// The acknowledgement uses a separate file, so a blocked write cannot fake it.
const probe = String.raw`
import json, os, pathlib, pty, select, subprocess, sys, tempfile, termios, time
config = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    ready, alive = root / 'ready', root / 'alive'
    master, slave = pty.openpty()
    script = '''
      require(process.argv[1]).initialize();
      const fs = require('node:fs');
      // Initialize both lazy streams before the parent stops terminal output.
      void process.stdout; void process.stderr;
      fs.writeFileSync(process.argv[2], 'ready');
      process.stdin.once('data', () => {
        console[process.argv[4]]('terminal-output-regression');
        setTimeout(() => fs.writeFileSync(process.argv[3], 'alive'), 20);
      });
    '''
    child = subprocess.Popen([config['node'], '-e', script, config['module'],
        str(ready), str(alive), config['method']], stdin=subprocess.PIPE,
        stdout=slave, stderr=slave)
    def wait_for(path):
        deadline = time.monotonic() + 3
        while not path.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        return path.exists()
    try:
        assert wait_for(ready), 'child did not initialize'
        termios.tcflow(slave, termios.TCOOFF)
        child.stdin.write(b'go\n')
        child.stdin.flush()
        responsive = wait_for(alive)
        termios.tcflow(slave, termios.TCOON)
        output = b''
        deadline = time.monotonic() + 3
        while b'terminal-output-regression' not in output and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                output += os.read(master, 4096)
        assert responsive, 'terminal write blocked the event loop'
        assert b'terminal-output-regression' in output, 'output was not flushed after resume'
        child.stdin.close()
        assert child.wait(timeout=3) == 0
    finally:
        termios.tcflow(slave, termios.TCOON)
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)
`;

for (const method of ['log', 'error']) {
  test(`console.${method} keeps timers responsive while a Linux terminal is stopped`, {
    skip: process.platform !== 'linux', timeout: 15000,
  }, () => {
    const result = spawnSync('python3', ['-c', probe], {
      input: JSON.stringify({ node: process.execPath,
        module: require.resolve('../main/terminal-output.cjs'), method }),
      encoding: 'utf8', timeout: 12000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
