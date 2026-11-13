'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const shape = require('../main/overlay-shape');
const main = fs.readFileSync(path.join(__dirname, '../main/desktop-overlay.cjs'), 'utf8');
const applyAndPark = main.slice(main.indexOf('function applyOverlayShape('), main.indexOf('function setOverlayIdleInput()'));
const sync = main.slice(main.indexOf('function _syncOverlayInputNow('), main.indexOf('function _startOverlayInputGuard('));

test('native region dedup keeps show/reload recovery and failed-apply retries working', () => {
  const calls = [];
  let fail = false;
  const scope = { _overlayShape:shape, _overlayShapeEnabled:false, _appliedOverlayShape:[], NATIVE_SHAPE:true,
    _overlayShapeRevision:0, _overlayAwaitingShape:false, _overlayShapeReported:false, _lastOverlayRects:[],
    _overlayContentSize:()=>({width:1920,height:1080}), _startOverlayInputGuard(){}, _syncOverlayInputNow(){},
    _setOverlayInputIgnored(){},console:{error(){}},
    mainWindow:{isDestroyed:()=>false,setShape(rects){calls.push(rects);if(fail)throw Error('native failure');}} };
  vm.createContext(scope);vm.runInContext(applyAndPark,scope);
  const rects = [{x:1800,y:200,width:42,height:205}];
  assert.equal(scope.applyOverlayShape(rects),true);
  for(let i=0;i<100;i++) scope.applyOverlayShape(rects);
  assert.equal(calls.length,1);
  scope.applyOverlayShape(rects,false);assert.equal(calls.length,2,'show must restore even identical geometry');
  scope.applyOverlayShape([],false);assert.equal(calls.length,3,'reload must park immediately');
  scope.applyOverlayShape(rects);assert.equal(calls.length,4,'renderer must restore after parking');
  fail=true;assert.equal(scope.applyOverlayShape([],false),false);
  fail=false;assert.equal(scope.applyOverlayShape(rects),true);assert.equal(calls.length,6);
  assert.equal(scope._overlayShapeEnabled,true);
  scope._overlayAwaitingShape = true;
  scope.parkOverlayShape(true);assert.equal(calls.length,7);
  assert.equal(scope._overlayShapeRevision,1,'invalidating park rejects acknowledgements from the old revision');
  assert.equal(scope._overlayAwaitingShape,false);
});

/*
 * Test dynamic macOS passthrough using global cursor checks without native shape clipping.
 */
test('dynamic passthrough accepts regions without setShape and parks on reload', () => {
  const syncs = [];
  const scope = { _overlayShape:shape, _overlayShapeEnabled:false, _appliedOverlayShape:[],
    _overlayInputRects:[], _lastOverlayRects:[], NATIVE_SHAPE:false,
    _overlayShapeRevision:0, _overlayAwaitingShape:false, _overlayShapeReported:false,
    _overlayContentSize:()=>({width:1920,height:1080}),
    _startOverlayInputGuard(){ scope.guardStarted=true; },
    _syncOverlayInputNow(){ syncs.push(scope._overlayInputRects.slice()); },
    _setOverlayInputIgnored(){}, console:{error(){}},
    /* Omit setShape deliberately; the dynamic path must not call it. */
    mainWindow:{ isDestroyed:()=>false } };
  vm.createContext(scope); vm.runInContext(applyAndPark, scope);
  const pet = { x:1800, y:900, width:72, height:132 };
  const dock = { x:1880, y:300, width:36, height:500 };
  assert.equal(scope.applyOverlayShape([pet, dock]), true, 'mac 没有 setShape 也必须接受组件区域');
  assert.equal(scope._overlayShapeEnabled, true);
  assert.deepEqual(scope._overlayInputRects, [pet, dock]);
  assert.deepEqual(scope._lastOverlayRects, [pet, dock]);
  assert.deepEqual(scope._appliedOverlayShape, [], 'mac 没有原生裁剪，applied 必须保持为空');
  assert.equal(scope.guardStarted, true, '动态模式必须启动输入守卫');
  assert.deepEqual(syncs, [[pet, dock]]);
  scope.parkOverlayShape();
  assert.deepEqual(scope._overlayInputRects, []);
  assert.deepEqual(syncs[syncs.length-1], []);
});

test('dynamic input guard accepts the cursor inside any component and ignores elsewhere', () => {
  const cursor = { x:10, y:10 };
  const scope = { _overlayShape:shape, _emergencyMode:false, _overlayAwaitingShape:false, _overlayShapeEnabled:true,
    _overlayInputRects:[], NATIVE_SHAPE:false,
    screen:{ getCursorScreenPoint:()=>cursor },
    _isPointOverWorkWindow:()=>false,
    mainWindow:{ isDestroyed:()=>false, isVisible:()=>true, getContentBounds:()=>({x:0,y:0,width:1920,height:1080}) },
    _setOverlayInputIgnored(ignore){ scope.decisions.push(ignore); } };
  scope.decisions = [];
  vm.createContext(scope); vm.runInContext(sync, scope);
  const pet = { x:1800, y:900, width:72, height:132 };
  const dock = { x:1880, y:300, width:36, height:500 };
  scope._overlayInputRects = [pet, dock];
  scope._syncOverlayInputNow();
  assert.deepEqual(scope.decisions, [true], '光标不在任何组件内必须穿透');
  cursor.x = 1805; cursor.y = 905;
  scope._syncOverlayInputNow();
  assert.deepEqual(scope.decisions, [true, false], '光标在桌宠内必须收输入');
  cursor.x = 1890; cursor.y = 400;
  scope._syncOverlayInputNow();
  assert.deepEqual(scope.decisions, [true, false, false], '光标在竖条内必须收输入（多矩形一样判）');
  cursor.x = 960; cursor.y = 540;
  scope._syncOverlayInputNow();
  assert.deepEqual(scope.decisions, [true, false, false, true], '离开全部组件必须恢复穿透');
  scope._overlayAwaitingShape = true;
  cursor.x = 1805; cursor.y = 905;
  scope._syncOverlayInputNow();
  assert.deepEqual(scope.decisions, [true, false, false, true, true],
    '等待当前 revision 确认时，即使光标在组件内也必须穿透');
});

test('native platforms guard transparent gaps without disabling visible components', () => {
  const decisions = [];
  let cursor = { x: 10, y: 10 };
  const scope = { _overlayShape:shape, _emergencyMode:false, _overlayShapeEnabled:true,
    _overlayAwaitingShape:false,
    _overlayInputRects:[{x:1800,y:900,width:72,height:132},{x:1880,y:300,width:36,height:500}],
    NATIVE_SHAPE:true,
    screen:{ getCursorScreenPoint:()=>cursor },
    _isPointOverWorkWindow:()=>false,
    mainWindow:{ isDestroyed:()=>false, isVisible:()=>true, getContentBounds:()=>({x:0,y:0,width:1920,height:1080}) },
    _setOverlayInputIgnored(ignore){ decisions.push(ignore); } };
  vm.createContext(scope); vm.runInContext(sync, scope);
  scope._syncOverlayInputNow();
  assert.deepEqual(decisions, [true], 'native clipping must not leave multi-widget transparent gaps active');
  cursor = { x: 1805, y: 905 };
  scope._syncOverlayInputNow();
  assert.deepEqual(decisions, [true, false], 'visible pet remains interactive');
  scope._overlayAwaitingShape = true;
  scope._syncOverlayInputNow();
  assert.deepEqual(decisions, [true, false, true], '等待当前 revision 确认时必须保持原生穿透');
});
