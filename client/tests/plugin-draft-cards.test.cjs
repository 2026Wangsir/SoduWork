'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../components/panels/chat-output-links');

/* Minimal DOM stub: only the surface pluginDrafts / supersededDraftCard touch.
   Attribute selectors are matched by exact attribute/value extraction instead
   of a CSS parser — the module escapes values with the same convention. */
function element(tag = 'div') {
  const el = {
    tagName: (tag || 'div').toLowerCase(), className: '', children: [], attributes: {},
    ownerDocument: null, textContent: '', innerHTML: '', hidden: false, title: '',
    appendChild(child) { child.remove(); el.children.push(child); child.parent = el; return child; },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter(child => child !== el); el.parent = null; },
    append(...nodes) { nodes.forEach(node => el.appendChild(node)); },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) { return name in el.attributes ? el.attributes[name] : null; },
    removeAttribute(name) { delete el.attributes[name]; },
    querySelectorAll(selector) {
      const hits = [];
      const walk = node => node.children.forEach(child => {
        if (matches(child, selector)) hits.push(child);
        walk(child);
      });
      walk(el); return hits;
    },
    querySelector(selector) { return el.querySelectorAll(selector)[0] || null; },
    matches(selector) { return matches(el, selector); },
    cloneNode() { return clone(el); },
    closest(selector) { let node = el; while (node) { if (matches(node, selector)) return node; node = node.parent; } return null; },
  };
  const dash = key => 'data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  el.dataset = new Proxy({}, {
    set(obj, key, value) { el.setAttribute(dash(key), value); return true; },
    get(obj, key) { return el.attributes[dash(key)]; },
  });
  el.classList = {
    contains: name => el.className.split(/\s+/).includes(name),
    add: name => { if (!el.classList.contains(name)) el.className = (el.className + ' ' + name).trim(); },
  };
  return el;
}
function clone(el) {
  const copy = element(el.tagName);
  copy.className = el.className; copy.attributes = { ...el.attributes };
  copy.children = el.children.map(clone);
  return copy;
}
const attrSelector = /^\[([a-zA-Z-]+)="(.*)"\]$/;
const bareAttr = /^\[([a-zA-Z-]+)\]$/;
function matches(el, selector) {
  if (selector.startsWith('[') && selector.includes('][')) return selector.match(/\[[^\]]+\]/g).every(part => matches(el, part));
  const attr = attrSelector.exec(selector);
  if (attr) return String(el.attributes[attr[1]] || '') === attr[2];
  const bare = bareAttr.exec(selector);
  if (bare) return bare[1] in el.attributes;
  return selector.trim().split('.').filter(Boolean)
    .every(name => el.className.split(/\s+/).includes(name));
}
function message(className = 'nmsg ai') {
  const node = element('div');
  node.className = className;
  return node;
}

const manifest = (pluginIdentity, extra = {}) => ({
  artifactId: 'art_current', name: 'soduwork-plugin-draft.json', relative: 'soduwork-plugin-draft.json',
  path: 'C:\\ws\\soduwork-plugin-draft.json', pluginDraft: true, pluginPackage: false,
  pluginName: '销售数据问答', pluginVersion: '1.0.0', pluginIdentity, ...extra,
});
const archive = (pluginIdentity, extra = {}) => ({
  name: '销售数据问答-1.0.0.soduwork-plugin', relative: '销售数据问答-1.0.0.soduwork-plugin',
  path: 'C:\\ws\\销售数据问答-1.0.0.soduwork-plugin', pluginDraft: true, pluginPackage: true,
  pluginName: '', pluginVersion: '', pluginIdentity, ...extra,
});

function cardsOf(root) { return root.querySelectorAll('[data-chat-node]'); }
function render(files) {
  const root = element('div');
  root.ownerDocument = { createElement: tag => element(tag) };
  root.appendChild(message('nmsg ai'));
  links.pluginDrafts(root, files, 'ref-1');
  return root;
}
const copyLabel = card =>
  card.children.find(c => c.className === 'nplugin-draft-copy').children[0].textContent;

test('skill packages identify their destination as the skill library', () => {
  const root = render([archive('skill:weekly-summary', { name: 'weekly-summary.skill', skillPackage: true })]);
  const card = cardsOf(root)[0];
  assert.equal(copyLabel(card), '技能已生成');
  assert.equal(card.querySelector('.nplugin-draft-copy').children[1].textContent, '检查内容后，安装到我的技能库');
  assert.match(card.querySelector('.nplugin-draft-icon').innerHTML, /circle/);
  assert.equal(card.querySelector('[data-install-plugin-draft]').textContent, '检查并安装');
});

test('resource-only repair renews the install card at the repaired reply and clears its stale error', () => {
  const { root, snapshot } = conversation();
  const original = manifest('name:sales-qa', { at: 130, pluginRevisionAt: 130, pluginRevision: 'before' });
  links.pluginDrafts(root, [original], 'ref-1', snapshot);
  const old = cardsOf(root).find(node => node.className === 'nplugin-draft');
  old.querySelector('.nplugin-draft-error').textContent = 'checksum mismatch';
  old.querySelector('.nplugin-draft-error').hidden = false;
  links.pluginDrafts(root, [{ ...original, pluginRevisionAt: 230, pluginRevision: 'repaired' }], 'ref-1', snapshot);
  const card = root.querySelector('.nplugin-draft');
  assert.notEqual(card, old);
  assert.equal(root.querySelectorAll('.nplugin-draft').length, 1);
  assert.equal(card.closest('.nmsg.ai').dataset.chatNode, 'message:4');
  assert.equal(card.querySelector('.nplugin-draft-error').hidden, true);
  links.pluginDrafts(root, [{ ...original, pluginRevisionAt: 230, pluginRevision: 'repaired' }], 'ref-1', snapshot);
  assert.equal(root.querySelector('.nplugin-draft'), card, 'unchanged retries retain their state');
});

test('cards: two file entries of one plugin identity render exactly one install card', () => {
  const root = render([manifest('name:sales-qa'), archive('name:sales-qa')]);
  assert.equal(cardsOf(root).length, 1, 'identity dedup folds manifest+archive into a single card');
  assert.equal(cardsOf(root)[0].attributes['data-plugin-draft-identity'], 'name:sales-qa');
  assert.match(copyLabel(cardsOf(root)[0]), /销售数据问答/);
});

test('cards: superseded candidates never solicit an install', () => {
  const root = render([
    manifest('name:sales-qa', { pluginSuperseded: true }),
    archive('name:sales-qa', { pluginSuperseded: true }),
  ]);
  assert.equal(cardsOf(root).length, 0,
    'the merge marks a whole identity group superseded; no copy of it solicit an install');
});

test('cards: two generations of one identity render only the newest card', () => {
  const root = render([
    manifest('name:sales-qa', { pluginSuperseded: true, artifactId: 'art_v1' }),
    manifest('name:sales-qa', { artifactId: 'art_v2', pluginVersion: '1.1.0' }),
  ]);
  assert.equal(cardsOf(root).length, 1, 'a revision replaces, never stacks');
  const installBtn = cardsOf(root)[0].children.find(c => c.tagName === 'button');
  assert.equal(installBtn.attributes['data-install-plugin-draft'], 'art_v2',
    'the install button targets the newest manifest');
});

test('cards: unindexed turn writes stay silent until the indexed candidate speaks', () => {
  const raw = { name: 'soduwork-plugin-draft.json', relative: 'soduwork-plugin-draft.json',
    path: 'C:\\ws\\soduwork-plugin-draft.json', kind: 'file', changedInTurn: true };
  assert.equal(links.isPluginDraft(raw), true, 'the write is still recognized as a draft file');
  assert.equal(cardsOf(render([raw])).length, 0,
    'no provisional anonymous card — the indexed candidate follows within the settle window');
});

test('cards: a named entry without a trusted identity still renders, identity falls back to its file key', () => {
  const legacy = { artifactId: 'art_legacy', name: 'soduwork-plugin-draft.json',
    relative: 'soduwork-plugin-draft.json', path: 'C:\\ws\\soduwork-plugin-draft.json',
    pluginDraft: true, pluginPackage: false, pluginName: '销售数据问答', pluginVersion: '1.0.0' };
  const root = render([legacy]);
  const card = cardsOf(root)[0];
  assert.ok(card, 'older indexed snapshots keep their card');
  assert.equal(card.attributes['data-plugin-draft-identity'], 'art_legacy',
    'key fallback keeps the card addressable and dedupable');
  assert.match(copyLabel(card), /销售数据问答/);
});

test('cards: an identity-only candidate (package kept alone) renders with the anonymous fallback copy', () => {
  const lone = archive('file:c:\\ws\\mystery-tool-2.0.0.soduwork-plugin');
  const root = render([lone]);
  const card = cardsOf(root)[0];
  assert.ok(card, 'a package kept alone still offers its install');
  assert.equal(card.attributes['data-plugin-draft-identity'], 'file:c:\\ws\\mystery-tool-2.0.0.soduwork-plugin');
  assert.match(copyLabel(card), /插件已生成/);
});

test('clone rule 1: a card whose file is still current keeps its historical anchor', () => {
  const card = element('div');
  card.className = 'nplugin-draft';
  card.setAttribute('data-plugin-draft-identity', 'name:sales-qa');
  card.setAttribute('data-install-plugin-draft', 'art_current');
  assert.equal(links._supersededDraftCard(card, [manifest('name:sales-qa')]), false);
});

test('clone rule 2: a same-identity card for a replaced file no longer clones', () => {
  const card = element('div');
  card.className = 'nplugin-draft';
  card.setAttribute('data-plugin-draft-identity', 'name:sales-qa');
  card.setAttribute('data-install-plugin-draft', 'art_old');
  assert.equal(links._supersededDraftCard(card, [manifest('name:sales-qa')]), true);
});

test('clone rule 3: historical cards of absent identities are untouched', () => {
  const card = element('div');
  card.className = 'nplugin-draft';
  card.setAttribute('data-plugin-draft-identity', 'name:other-plugin');
  card.setAttribute('data-install-plugin-draft', 'art_other');
  assert.equal(links._supersededDraftCard(card, [manifest('name:sales-qa')]), false,
    'unrelated plugin history keeps its card');
});

test('clone guard: non-plugin cards and identity-less cards are never filtered', () => {
  const delivery = element('div');
  delivery.className = 'ndelivery';
  assert.equal(links._supersededDraftCard(delivery, [manifest('name:sales-qa')]), false);
  const anonymous = element('div');
  anonymous.className = 'nplugin-draft';
  anonymous.setAttribute('data-install-plugin-draft', 'art_old');
  assert.equal(links._supersededDraftCard(anonymous, [manifest('name:sales-qa')]), false);
});

test('clone rule 2 also fires when the superseding entry is the newest of several', () => {
  const card = element('div');
  card.className = 'nplugin-draft';
  card.setAttribute('data-plugin-draft-identity', 'name:sales-qa');
  card.setAttribute('data-install-plugin-draft', 'art_v1');
  assert.equal(links._supersededDraftCard(card, [
    manifest('name:sales-qa', { pluginSuperseded: true, artifactId: 'art_v2' }),
    manifest('name:sales-qa'),
  ]), true, 'current entry (any key) supersedes the old card');
  assert.equal(links._supersededDraftCard(card, [
    manifest('name:sales-qa', { pluginSuperseded: true }),
  ]), false, 'superseded-only entries do not retire history');
});

function conversation() {
  const root = element(); root.ownerDocument = { createElement: tag => element(tag) };
  const messages = [
    { role: 'user', sentAt: 100 }, { role: 'assistant', completedAt: 120 },
    { role: 'assistant', completedAt: 140 }, { role: 'user', sentAt: 200 },
    { role: 'assistant', completedAt: 240 },
  ];
  const nodes = messages.map((item, index) => {
    const node = message('nmsg ' + (item.role === 'user' ? 'user' : 'ai'));
    node.dataset.chatNode = 'message:' + index;
    node.dataset.deliveryFinal = String(index === 2 || index === 4);
    root.appendChild(node); return node;
  });
  const mention = element('button'); mention.dataset.openApp = 'art_current'; nodes[1].appendChild(mention);
  return { root, nodes, snapshot: { messages } };
}
test('cards: a draft mentioned mid-generation belongs to that turn final reply, not later conversation', () => {
  const { root, nodes, snapshot } = conversation();
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 130 })], 'ref-1', snapshot);
  assert.equal(root.querySelector('.nplugin-draft').parent, nodes[2]);
  assert.equal(nodes[4].querySelector('.nplugin-draft'), null);
});
test('cards: same-path revision moves one existing card to its own final reply and stays there', () => {
  const { root, nodes, snapshot } = conversation();
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 130 })], 'ref-1', snapshot);
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 220 })], 'ref-1', snapshot);
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 220 }), archive('name:sales-qa', { at: 135 })], 'ref-1', snapshot);
  assert.equal(root.querySelectorAll('.nplugin-draft').length, 1);
  assert.equal(root.querySelector('.nplugin-draft').parent, nodes[4]);
});
test('cards: a known older owner outside the rendered window does not borrow a later reply', () => {
  const { root, nodes, snapshot } = conversation();
  nodes[1].remove(); nodes[2].remove();
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 130 })], 'ref-1', snapshot);
  assert.equal(root.querySelectorAll('.nplugin-draft').length, 1);
  assert.equal(root.querySelector('.nplugin-draft').parent, root);
  assert.equal(root.querySelector('.nplugin-draft').dataset.pluginDraftHistorical, 'true');
});
test('cards: ISO timestamps and a no-filename final reply retain generation ownership', () => {
  const { root, nodes, snapshot } = conversation();
  snapshot.messages.forEach(item => {
    if (item.sentAt) item.sentAt = new Date(1700000000000 + item.sentAt).toISOString();
    if (item.completedAt) item.completedAt = new Date(1700000000000 + item.completedAt).toISOString();
  });
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 1700000000130 })], 'ref-1', snapshot);
  assert.equal(root.querySelector('.nplugin-draft').parent, nodes[2]);
});
test('cards: a missing later user time uses completed reply bounds, never the earlier dated user', () => {
  const { root, nodes, snapshot } = conversation();
  delete snapshot.messages[3].sentAt;
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 220 })], 'ref-1', snapshot);
  assert.equal(root.querySelector('.nplugin-draft')?.parent?.dataset.chatNode, nodes[4].dataset.chatNode);
});
test('cards: a missing first user time retains its draft before the next dated turn', () => {
  const { root, nodes, snapshot } = conversation();
  delete snapshot.messages[0].sentAt;
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 130 })], 'ref-1', snapshot);
  assert.equal(root.querySelector('.nplugin-draft')?.parent?.dataset.chatNode, nodes[2].dataset.chatNode);
});
test('cards: unknown adjacent user and completion times cannot move an existing card across turns', () => {
  const { root, nodes, snapshot } = conversation();
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 130 })], 'ref-1', snapshot);
  snapshot.messages.forEach(item => { delete item.sentAt; delete item.completedAt; });
  nodes[1].children.find(node => node.dataset.openApp)?.remove();
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 220 })], 'ref-1', snapshot);
  assert.equal(root.querySelectorAll('.nplugin-draft').length, 1);
  assert.equal(root.querySelector('.nplugin-draft')?.parent?.dataset.chatNode, nodes[2].dataset.chatNode);
});
test('cards: undated history with a trusted mention uses that turn final reply, not the latest reply', () => {
  const { root, nodes, snapshot } = conversation();
  snapshot.messages.forEach(item => { delete item.sentAt; delete item.completedAt; });
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 130 })], 'ref-1', snapshot);
  assert.equal(root.querySelector('.nplugin-draft')?.parent?.dataset.chatNode, nodes[2].dataset.chatNode);
});
test('cards: provider assistant timestamp cannot attribute a legacy draft to an unrelated reply', () => {
  const { root, nodes, snapshot } = conversation();
  snapshot.messages.forEach(item => { delete item.sentAt; delete item.completedAt; });
  nodes[1].children.find(node => node.dataset.openApp)?.remove();
  snapshot.messages[2].timestamp = 140;
  snapshot.messages[4].timestamp = 240;
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 220 })], 'ref-1', snapshot);
  assert.equal(root.querySelectorAll('.nplugin-draft').length, 1);
  assert.equal(root.querySelector('.nplugin-draft').parent, root);
  assert.match(root.querySelector('.nplugin-draft-copy').children[1].textContent, /会话中已生成/);
});
test('cards: standalone legacy entry survives rerender, gains ownership, then revises without duplication', () => {
  const { root, nodes, snapshot } = conversation();
  const dated = structuredClone(snapshot);
  snapshot.messages.forEach(item => { delete item.sentAt; delete item.completedAt; });
  nodes[1].children.find(node => node.dataset.openApp)?.remove();
  const files = [manifest('name:sales-qa', { at: 130 })];
  links.pluginDrafts(root, files, 'ref-1', snapshot);
  links.pluginDrafts(root, files, 'ref-1', snapshot);
  assert.equal(root.querySelectorAll('.nplugin-draft').length, 1);
  assert.equal(root.querySelector('.nplugin-draft')?.parent, root);
  links.pluginDrafts(root, files, 'ref-1', dated);
  assert.equal(root.querySelectorAll('.nplugin-draft').length, 1);
  assert.equal(root.querySelector('.nplugin-draft')?.parent?.dataset.chatNode, nodes[2].dataset.chatNode);
  assert.equal(root.querySelector('.nplugin-draft').dataset.pluginDraftHistorical, 'false');
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 220 })], 'ref-1', dated);
  assert.equal(root.querySelectorAll('.nplugin-draft').length, 1);
  assert.equal(root.querySelector('.nplugin-draft')?.parent?.dataset.chatNode, nodes[4].dataset.chatNode);
});
test('cards: a known owner still generating waits instead of creating a standalone legacy entry', () => {
  const { root, nodes, snapshot } = conversation();
  snapshot.messages[4].done = false;
  nodes[4].dataset.deliveryFinal = 'false';
  links.pluginDrafts(root, [manifest('name:sales-qa', { at: 220 })], 'ref-1', snapshot);
  assert.equal(root.querySelectorAll('.nplugin-draft').length, 0);
});
test('cards: a standalone historical entry survives an unrelated streaming transcript rebuild once', () => {
  const { root, nodes, snapshot } = conversation();
  snapshot.messages.forEach(item => { delete item.sentAt; delete item.completedAt; });
  nodes[1].children.find(node => node.dataset.openApp)?.remove();
  const files = [manifest('name:sales-qa', { at: 130 })];
  links.pluginDrafts(root, files, 'ref-1', snapshot);
  const originalCard = root.querySelector('.nplugin-draft');
  const carry = require('../components/panels/chat-decorate-carry');
  const captured = carry.capture(root);
  const rebuilt = element(); rebuilt.appendChild(message());
  carry.reconcile(rebuilt, files, captured);
  carry.reconcile(rebuilt, files, captured);
  assert.equal(rebuilt.querySelectorAll('.nplugin-draft').length, 1);
  assert.equal(rebuilt.querySelector('.nplugin-draft').parent, rebuilt);
  assert.equal(rebuilt.querySelector('.nplugin-draft'), originalCard,
    'pending install handlers must keep their real button and error element');
});
test('clone rule: real install button key preserves same-file historical cards', () => {
  const card = cardsOf(render([manifest('name:sales-qa')]))[0];
  assert.equal(links._supersededDraftCard(card, [manifest('name:sales-qa')]), false);
  assert.equal(links._supersededDraftCard(card, [manifest('name:sales-qa'), archive('name:sales-qa')]), false,
    'a packaged copy does not retire the still-current manifest card');
});
test('cards: late user timestamp hydration invalidates ownership memo without depending on reply text', () => {
  const before = { messages: [{ role: 'user' }, { role: 'assistant', text: '原文' }] };
  const after = { messages: [{ role: 'user', sentAt: 100 }, { role: 'assistant', text: '原文' }] };
  assert.notEqual(links._decorateStateSignature(before), links._decorateStateSignature(after));
  assert.notEqual(links._decorateStateSignature(before), links._decorateStateSignature({
    messages: [{ role: 'user' }, { role: 'assistant', completedAt: 140 }],
  }));
  assert.equal(links._decorateStateSignature(after), links._decorateStateSignature({
    messages: [{ role: 'user', sentAt: 100 }, { role: 'assistant', text: '不同回复' }],
  }));
  assert.notEqual(links._decorateStateSignature({ ...after, history: { messageIndices: [0, 1] } }),
    links._decorateStateSignature({ ...after, history: { messageIndices: [10, 11] } }));
});

test('cards: settled window slides cannot carry a draft onto a different reply with the same local index', () => {
  const { root, snapshot } = conversation();
  snapshot.history = { messageIndices: [0, 1, 2, 3, 4] };
  const files = [manifest('name:sales-qa', { at: 130 })];
  links.pluginDrafts(root, files, 'ref-1', snapshot);
  const card = root.querySelector('.nplugin-draft');
  assert.equal(card.dataset.pluginDraftOwner, '2');
  // The old absolute reply 2 was evicted; local reply 2 is now absolute 12.
  // Undated restored history cannot reattribute the file by wall-clock time.
  snapshot.messages.forEach(item => { delete item.sentAt; delete item.completedAt; });
  snapshot.history.messageIndices = [10, 11, 12, 13, 14];
  root.querySelectorAll('[data-open-app]').forEach(node => node.remove());
  links.pluginDrafts(root, files, 'ref-1', snapshot);
  assert.equal(root.querySelector('.nplugin-draft').parent, root);
  assert.equal(root.querySelector('.nplugin-draft').dataset.pluginDraftHistorical, 'true');
});

test('cards: streaming carry rejects a reused local reply key after the snapshot window slides', () => {
  const { root, snapshot } = conversation();
  snapshot.history = { messageIndices: [0, 1, 2, 3, 4] };
  const files = [manifest('name:sales-qa', { at: 130 })];
  links.pluginDrafts(root, files, 'ref-1', snapshot);
  root.querySelectorAll('.nmsg.ai').forEach(node => { node.dataset.deliveryCurrent = 'false'; });
  const carry = require('../components/panels/chat-decorate-carry');
  const captured = carry.capture(root);
  const rebuilt = conversation();
  rebuilt.root.querySelectorAll('.nmsg.ai').forEach(node => { node.dataset.deliveryCurrent = 'false'; });
  carry.reconcile(rebuilt.root, files, captured, { ...snapshot, history: { messageIndices: [10, 11, 12, 13, 14] } });
  assert.equal(rebuilt.root.querySelectorAll('.nplugin-draft').length, 0);
  carry.reconcile(rebuilt.root, files, captured, snapshot);
  assert.equal(rebuilt.root.querySelectorAll('.nplugin-draft').length, 1, 'same absolute owner survives a rebuild');
});

test('cards: actual desktop script order without require enforces streaming ownership', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const client = path.resolve(__dirname, '..');
  const desktop = fs.readFileSync(path.join(client, 'desk.html'), 'utf8');
  const scripts = [...desktop.matchAll(/<script src="(components\/panels\/chat-(?:dom-patch|decorate-carry|plugin-draft-placement|output-links)\.js)"><\/script>/g)]
    .map(match => match[1]);
  assert.equal(scripts.length, 4);
  const context = vm.createContext({ window: {} });
  for (const file of scripts) vm.runInContext(fs.readFileSync(path.join(client, file), 'utf8'), context);
  const { root, snapshot } = conversation();
  snapshot.history = { messageIndices: [0, 1, 2, 3, 4] };
  const files = [manifest('name:sales-qa', { at: 130 })];
  context.window.ChatOutputLinks.pluginDrafts(root, files, 'ref-1', snapshot);
  root.querySelectorAll('.nmsg.ai').forEach(node => { node.dataset.deliveryCurrent = 'false'; });
  const carry = context.window.ChatDecorateCarry, captured = carry.capture(root);
  const rebuilt = conversation();
  rebuilt.root.querySelectorAll('.nmsg.ai').forEach(node => { node.dataset.deliveryCurrent = 'false'; });
  const shifted = { ...snapshot, history: { messageIndices: [10, 11, 12, 13, 14] } };
  carry.reconcile(rebuilt.root, files, captured, shifted);
  assert.equal(rebuilt.root.querySelectorAll('.nplugin-draft').length, 0, 'later-loaded placement must reject the old absolute owner');
  carry.reconcile(rebuilt.root, files, captured, snapshot);
  assert.equal(rebuilt.root.querySelectorAll('.nplugin-draft').length, 1);
  carry.reconcile(rebuilt.root, files, new Map(), shifted);
  assert.equal(rebuilt.root.querySelectorAll('.nplugin-draft').length, 0, 'in-place stale cards must also be removed');
});
