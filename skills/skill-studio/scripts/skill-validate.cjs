'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const MAX_FILES = 64, MAX_BYTES = 8 * 1024 * 1024;
const COMMON = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const CLAUDE = new Set(['argument-hint', 'disable-model-invocation', 'user-invocable', 'model', 'context', 'agent', 'hooks']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(message) { throw new Error(message); }
function utf8(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(label + ': expected UTF-8 text'); }
}
function noLinks(target) {
  const full = path.resolve(target), root = path.parse(full).root;
  let current = root;
  for (const part of full.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('Symbolic links/junctions are not allowed'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
function safePath(name) {
  if (!name || name.length > 200 || name !== name.normalize('NFC') ||
      /[\\:\x00-\x1f\x7f<>"|?*]/.test(name) ||
      name.split('/').some(p => !p || p.startsWith('.') || /[. ]$/.test(p) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) ||
        /^(?:node_modules|__pycache__)$/i.test(p)) ||
      /\.(?:exe|dll|com|msi|pfx|p12|pem|key)$/i.test(name)) {
    fail('Unsafe or non-portable package path: ' + name);
  }
}
function readTree(source) {
  const root = path.resolve(source); noLinks(root);
  if (!fs.statSync(root).isDirectory()) fail('Source must be a Skill directory');
  const files = Object.create(null), seen = new Set();
  let total = 0;
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name; safePath(name);
      if (seen.has(name.toLowerCase())) fail('Case-insensitive path collision: ' + name);
      seen.add(name.toLowerCase());
      if (seen.size > 300) fail("Package has too many directories");
      const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('Symbolic links/junctions are not allowed');
      if (stat.isDirectory()) { walk(file, name + '/'); continue; }
      if (!stat.isFile()) fail('Only ordinary files can be packaged');
      if (Object.keys(files).length >= MAX_FILES || stat.size + total > MAX_BYTES) fail('Package exceeds 64 files / 8 MiB');
      const data = fs.readFileSync(file);
      total += data.length;
      if (total > MAX_BYTES) fail('Package exceeds 8 MiB');
      const text = data.toString('utf8');
      if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text) ||
          /(?:sk|pk|pat|ghp|glpat)[-_][A-Za-z0-9_-]{12,}/.test(text) ||
          /(?:api[_ -]?key|password|token)\s*[:=]\s*["']?[^\s"']{8,}/i.test(text)) {
        fail('Possible credential in ' + name + '; redact before packaging');
      }
      files[name] = data;
    }
  }
  walk(root);
  return { root, files, bytes: total };
}
// Deliberately bounded YAML subset, not a permissive regex "YAML validator".
function scalar(raw) {
  if (raw.startsWith('"')) {
    try {
      const value = JSON.parse(raw);
      if (typeof value !== 'string') fail('Expected a quoted string');
      return value;
    } catch { fail('Use a valid JSON-quoted YAML string'); }
  }
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) fail('Invalid single-quoted YAML string');
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  const value = raw.replace(/\s+#.*$/, '').trim();
  if (!value || /^(?:[-?:]\s|[!&*[{|>@%\x60])/.test(value) || /:\s/.test(value) || /\t/.test(value)) {
    fail('Unsupported YAML scalar; use a quoted string');
  }
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^(?:null|~)$/i.test(value)) return null;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}
function frontmatter(text) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) fail('SKILL.md requires YAML frontmatter');
  const lines = match[1].split(/\r?\n/), meta = Object.create(null);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue;
    const row = lines[i].match(/^([a-zA-Z][\w-]*):(?:[ ]+(.*)|[ ]*)$/);
    if (!row) fail('Unsupported YAML structure; see references/formats.md');
    const [, key, raw = ''] = row;
    if (Object.hasOwn(meta, key)) fail('Duplicate frontmatter field: ' + key);
    if (/^[|>][-+]?$/.test(raw)) {
      const block = [];
      while (i + 1 < lines.length && (/^  /.test(lines[i + 1]) || !lines[i + 1].trim())) {
        const line = lines[++i];
        if (line.trim() && !/^  \S/.test(line)) fail('Use two-space block indentation');
        block.push(line.slice(2));
      }
      meta[key] = block.join(raw[0] === '>' ? ' ' : '\n').trim();
    } else if (key === 'metadata' && !raw) {
      const values = Object.create(null);
      while (i + 1 < lines.length && /^  /.test(lines[i + 1])) {
        const child = lines[++i].match(/^  ([\w.-]+): +(.*)$/);
        if (!child || Object.hasOwn(values, child[1])) fail('metadata must be a flat string mapping');
        const value = scalar(child[2]);
        if (typeof value !== 'string') fail('metadata values must be strings');
        values[child[1]] = value;
      }
      meta[key] = values;
    } else meta[key] = scalar(raw);
  }
  if (typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64) {
    fail('name must be 1–64 lowercase letters/digits/single hyphens');
  }
  if (typeof meta.description !== 'string' || !meta.description.trim() ||
      [...meta.description].length > 1024 || /[<>]/.test(meta.description)) fail('description must be 1–1024 characters, without angle brackets');
  if (!match[2].trim()) fail('Skill instructions cannot be empty');
  if (meta.metadata != null && (typeof meta.metadata !== 'object' || Array.isArray(meta.metadata))) fail('metadata must be a flat string mapping');
  if (meta.compatibility != null && (typeof meta.compatibility !== 'string' || [...meta.compatibility].length > 500)) fail('compatibility must be at most 500 characters');
  for (const key of ['license', 'allowed-tools']) {
    if (meta[key] != null && typeof meta[key] !== 'string') fail(key + ' must be a string');
  }
  return { meta, body: match[2] };
}
function validate(source) {
  const tree = readTree(source), bytes = tree.files['SKILL.md'];
  if (!bytes) fail('Source must contain SKILL.md');
  const { meta, body } = frontmatter(utf8(bytes, 'SKILL.md'));
  if (path.basename(tree.root) !== meta.name) fail('Source folder must match the Skill name');
  const warnings = [];
  for (const [name, data] of Object.entries(tree.files)) {
    if (!name.endsWith('.md')) continue;
    const text = utf8(data, name);
    for (const match of text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
      let link = match[1] || match[2];
      if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
      try { link = decodeURIComponent(link.split('#')[0]); } catch { fail('Invalid link encoding in ' + name); }
      if (!link || /^[a-z]+:/i.test(link) || link.startsWith('/') || link.includes('\\')) fail('Non-portable link in ' + name);
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
      if (relative.startsWith('../') || (!tree.files[relative] && !Object.keys(tree.files).some(f => f.startsWith(relative + '/')))) {
        fail('Missing or out-of-package reference in ' + name + ': ' + relative);
      }
    }
  }
  if (meta['allowed-tools']) warnings.push('allowed-tools is host-specific, not an authorization grant; no permissions are translated.');
  if (Object.keys(tree.files).some(f => f.startsWith('scripts/'))) warnings.push('Bundled scripts are not executed by this validator. Test them with safe business fixtures.');
  const extra = Object.keys(meta).filter(k => !COMMON.has(k));
  if (extra.length) warnings.push('Host-specific frontmatter retained: ' + extra.join(', '));
  return { ...tree, meta, body, warnings, extra };
}
function checkTargets(result, targets) {
  if (targets.includes('soduwork') && Object.keys(result.files).some(name => name !== 'SKILL.md' && name.endsWith('/SKILL.md'))) {
    fail('SoduWork requires exactly one SKILL.md; rename nested examples or export portable only');
  }
  const unknown = result.extra.filter(k => !CLAUDE.has(k));
  if (unknown.length && targets.some(t => t !== 'portable')) fail('Unknown frontmatter requires manual adaptation; export portable only: ' + unknown.join(', '));
  if (result.extra.some(k => CLAUDE.has(k)) && targets.some(t => !['portable', 'claude'].includes(t))) {
    fail('Claude-only fields cannot be silently converted; select portable,claude or adapt a separate source');
  }
  if (result.files['agents/openai.yaml'] && targets.some(t => !['portable', 'codex'].includes(t))) {
    fail('Codex configuration requires manual adaptation for other hosts; select portable,codex');
  }
}
module.exports = { validate, checkTargets, noLinks, hash, fail };
