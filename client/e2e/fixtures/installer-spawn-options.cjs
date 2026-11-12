'use strict';
const assert = require('node:assert/strict');

function installerSpawnOptions(file, args) {
  const tail = args.findIndex(arg => /^(?:\/D=|_\?=)/.test(arg));
  if (tail === -1) return {};
  assert.equal(tail, args.length - 1, 'NSIS directory must be the final argument');
  // NSIS parses /D= and _?= directly from the command line, before ordinary
  // argv unquoting. Quote only argv[0], even when the directory contains spaces.
  return { argv0: '"' + file + '"', windowsVerbatimArguments: true };
}

module.exports = { installerSpawnOptions };
