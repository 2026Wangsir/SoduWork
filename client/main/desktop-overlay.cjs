'use strict';

const path = require('node:path');
const _overlayShape = require('./overlay-shape');

/*
 * Use native shape clipping only on supported platforms. Where setShape is ineffective, a
 * main-process cursor guard controls full-screen passthrough from component rectangles.
 */
const NATIVE_SHAPE = process.platform === 'win32' || process.platform === 'linux';

// Owns only the desktop pet/dock overlay. Work windows remain independent.
function create({ app, BrowserWindow, ipcMain, screen, globalShortcut, Notification,
  powerMonitor, getRendererRoot: rendererRoot, getIcon: _appIcon, translate: _nativeText,
  getWorkWindows = () => [], timers = globalThis, now = Date.now }) {
  const setTimeout = timers.setTimeout.bind(timers), clearTimeout = timers.clearTimeout.bind(timers);
  const setInterval = timers.setInterval.bind(timers), clearInterval = timers.clearInterval.bind(timers);
  let mainWindow = null;

  let _started = false;
  let _disposed = false;
  let _navigationId = 0;
  const _pendingTimeouts = new Set();
  const _windowDisposers = [];
  const _lifecycleDisposers = [];
  const _ipcDisposers = [];

  function isCurrent(win) {
    return !_disposed && !!win && mainWindow === win && !win.isDestroyed();
  }
  function later(callback, delay, owner = mainWindow) {
    if (!isCurrent(owner)) return null;
    const timer = setTimeout(() => {
      _pendingTimeouts.delete(timer);
      if (isCurrent(owner)) callback();
    }, delay);
    _pendingTimeouts.add(timer);
    return timer;
  }
  function resetRendererHealth() {
    _lastHeartbeat = now();
    _heartbeatMisses = 0;
    _rendererUnresponsive = false;
    if (_unresponsiveTimer) { clearTimeout(_unresponsiveTimer); _unresponsiveTimer = null; }
  }
  function releaseWindowResources() {
    for (const dispose of _windowDisposers.splice(0)) dispose();
    for (const timer of _pendingTimeouts) clearTimeout(timer);
    _pendingTimeouts.clear();
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
    if (_readyTimer) { clearTimeout(_readyTimer); _readyTimer = null; }
    if (_unresponsiveTimer) { clearTimeout(_unresponsiveTimer); _unresponsiveTimer = null; }
    if (_overlayInputGuardTimer) { clearInterval(_overlayInputGuardTimer); _overlayInputGuardTimer = null; }
  }
  function reload() {
    if (!isCurrent(mainWindow)) return;
    if (_emergencyMode) { recoverFromEmergency(); return; }
    _setOverlayInputIgnored(true);
    _rendererReady = false;
    resetRendererHealth();
    mainWindow.reload();
    startHeartbeatWatchdog();
  }
  function start() {
    if (_started || _disposed) return;
    _started = true;
    const focusChanged = (_event, win) => {
      if (!mainWindow) return;
      if (win === mainWindow) {
        setWorkWindowFocused(false);
        return;
      }
      setWorkWindowFocused(true);
      notifyOverlayBlur();
    };
    app.on('browser-window-focus', focusChanged);
    _lifecycleDisposers.push(() => app.removeListener('browser-window-focus', focusChanged));
    const blurChanged = (_event, win) => {
      /* Overlay blur is an intentional passthrough transition, not a work-window hand-off. */
      if (win && win === mainWindow) return;
      /*
       * A work window can lose focus to another application without a corresponding
       * browser-window-focus event. Restore the desktop layer in that case, while leaving
       * it underneath another SoduWork window during an internal focus hand-off.
       */
      const focused = typeof BrowserWindow.getFocusedWindow === 'function'
        ? BrowserWindow.getFocusedWindow() : null;
      if (focused && focused !== mainWindow) return;
      setWorkWindowFocused(false);
    };
    app.on('browser-window-blur', blurChanged);
    _lifecycleDisposers.push(() => app.removeListener('browser-window-blur', blurChanged));
    if (powerMonitor && typeof powerMonitor.on === 'function') {
      for (const event of ['suspend', 'resume']) {
        powerMonitor.on(event, resetRendererHealth);
        _lifecycleDisposers.push(() => powerMonitor.removeListener(event, resetRendererHealth));
      }
    }
    registerEmergencyShortcut();
  }
  function dispose() {
    if (_disposed) return;
    _setOverlayInputIgnored(true);
    _disposed = true;
    releaseWindowResources();
    for (const release of _lifecycleDisposers.splice(0)) release();
    for (const release of _ipcDisposers.splice(0)) release();
    app.removeListener('will-quit', dispose);
  }
  function onIpc(channel, listener) {
    ipcMain.on(channel, listener);
    _ipcDisposers.push(() => ipcMain.removeListener(channel, listener));
  }
  function handleIpc(channel, listener) {
    ipcMain.handle(channel, listener);
    _ipcDisposers.push(() => ipcMain.removeHandler(channel));
  }
  let _lastOverlayRects = [];
  let _appliedOverlayShape = [];
  let _overlayShapeEnabled = false;
  let _overlayShapeReported = false;
  let _overlayShapeRevision = 0;
  let _overlayAwaitingShape = true;
  let _overlayInputRects = [];
  let _overlayInputIgnored = null;
  let _overlayInputGuardTimer = null;
  let _initialPaintReady = false;
  let _initialRevealPending = true;

  /*
   * Clip unused compositor regions at the native window boundary to prevent stale
   * layered-window pixels from appearing over the desktop.
   */
  function _overlayContentSize() {
    if (!mainWindow || mainWindow.isDestroyed()) return { width: 1, height: 1 };
    const b = mainWindow.getContentBounds();
    return { width: b.width, height: b.height };
  }

  function _setOverlayInputIgnored(ignore) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const next = !!ignore;
    if (_overlayInputIgnored === next) return;
    try {
      // Windows' legacy forwarded WM_MOUSEMOVE path resets the native cursor
      // over other windows (Electron #48035) and can retain stale HWND hooks.
      // Our main-process guard already detects entry without renderer events.
      mainWindow.setIgnoreMouseEvents(next, next ? { forward: process.platform !== 'win32' } : undefined);
      // Publish the transition before changing focus.  Electron may emit the
      // blur callback synchronously when a passive overlay is parked; the
      // callback must see the new state instead of recursively entering here.
      _overlayInputIgnored = next;
      /*
         `setIgnoreMouseEvents(true)` only changes hit testing.  On Windows a
         transparent always-on-top overlay can still remain the native
         keyboard target after the pointer has been forwarded to a work
         window.  That leaves a child WebContentsView looking focused while
         real key input is delivered to the desktop overlay.  Park the
         overlay out of the focus chain whenever it is passive; make it
         focusable again only while the cursor is inside one of its own
         interactive regions.
      */
      if (typeof mainWindow.setFocusable === 'function') {
        mainWindow.setFocusable(!next);
      }
      if (next && typeof mainWindow.blur === 'function') mainWindow.blur();
    } catch (e) {
      _overlayInputIgnored = null;
      console.error('[overlay] 鼠标穿透切换失败:', e && e.message || e);
    }
  }

  /*
   * Supplement native clipping with a main-process cursor guard for problematic
   * layered-window hit-testing. Without native shape support, the guard is the input
   * boundary for all component rectangles.
   */
  function _syncOverlayInputNow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (_emergencyMode || _overlayAwaitingShape || !_overlayShapeEnabled || !mainWindow.isVisible() || !_overlayInputRects.length) {
      _setOverlayInputIgnored(true);
      return;
    }
    // Native clipping limits painting, but multi-widget layered windows can still
    // retain keyboard focus or intercept transparent gaps. Guard every shape.
    try {
      const point = screen.getCursorScreenPoint();
      const bounds = mainWindow.getContentBounds();
      /*
       * The desktop overlay is a full-screen transparent window. If a normal SoduWork
       * window is under the cursor, its controls must win even when the pet or dock happens
       * to overlap that point. This closes the first-click race before the work window emits
       * its native focus event and applies on Windows, Linux and macOS alike.
       */
      if (_isPointOverWorkWindow(point)) {
        _setOverlayInputIgnored(true);
        return;
      }
      const inside = _overlayShape.containsPoint(
        _overlayInputRects, point.x - bounds.x, point.y - bounds.y);
      _setOverlayInputIgnored(!inside);
    } catch (e) {
      /* Enable passthrough when global cursor position is unavailable rather than blocking other applications. */
      _setOverlayInputIgnored(true);
    }
  }

  function _isPointOverWorkWindow(point) {
    let windows = [];
    try { windows = getWorkWindows() || []; } catch (_) { return false; }
    return windows.some((win) => {
      if (!win || win === mainWindow || typeof win.isDestroyed !== 'function' || win.isDestroyed()) return false;
      if (typeof win.isVisible === 'function' && !win.isVisible()) return false;
      if (typeof win.isMinimized === 'function' && win.isMinimized()) return false;
      let bounds;
      try { bounds = typeof win.getBounds === 'function' ? win.getBounds() : win.getContentBounds?.(); }
      catch (_) { return false; }
      return !!bounds && point.x >= bounds.x && point.y >= bounds.y &&
        point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height;
    });
  }

  function _startOverlayInputGuard() {
    if (_overlayInputGuardTimer) return;
    _overlayInputGuardTimer = setInterval(() => {
      _syncOverlayInputNow();
    }, 40);
    if (typeof _overlayInputGuardTimer.unref === 'function') _overlayInputGuardTimer.unref();
  }

  function applyOverlayShape(rects, remember = true) {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const bounds = _overlayContentSize();
    const normalized = _overlayShape.normalize(rects, bounds);
    if (!NATIVE_SHAPE) {
      /*
       * Dynamic passthrough stores component rectangles without applying a native shape. Report
       * successful region activation while keeping _appliedOverlayShape empty.
       */
      _overlayShapeEnabled = true;
      if (remember) _lastOverlayRects = normalized;
      _overlayInputRects = normalized;
      _startOverlayInputGuard();
      _syncOverlayInputNow();
      return true;
    }
    if (typeof mainWindow.setShape !== 'function') return false;
    const applied = _overlayShape.resolve(normalized, bounds);
    try {
      // Lifecycle restores (remember=false) must reapply after show. Normal
      // renderer notifications need no native repaint when the region is unchanged.
      if (!remember || !_overlayShapeEnabled || !_overlayShape.equal(applied, _appliedOverlayShape)) {
        mainWindow.setShape(applied);
      }
      _overlayShapeEnabled = true;
      if (remember) _lastOverlayRects = normalized;
      _appliedOverlayShape = applied;
      _overlayInputRects = normalized;
      _startOverlayInputGuard();
      _syncOverlayInputNow();
      return true;
    } catch (e) {
      _overlayShapeEnabled = false;
      _overlayInputRects = [];
      _setOverlayInputIgnored(true);
      console.error('[overlay] 原生区域裁剪失败:', e && e.message || e);
      return false;
    }
  }

  function parkOverlayShape(invalidate = false) {
    if (invalidate) _overlayShapeRevision++;
    _overlayAwaitingShape = false;
    _lastOverlayRects = [];
    _overlayShapeReported = false;
    applyOverlayShape([], false);
  }

  function setOverlayIdleInput() {
    _syncOverlayInputNow();
  }

  function notifyOverlayBlur() {
    if (!isCurrent(mainWindow) || _emergencyMode || _overlayAwaitingShape) return;
    // Keep the visible regions intact, but release input until the renderer has
    // dismissed transient panels and acknowledged this exact geometry revision.
    // Publish the pending state first: setFocusable/blur can synchronously reenter.
    _overlayAwaitingShape = true;
    _overlayShapeRevision++;
    _setOverlayInputIgnored(true);
    try { mainWindow.webContents.send('overlay-window-blur', _overlayShapeRevision); } catch (_e) { /* Application shutdown is in progress. */ }
  }






  let _overlayHiddenByWorkspace = false;
  let _workWindowFocused = false;
  function _setOverlayTopmost(flag) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setAlwaysOnTop(_workWindowFocused ? false : !!flag, overlayTopLevel());
  }
  function setWorkWindowFocused(focused) {
    const next = !!focused;
    if (_workWindowFocused === next) return;
    _workWindowFocused = next;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (next) {
      /* Keep the workspace above the transparent desktop layer while it owns focus. */
      _setOverlayInputIgnored(true);
      _setOverlayTopmost(false);
    } else if (!_overlayHiddenByWorkspace && !_emergencyMode) {
      _setOverlayTopmost(true);
      _syncOverlayInputNow();
    }
  }
  function setWorkspaceMaximized(maximized) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (maximized) {
      if (mainWindow.isVisible() || _initialRevealPending) {
        _overlayHiddenByWorkspace = true;
        mainWindow.hide();
      }
      return;
    }
    if (!_overlayHiddenByWorkspace) return;
    _overlayHiddenByWorkspace = false;
    if (_emergencyMode) return;   // Emergency passthrough takes precedence; tray recovery owns restoration.
    if (_initialRevealPending) { revealInitialOverlay(); return; }
    mainWindow.showInactive();
    /* Reapply stacking and passthrough state after hide/show cycles. */
    _setOverlayTopmost(true);
    if (_overlayShapeEnabled && NATIVE_SHAPE && typeof mainWindow.setShape === 'function') {
      try { mainWindow.setShape(_appliedOverlayShape); } catch (_e) { /* The next renderer report can retry synchronization. */ }
    }
    if (_overlayShapeEnabled) _syncOverlayInputNow();
  }

  let _crashCount = 0;
  let _crashWindowStart = now();

  /*
   * Layered recovery mechanisms keep a frozen, crashed, or paused transparent renderer from
   * blocking the desktop. Main-process shortcuts, tray controls, and watchdogs provide
   * independent escape paths.
   */

  /* Watchdog state. */
  const HEARTBEAT_TIMEOUT_MS = 20000;   // Require a 20-second heartbeat lapse before secondary checks.
  const READY_TIMEOUT_MS = 15000;      // Allow 15 seconds for startup readiness.
  const HEARTBEAT_CHECK_INTERVAL = 2000; // Heartbeat check interval.
  const HEARTBEAT_MISSES_REQUIRED = 2; // Require consecutive unresponsive samples to tolerate temporary stalls.
  const UNRESPONSIVE_GRACE_MS = 15000; // Delay emergency protection until unresponsive state persists for 15 seconds.
  let _lastHeartbeat = 0;              // Last received heartbeat time.
  let _rendererReady = false;          // Whether the renderer reported readiness.
  let _heartbeatMisses = 0;             // Consecutive unresponsive samples.
  let _rendererUnresponsive = false;    // Health state from Electron responsive and unresponsive events.
  let _heartbeatTimer = null;          // Heartbeat timer.
  let _readyTimer = null;              // Startup readiness timer.
  let _unresponsiveTimer = null;       // Cancelable delayed-passthrough timer.
  let _emergencyMode = false;          // Emergency passthrough state.

  /*
   * Emergency recovery forces passthrough, hides the overlay, notifies through the main
   * process, and marks emergency state. Tray restoration restarts renderer readiness checks.
   */
  function emergencyPassthrough(reason) {
    if (isCurrent(mainWindow) && !_emergencyMode) {
      try {
        _emergencyMode = true;
        _overlayAwaitingShape = true;
        _overlayShapeRevision++;
        _lastOverlayRects = [];
        _overlayInputRects = [];
        _overlayShapeReported = false;
        // Force passthrough immediately.
        _setOverlayInputIgnored(true);
        // Hide the full-screen overlay.
        mainWindow.hide();
        console.error('[SAFETY] 紧急穿透已触发:', reason);

        // Notify independently of the renderer.
        try {
          if (Notification.isSupported()) {
            const n = new Notification({
              title: _nativeText('SoduWork 已紧急暂停'),
              body: _nativeText('原因：' + reason + '。点击托盘图标可恢复。'),
              silent: false
            });
            const owner = mainWindow;
            n.on('click', () => { if (isCurrent(owner)) recoverFromEmergency(); });
            n.show();
          }
        } catch (e) { /* Notification failure must not prevent recovery. */ }
      } catch (e) {
        console.error('[SAFETY] 紧急穿透执行失败:', e);
      }
    }
  }

  /*
   * Restore from emergency mode by showing and reloading the window, resetting state, and
   * restarting health checks.
   */
  function recoverFromEmergency(focus = true) {
    if (!isCurrent(mainWindow)) return;
    _emergencyMode = false;
    _rendererReady = false;
    resetRendererHealth();
    /*
     * Start a real navigation during recovery because an already-initialized page will not
     * send renderer-ready again. did-start-loading rearms the watchdog.
     */
    _setOverlayInputIgnored(true);
    mainWindow.reload();
    mainWindow.show();
    if (focus) mainWindow.focus();
    _setOverlayTopmost(true);
    startHeartbeatWatchdog();
  }

  /*
   * Register an OS-level emergency shortcut that remains available when the renderer is
   * frozen.
   */
  function registerEmergencyShortcut() {
    // Ctrl+Shift+X enables emergency passthrough.
    const ok = globalShortcut.register('CommandOrControl+Shift+X', () => {
      emergencyPassthrough('用户按下紧急快捷键 Ctrl+Shift+X');
    });
    if (!ok) {
      console.error('[SAFETY] 全局快捷键注册失败');
    }
    // Ctrl+Shift+R reloads the renderer as an alternate recovery action.
    const ok2 = globalShortcut.register('CommandOrControl+Shift+R', reload);
    if (ok) _lifecycleDisposers.push(() => globalShortcut.unregister('CommandOrControl+Shift+X'));
    if (ok2) _lifecycleDisposers.push(() => globalShortcut.unregister('CommandOrControl+Shift+R'));
    if (!ok2) {
      console.error('[SAFETY] 重载快捷键注册失败');
    }
  }

  /*
   * Check two-second heartbeats after readiness. Enter emergency passthrough only after a
   * prolonged lapse and consecutive Electron unresponsive checks; tolerate debugging and
   * temporary stalls.
   */
  function startHeartbeatWatchdog() {
    if (_heartbeatTimer) clearInterval(_heartbeatTimer);
    _lastHeartbeat = now();
    _heartbeatMisses = 0;
    _rendererUnresponsive = false;
    _heartbeatTimer = setInterval(() => {
      if (!_rendererReady) return; // Skip heartbeat checks before readiness.
      // Skip watchdog escalation while DevTools debugging may pause the renderer.
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isDevToolsOpened()) {
        _lastHeartbeat = now();
        _heartbeatMisses = 0;
        return;
      }
      const elapsed = now() - _lastHeartbeat;
      if (elapsed <= HEARTBEAT_TIMEOUT_MS) {
        _heartbeatMisses = 0;
        return;
      }
      // Track renderer health through Electron's responsive and unresponsive events.
      // Use recorded event state rather than querying unsupported APIs.
      if (!_rendererUnresponsive) {
        _heartbeatMisses = 0;
        return;
      }
      _heartbeatMisses++;
      if (_heartbeatMisses >= HEARTBEAT_MISSES_REQUIRED) {
        emergencyPassthrough('心跳超时 ' + Math.round(elapsed / 1000) + 's（渲染进程可能卡死）');
        if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
      }
    }, HEARTBEAT_CHECK_INTERVAL);
  }

  /*
   * Require renderer-ready within the startup timeout; otherwise enable emergency
   * passthrough.
   */
  function startReadyWatchdog() {
    if (_readyTimer) clearTimeout(_readyTimer);
    _rendererReady = false;
    _readyTimer = setTimeout(() => {
      if (!_rendererReady) {
        emergencyPassthrough('启动就绪超时（渲染进程可能启动失败）');
      }
    }, READY_TIMEOUT_MS);
  }









  function overlayTopLevel() {
    return process.platform === 'darwin' ? 'floating' : 'screen-saver';
  }

  function loadRenderer() { mainWindow.loadFile(path.join(rendererRoot(), 'index.html')); }

  function redrawOverlay() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) return;             // Preserve explicit user hiding.
    // Repaint the existing surface. Repeated hide/show and topmost changes
    // can invalidate desktop watermark layers on managed Windows computers.
    applyOverlayShape(_lastOverlayRects);
    mainWindow.webContents.invalidate?.();
    setOverlayIdleInput();
  }

  function revealInitialOverlay() {
    if (!isCurrent(mainWindow) || !_initialRevealPending || !_initialPaintReady ||
        !_rendererReady || !_overlayShapeReported || _overlayHiddenByWorkspace || _emergencyMode) return;
    _initialRevealPending = false;
    mainWindow.showInactive();
    setOverlayIdleInput();
  }









  function fixOverlayZoom(why) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const owner = mainWindow;
    const navigation = _navigationId;
    const wc = owner.webContents;
    wc.executeJavaScript('window.devicePixelRatio', true).then((dpr) => {
      if (!isCurrent(owner) || navigation !== _navigationId || wc.isDestroyed()) return;
      const sf = (screen.getPrimaryDisplay() || {}).scaleFactor || 1;
      const cur = wc.getZoomFactor() || 1;
      const dsf = (dpr || 1) / cur;
      const want = dsf / sf;
      if (Math.abs(want - cur) > 0.05) {
        console.error('[overlay] DPI 混合态：dsf=' + dsf + ' scaleFactor=' + sf +
          ' → zoom ' + cur.toFixed(2) + '→' + want.toFixed(2) + '（' + why + '）');
        wc.setZoomFactor(want);
      }
    }).catch(() => { /* Retry after renderer readiness. */ });
  }

  function createWindow() {
    if (_disposed) throw new Error('Desktop overlay controller is disposed');
    if (isCurrent(mainWindow)) return mainWindow;
    _initialPaintReady = false;
    _initialRevealPending = true;
    /*
     * Use full display bounds, including the taskbar, so edge-aligned components reach the
     * physical display edge.
     */
    const { x: dispX, y: dispY, width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().bounds;

    mainWindow = new BrowserWindow({
      width: screenWidth,
      height: screenHeight,
      x: dispX,
      y: dispY,
      frame: false,
      transparent: true,
      /*
       * Set an explicitly transparent background; transparent:true alone permits transparency
       * but does not replace the default background color.
       */
      backgroundColor: '#00000000',




      thickFrame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Taskbar exclusion alone does not hide an unowned HWND from Alt-Tab
      // or grouped previews. Windows' toolbar type gives it WS_EX_TOOLWINDOW.
      ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
      alwaysOnTop: true,
      hasShadow: false,
      // Do not expose an unclipped full-screen surface during startup.
      show: false,
      title: '',
      icon: _appIcon(),
      webPreferences: {
        preload: path.join(rendererRoot(), 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // Keep rendering while unfocused or occluded so desktop animation remains active.
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required'   // Match the command-line autoplay policy for notification sounds.
      }
    });

    /*
     * Park the native region at 1x1 before loading until renderer geometry arrives, including
     * on reload.
     */
    const owner = mainWindow;
    _initialPaintReady = false;
    _initialRevealPending = true;
    parkOverlayShape();
    _overlayAwaitingShape = true;
    let navigationStarted = false;
    mainWindow.webContents.on('did-start-loading', () => {
      if (isCurrent(owner)) {
        _navigationId++;
        if (_navigationId > 1) _overlayShapeRevision++;
        resetRendererHealth();
        /*
         * Arm the readiness watchdog when navigation starts so a fast renderer-ready event cannot
         * be reset afterward.
         */
        startReadyWatchdog();
        parkOverlayShape(navigationStarted);
        _overlayAwaitingShape = true;
        _initialRevealPending = true;
        navigationStarted = true;
      }
    });
    loadRenderer();

    /*
     * Keep the overlay title empty even when document.title changes.
     */
    mainWindow.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      if (isCurrent(owner)) mainWindow.setTitle('');
    });
    mainWindow.setTitle('');

    mainWindow.once('ready-to-show', () => {
      if (!isCurrent(owner)) return;
      _initialPaintReady = true;
      fixOverlayZoom('首帧');
      revealInitialOverlay();
    });
    mainWindow.webContents.on('dom-ready', () => { if (isCurrent(owner)) fixOverlayZoom('dom-ready'); });

    // Use native passthrough outside shaped regions; unsupported platforms use dynamic full-screen passthrough.
    setOverlayIdleInput();

    /* Restore native clipping after explicit tray or crash-recovery shows. */
    mainWindow.on('show', () => {
      later(() => {
        if (!isCurrent(owner) || _emergencyMode) return;
        if (!applyOverlayShape(_lastOverlayRects, false)) setOverlayIdleInput();
      }, 0, owner);
    });

    // Always on top: use screen-saver on Windows to stay above the taskbar, and floating on macOS, for overlay and main windows.

    _setOverlayTopmost(true);

    mainWindow.on('blur', () => {
      if (!isCurrent(owner)) return;
      // The revision handshake releases input without clipping the visible dock.
      notifyOverlayBlur();
    });

    /*
     * Recheck overlay bounds after display changes and startup so resolution or DPI
     * transitions cannot leave edge-aligned components off screen.
     */
    const fitToScreen = () => {
      if (!isCurrent(owner)) return;
      const b = screen.getPrimaryDisplay().bounds;
      const w = mainWindow.getBounds();
      if (w.x !== b.x || w.y !== b.y || w.width !== b.width || w.height !== b.height) {
        mainWindow.setBounds(b);
        /* Recompute regions for the new client coordinates without hiding the window. */
        redrawOverlay();
      }
      /* Recheck mixed-DPI state after display or scale changes. */
      fixOverlayZoom('display-metrics');
    };
    screen.on('display-metrics-changed', fitToScreen);
    screen.on('display-added', fitToScreen);
    screen.on('display-removed', fitToScreen);
    _windowDisposers.push(() => {
      for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
        screen.removeListener(event, fitToScreen);
      }
    });
    later(fitToScreen, 3000, owner);      // Verify startup bounds after transitional display values settle.

    // Hide instead of minimizing a skipTaskbar window so it remains recoverable.
    mainWindow.on('minimize', (e) => {
      e.preventDefault();
      if (isCurrent(owner)) {
        mainWindow.hide();
      }
    });

    // Closing this window exits the application through the tray-aware lifecycle.
    mainWindow.on('closed', () => {
      if (mainWindow !== owner) return;
      releaseWindowResources();
      _navigationId++;
      _rendererReady = false;
      _rendererUnresponsive = false;
      _emergencyMode = false;
      mainWindow = null;
      _lastOverlayRects = [];
      _appliedOverlayShape = [];
      _overlayInputRects = [];
      _overlayInputIgnored = null;
      _overlayShapeEnabled = false;
      _overlayShapeReported = false;
      _overlayShapeRevision = 0;
      _overlayAwaitingShape = false;
      _workWindowFocused = false;
    });

    /*
     * Enter emergency passthrough immediately after renderer failure because renderer-owned
     * hit-testing no longer runs.
     */
    mainWindow.webContents.on('render-process-gone', (event, details) => {
      if (!isCurrent(owner)) return;
      const reason = details.reason || 'unknown';
      console.error('[SAFETY] 渲染进程崩溃:', reason);
      // Hide the crashed overlay through emergency passthrough.
      emergencyPassthrough('渲染进程崩溃: ' + reason);
      if (reason === 'clean-exit') return;   // Do not reload after intentional shutdown.
      // Limit automatic crash recovery within a five-minute window; after repeated crashes, leave recovery to the tray.
      const crashedAt = now();
      if (crashedAt - _crashWindowStart > 5 * 60 * 1000) { _crashCount = 0; _crashWindowStart = crashedAt; }
      _crashCount++;
      if (_crashCount > 3) {
        console.error('[SAFETY] 短时间崩溃过多，停止自动重载，请从托盘「强制重载」恢复');
        return;
      }
      const navigation = _navigationId;
      later(() => {
        if (_emergencyMode && navigation === _navigationId) recoverFromEmergency(false);
      }, 800 * _crashCount, owner); // Skip automatic reload if manual recovery already started navigation.
    });

    /*
     * Handle Electron renderer responsiveness events.
     */
    mainWindow.webContents.on('unresponsive', () => {
      if (!isCurrent(owner)) return;
      _rendererUnresponsive = true;
      console.error('[SAFETY] 渲染进程无响应');
      // Require 15 seconds of continuous unresponsiveness before emergency passthrough.
      if (_unresponsiveTimer) clearTimeout(_unresponsiveTimer);
      _unresponsiveTimer = setTimeout(() => {
        _unresponsiveTimer = null;
        if (mainWindow && !mainWindow.isDestroyed() && _rendererUnresponsive) {
          emergencyPassthrough('渲染进程持续无响应');
        }
      }, UNRESPONSIVE_GRACE_MS);
    });
    // Cancel pending protection when the renderer responds again.
    mainWindow.webContents.on('responsive', () => {
      if (!isCurrent(owner)) return;
      _rendererUnresponsive = false;
      _heartbeatMisses = 0;
      if (_unresponsiveTimer) { clearTimeout(_unresponsiveTimer); _unresponsiveTimer = null; }
    });

    // Open DevTools only when development flags or environment settings request it.
    const isDev = process.env.SODUWORK_DEV === '1' || process.argv.includes('--remote-debugging-port=9222');
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    /* did-start-loading owns watchdog initialization; do not reset readiness after loadFile. */
    startHeartbeatWatchdog();
    return mainWindow;
  }

  /* ----- Overlay IPC ----- */
  // Window-control IPC.
  onIpc('window-close', () => {
    // Hide to the tray instead of closing.
    if (mainWindow) mainWindow.hide();
  });

  onIpc('window-minimize', () => {
    if (mainWindow) mainWindow.hide();
  });

  onIpc('window-set-always-on-top', (event, flag) => {
    /*
     * Apply overlay stacking requests only to the desktop overlay; native workspace windows
     * must not become always-on-top.
     */
    if (event.sender !== (mainWindow && mainWindow.webContents)) return;
    _setOverlayTopmost(flag);
  });

  onIpc('window-move', (event, x, y) => {
    if (mainWindow) mainWindow.setPosition(Math.round(x), Math.round(y));
  });

  onIpc('window-set-ignore-mouse-events', (event, ignore, opts) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    /* Emergency protection overrides renderer requests to disable passthrough. */
    if ((_emergencyMode || _overlayAwaitingShape) && !ignore) return;
    /* Renderer requests may trigger reevaluation but cannot disable native parking or input guards. */
    if (_overlayShapeEnabled) _syncOverlayInputNow();
    else _setOverlayInputIgnored(ignore);
  });

  /*
   * Validate visible interactive rectangles from the trusted overlay sender before applying
   * native regions; workspace windows cannot change the overlay shape.
   */
  onIpc('window-set-overlay-shape', (event, rects, revision) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    if (_emergencyMode) return;
    // Only the first navigation accepts legacy reports without a revision.
    if (revision === undefined && _overlayShapeRevision === 0) revision = 0;
    if (revision !== _overlayShapeRevision) return;
    if (applyOverlayShape(rects, true)) {
      _overlayShapeReported = true;
      if (revision === _overlayShapeRevision) _overlayAwaitingShape = false;
      _syncOverlayInputNow();
      revealInitialOverlay();
    }
    else emergencyPassthrough('桌面组件的原生区域初始化失败');
  });

  handleIpc('window-get-overlay-shape', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return null;
    return {
      supported: NATIVE_SHAPE && typeof mainWindow.setShape === 'function',
      enabled: _overlayShapeEnabled,
      reported: _overlayShapeReported,
      revision: _overlayShapeRevision,
      awaitingShape: _overlayAwaitingShape,
      requested: _lastOverlayRects,
      applied: _appliedOverlayShape,
      bounds: _overlayContentSize(),
    };
  });

  handleIpc('window-get-bounds', () => {
    if (mainWindow) return mainWindow.getBounds();
    return null;
  });

  /*
   * Update heartbeat time from the renderer's periodic IPC.
   */
  onIpc('renderer-heartbeat', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    resetRendererHealth();
  });

  /*
   * Cancel startup timeout after renderer-ready.
   */
  onIpc('renderer-ready', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    _rendererReady = true;
    revealInitialOverlay();
    resetRendererHealth();
    revealInitialOverlay();
    if (_readyTimer) { clearTimeout(_readyTimer); _readyTimer = null; }
    console.log('[SAFETY] 渲染进程已就绪');
    /* Keep the overlay parked when no interactive geometry has been reported. */
    const navigation = _navigationId;
    later(() => {
      if (navigation !== _navigationId || _overlayShapeReported) return;
      emergencyPassthrough('桌面组件区域未完成初始化');
    }, 600);
  });

  /* Read emergency-mode status. */
  handleIpc('safety-is-emergency', () => {
    return _emergencyMode;
  });


  app.on('will-quit', dispose);
  return Object.freeze({
    get window() { return mainWindow; },
    get emergency() { return _emergencyMode; },
    start, createWindow, reload, emergencyPassthrough, recoverFromEmergency,
    notifyBlur: notifyOverlayBlur, setWorkspaceMaximized, setWorkWindowFocused, dispose,
  });
}

module.exports = { create };
