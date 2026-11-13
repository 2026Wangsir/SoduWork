'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function events() {
  const listeners = new Map();
  return {
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    dispatchEvent(event) { for (const handler of listeners.get(event.type) || []) handler(event); },
    count(name) { return listeners.get(name)?.size || 0; },
  };
}
function element() {
  return { ...events(), nodeType: 1, isConnected: true, style: {}, value: '', selectionStart: 0,
    scrollHeight: 96, children: [], setAttribute() {}, focus() {}, remove() {},
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; }, contains(target) { return target === this; } };
}
function fixture(directory = async () => ({ mates: [] })) {
  const input = element(), host = element(), parent = element(), frames = new Map(), observers = [];
  let reads = 0, frameId = 0;
  const rect = { left: 480, top: 400, bottom: 550, width: 800 };
  host.parentElement = parent;
  host.getBoundingClientRect = () => { reads++; return rect; };
  const context = { ...events(), innerWidth: 1440, innerHeight: 860,
    document: { ...events(), createElement: element },
    visualViewport: { ...events(), width: 1440, height: 860, offsetLeft: 0, offsetTop: 0 },
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
      observe(target) { this.targets.add(target); }
      disconnect() { this.targets.clear(); }
    },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/chat-mate-mention.js'), 'utf8'), context);
  const picker = context.ChatMateMention.create({ input, host, mates: directory });
  return { context, picker, input, host, parent, rect, frames, observers, menu: host.children[0], reads: () => reads,
    async open() { input.value = '@'; input.selectionStart = 1; input.dispatchEvent({ type: 'input' }); await Promise.resolve(); },
    close() { input.value = ''; input.dispatchEvent({ type: 'input' }); },
    flush() { const tasks = [...frames.values()]; frames.clear(); tasks.forEach(callback => callback()); } };
}
function contained(f) {
  const s = f.menu.style, v = f.context.visualViewport;
  assert.ok(parseFloat(s.left) >= v.offsetLeft + 8);
  assert.ok(parseFloat(s.left) + parseFloat(s.width) <= v.offsetLeft + v.width - 8);
  assert.ok(parseFloat(s.top) >= v.offsetTop + 8);
  assert.ok(parseFloat(s.top) + parseFloat(s.maxHeight) <= v.offsetTop + v.height - 8);
}
function released(f) {
  assert.equal(f.context.count('resize'), 0);
  assert.equal(f.context.count('scroll'), 0);
  assert.equal(f.context.visualViewport.count('resize'), 0);
  assert.equal(f.context.visualViewport.count('scroll'), 0);
  assert.equal(f.observers.filter(observer => observer.targets.size).length, 0);
  assert.equal(f.frames.size, 0);
}

test('teammate menus align above the composer, including short loading and empty states', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  await f.open();
  assert.equal(f.menu.style.left, '480px');
  assert.equal(f.menu.style.top, '294px');
  assert.equal(f.menu.style.width, '410px');
  assert.equal(f.menu.style.bottom, 'auto');
  assert.equal(f.menu.hidden, false);
  resolve({ mates: [] }); await new Promise(setImmediate);
  assert.equal(f.menu.style.left, '480px'); contained(f);
});

test('centering and popup content changes update through observed ancestors and menu', async () => {
  const f = fixture(); await f.open();
  const observer = f.observers[0];
  assert.ok(observer.targets.has(f.host));
  assert.ok(observer.targets.has(f.parent));
  assert.ok(observer.targets.has(f.menu));
  f.rect.left = 525; f.menu.scrollHeight = 740;
  observer.callback([]); f.flush();
  assert.equal(f.menu.style.left, '525px');
  assert.equal(f.menu.style.maxHeight, '330px');
  assert.equal(f.menu.style.top, '62px');
});

test('narrow visual viewports constrain the popup and top-edge composers can open below', async () => {
  const f = fixture(); await f.open();
  Object.assign(f.rect, { left: 120, top: 265, bottom: 350, width: 600 });
  Object.assign(f.context.visualViewport, { offsetLeft: 100, offsetTop: 240, width: 390, height: 300 });
  f.context.visualViewport.dispatchEvent({ type: 'resize' }); f.flush();
  contained(f); assert.equal(f.menu.style.top, '358px');
  Object.assign(f.rect, { top: 240, bottom: 540 });
  f.menu.scrollHeight = 740;
  f.context.visualViewport.dispatchEvent({ type: 'scroll' }); f.flush();
  contained(f); assert.ok(parseFloat(f.menu.style.maxHeight) > 0);
});

test('position events are coalesced and closing repeatedly releases every observer', async () => {
  const f = fixture();
  for (let round = 0; round < 20; round++) {
    await f.open();
    assert.equal(f.context.count('resize'), 1);
    assert.equal(f.context.visualViewport.count('resize'), 1);
    const before = f.reads();
    for (let index = 0; index < 40; index++) f.context.dispatchEvent({ type: 'resize' });
    assert.equal(f.frames.size, 1); assert.equal(f.reads(), before);
    f.flush(); assert.equal(f.reads(), before + 1);
    f.context.dispatchEvent({ type: 'scroll', target: f.menu });
    assert.equal(f.frames.size, 0);
    f.context.dispatchEvent({ type: 'scroll', target: f.parent });
    assert.equal(f.frames.size, 1);
    f.close(); released(f);
  }
});

test('escape, outside clicks, account changes and destruction release positioning', async () => {
  for (const close of [
    f => f.input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} }),
    f => f.context.document.dispatchEvent({ type: 'mousedown', target: { closest: () => null } }),
    f => f.context.dispatchEvent({ type: 'soduwork-data-scope-changed' }),
    f => f.picker.destroy(),
  ]) {
    const f = fixture(); await f.open(); f.context.dispatchEvent({ type: 'resize' }); close(f);
    assert.equal(f.menu.hidden, true); released(f);
  }
});

test('late directory results cannot reopen a detached or destroyed picker', async () => {
  for (const retire of [f => { f.host.isConnected = false; }, f => f.picker.destroy()]) {
    let resolve;
    const f = fixture(() => new Promise(done => { resolve = done; }));
    await f.open(); retire(f); resolve({ mates: [] }); await new Promise(setImmediate);
    assert.equal(f.menu.hidden, true); released(f);
  }
});
