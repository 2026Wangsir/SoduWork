'use strict';

/*
 * Simulate real overlay drag code with representative geometry. Assert complete element
 * coverage, no full-window region, bounded IPC updates, and precise shape restoration on
 * release.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEW_W = 2560, VIEW_H = 1440;

function makeEl(id, x, y, w, h) {
  return {
    id,
    _x: x, _y: y, _w: w, _h: h,
    classList: { contains: () => false },
    getBoundingClientRect() {
      return { left: this._x, top: this._y, right: this._x + this._w, bottom: this._y + this._h,
               width: this._w, height: this._h, x: this._x, y: this._y };
    },
  };
}

function boot(bridge = {}) {
  const shapeCalls = [];               // Record each applied region snapshot.
  let rafQ = [];
  const sandbox = {
    console,
    Date, Math, Number, Array, Set, Map, JSON, String, Object, Promise,
    setTimeout, clearTimeout,
    requestAnimationFrame: (cb) => { rafQ.push(cb); return rafQ.length; },
    cancelAnimationFrame: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class {},
  };
  const dock = makeEl('edgeDock', VIEW_W - 40, 400, 36, 500);
  const pet = makeEl('pet', VIEW_W - 100, VIEW_H - 100, 72, 72);
  sandbox.document = {
    body: {},
    readyState: 'complete',
    getElementById: (id) => (id === 'pet' ? pet : null),
    querySelector: (sel) => (sel === '.edge-dock.show' ? dock : null),
    querySelectorAll: (sel) => (sel === '.edge-dock' ? [dock] : []),
    addEventListener: () => {},
  };
  sandbox.soduWorkAPI = {
    setOverlayShape: (rects) => shapeCalls.push(rects.map((r) => ({ ...r }))),
    setIgnoreMouseEvents: () => {},
    setAlwaysOnTop: () => {},
    ...bridge,
  };
  sandbox.window = sandbox;
  sandbox.innerWidth = VIEW_W;
  sandbox.innerHeight = VIEW_H;
  sandbox.addEventListener = () => {};
  sandbox.dispatchEvent = () => {};
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'electron.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'core/electron.js' });
  const frame = () => { const q = rafQ; rafQ = []; for (const cb of q) cb(); };
  return { sandbox, shapeCalls, frame, dock, pet };
}

const contains = (rects, el) => rects.some((r) =>
  el._x >= r.x && el._y >= r.y &&
  el._x + el._w <= r.x + r.width && el._y + el._h <= r.y + r.height);
const fullWindow = (r) => r.width >= VIEW_W && r.height >= VIEW_H;

test('拖动全程：不裁切、不整窗、IPC 个位数，松手恢复精确形状', () => {
  const { sandbox, shapeCalls, frame, dock } = boot();
  frame();                                       // Flush the initial queued shape update.
  assert.ok(shapeCalls.length >= 1, '启动要报一次初始形状');
  assert.ok(contains(shapeCalls.at(-1), dock), '初始形状要含竖条');

  sandbox.window.beginOverlayDrag();
  frame();                                       // Create the first padded drag region.
  const dragStartCalls = shapeCalls.length;
  assert.ok(contains(shapeCalls.at(-1), dock), '方块必须含竖条');

  // Simulate a 600px diagonal drag at 8px per frame and 60fps.
  for (let i = 0; i < 75; i++) {
    dock._x -= 8; dock._y += 2;
    sandbox.window.requestOverlayShapeSync(0);   // Invoke the path normally triggered by MutationObserver.
    frame();
    const applied = shapeCalls.at(-1);
    assert.ok(contains(applied, dock), `第${i}帧竖条被裁出形状（②那条线回来了）`);
    for (const r of applied) assert.ok(!fullWindow(r), `第${i}帧出现整窗矩形（③整屏闪回来了）`);
  }
  const ipcDuringDrag = shapeCalls.length - dragStartCalls;
  assert.ok(ipcDuringDrag >= 1, '拖了 600px 至少要跳一次方块');
  assert.ok(ipcDuringDrag <= 10, `75 帧里 IPC 了 ${ipcDuringDrag} 次，回到①每帧重算了`);

  sandbox.window.endOverlayDrag();
  frame();
  const finalRects = shapeCalls.at(-1);
  assert.ok(contains(finalRects, dock), '松手后形状要含竖条');
  const dockRect = finalRects.find((r) => r.width < 36 + 40 && r.x <= dock._x && r.x + r.width >= dock._x + dock._w);
  assert.ok(dockRect, '松手后必须回到精确形状（小 pad），不能留着大方块');
});

test('静止时不产生多余 IPC；新元素在拖动中出现也会进形状', () => {
  const { sandbox, shapeCalls, frame } = boot();
  frame();
  const base = shapeCalls.length;
  for (let i = 0; i < 20; i++) { sandbox.window.requestOverlayShapeSync(0); frame(); }
  assert.equal(shapeCalls.length, base, '什么都没动，一次 IPC 都不该发');

  sandbox.window.beginOverlayDrag();
  frame();
  // Show a notification bubble during dragging.
  const bubble = makeEl('bubble', 900, 900, 200, 60);
  const origQS = sandbox.document.querySelector;
  sandbox.document.querySelector = (sel) => (sel === '.pet-bubble.show.undoable' ? bubble : origQS(sel));
  sandbox.window.requestOverlayShapeSync(0);
  frame();
  assert.ok(contains(shapeCalls.at(-1), bubble), '拖动中新出现的元素也要有形状（否则隐形）');
  sandbox.window.endOverlayDrag();
});

test('CSS 缩放和小数坐标抖动不逐帧重建原生区域，停止后恢复精确边界', () => {
  const { sandbox, shapeCalls, frame, pet } = boot();
  frame();
  const start = shapeCalls.length;
  for (let i = 0; i < 60; i++) {
    pet._x = VIEW_W - 100 + Math.sin(i) * .8;
    pet._w = 72 + Math.sin(i / 5) * 5;
    sandbox.window.requestOverlayShapeSync(500);
    frame();
    assert.ok(contains(shapeCalls.at(-1), pet), '动画每一帧都必须留在原生可见区域内');
    assert.ok(shapeCalls.at(-1).every(r => !fullWindow(r)), '不能把整张透明合成面暴露出来');
  }
  assert.ok(shapeCalls.length - start <= 3, '60 帧小幅动画最多调整三次区域，实际 ' + (shapeCalls.length - start));
  sandbox._syncOverlayShape(true);
  const r = shapeCalls.at(-1).find(rect => rect.x < pet._x && rect.width < 120);
  assert.equal(r.x, Math.floor(pet._x - 6));
  assert.equal(r.width, Math.ceil(pet._x + pet._w + 6) - r.x);
  const settled = shapeCalls.length;
  for (let i = 0; i < 20; i++) sandbox._syncOverlayShape(true);
  assert.equal(shapeCalls.length, settled);
  sandbox.window.requestOverlayShapeSync(0, true); frame();
  assert.equal(shapeCalls.length, settled + 1, '失焦停放后的强制上报不能被去重吞掉');
});

test('removed overlay panels release both mutation and resize observation targets', () => {
  const { sandbox } = boot();
  const mutations = new Set(), sizes = new Set(); let ephemeral = null;
  sandbox._mo = { observe: el => mutations.add(el), disconnect: () => mutations.clear() };
  sandbox._shapeRO = { observe: el => sizes.add(el), unobserve: el => sizes.delete(el) };
  sandbox._observedInteractive = new Set();
  const original = sandbox.document.querySelectorAll;
  sandbox.document.querySelectorAll = selector => selector === '.panel' ? (ephemeral ? [ephemeral] : []) : original(selector);
  sandbox._observeInteractive();
  const baseline = { mutations: mutations.size, sizes: sizes.size };
  for (let i = 0; i < 1000; i++) {
    ephemeral = { id: 'removed-panel-' + i }; sandbox._observeInteractive();
    assert.equal(sizes.size, baseline.sizes + 1);
    ephemeral = null; sandbox._observeInteractive();
    assert.equal(sizes.size, baseline.sizes); assert.equal(mutations.size, baseline.mutations);
  }
});

test('late startup revision query resends unchanged geometry for the current navigation', async () => {
  let resolveQuery;
  const { shapeCalls, frame } = boot({ getOverlayShape: () => new Promise(resolve => { resolveQuery = resolve; }) });
  frame();
  const initial = shapeCalls.at(-1);
  const count = shapeCalls.length;
  resolveQuery({ supported: true, revision: 5, awaitingShape: true });
  await Promise.resolve();
  frame();
  assert.equal(shapeCalls.length, count + 1, 'geometry dedup must not suppress the new revision acknowledgement');
  assert.deepEqual(shapeCalls.at(-1), initial, 'a new revision must not enlarge visible native regions');
});

test('closed pet ring cannot intercept the chat editor beneath its invisible buttons', () => {
  const { sandbox, frame, shapeCalls, pet } = boot();
  const ring = makeEl('ring-action', 600, 600, 36, 36);
  let opened = false;
  pet.classList.contains = name => name === 'ring-open' && opened;
  const query = sandbox.document.querySelectorAll;
  sandbox.document.querySelectorAll = selector => selector === '.ring-btn' ? [ring]
    : selector === '.pet.ring-open .ring-btn' ? (opened ? [ring] : []) : query(selector);
  const refresh = () => { sandbox.requestOverlayShapeSync(0, true); frame(); };
  refresh();
  assert.equal(contains(shapeCalls.at(-1), ring), false, 'closed ring geometry must be excluded from native hit regions');
  assert.equal(sandbox.isPointInteractive(615, 615), false);
  opened = true; refresh();
  assert.equal(contains(shapeCalls.at(-1), ring), true, 'open ring actions remain usable');
  assert.equal(sandbox.isPointInteractive(615, 615), true);
  opened = false; refresh();
  assert.equal(contains(shapeCalls.at(-1), ring), false, 'closing restores passthrough without moving the pet');
  assert.equal(sandbox.isPointInteractive(615, 615), false);
});
