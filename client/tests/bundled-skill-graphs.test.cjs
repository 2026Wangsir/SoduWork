'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const renderer = path.resolve(__dirname, '../../skills/writing-skills/render-graphs.js');

for (const combine of [false, true]) {
  for (const succeeds of [false, true]) {
    test(`bundled skill graph renderer reports ${succeeds ? 'success' : 'failure'} for ${combine ? 'combined' : 'separate'} diagrams`, t => {
      const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'soduwork-skill-graph-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const skill = path.join(root, 'sample-skill');
      fs.mkdirSync(skill);
      fs.writeFileSync(path.join(skill, 'SKILL.md'), '# Fixture\n\n```dot\ndigraph flow { a -> b; }\n```\n');
      const preload = path.join(root, 'graphviz-fixture.cjs');
      // Replace only the external renderer; run the real CLI and inspect its files and exit status.
      fs.writeFileSync(preload, `
const cp = require('node:child_process');
cp.execFileSync = (command, args) => {
  if (command !== 'dot') throw new Error('Unexpected external command');
  if (args[0] === '-V') return '';
  if (${succeeds}) return '<svg xmlns="http://www.w3.org/2000/svg"><text>fixture</text></svg>';
  throw new Error('Synthetic graph renderer failure');
};
require('node:module').syncBuiltinESMExports();
`);
      const result = spawnSync(process.execPath,
        ['--require', preload, renderer, skill, ...(combine ? ['--combine'] : [])],
        { cwd: root, encoding: 'utf8', timeout: 15000 });
      assert.ifError(result.error);
      assert.equal(result.status, succeeds ? 0 : 1, result.stdout + result.stderr);
      const diagrams = fs.readdirSync(path.join(skill, 'diagrams')).filter(name => name.endsWith('.svg'));
      assert.equal(diagrams.length, succeeds ? 1 : 0);
      if (succeeds) assert.match(fs.readFileSync(path.join(skill, 'diagrams', diagrams[0]), 'utf8'), /<svg/);
      else assert.match(result.stderr, /Synthetic graph renderer failure/);
    });
  }
}
