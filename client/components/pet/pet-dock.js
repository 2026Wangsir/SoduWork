/*
 * Desktop shortcut dock: navigation, positioning, and dragging. pet-ui.js owns pet actions
 * and task views. Classic scripts share runtime globals and retain existing compatibility
 * interfaces.
 */
(function (global) {
  'use strict';

  /*
   * Use a 24px icon grid, 1.75px strokes, and comparable 17-18px visual bounds for
   * consistent icon weight.
   */
  const FALLBACK_DOCK_GLYPHS = {
    home: '<path d="M4 10.4 12 4l8 6.4"/><path d="M5.7 9.2v9.1c0 1 .8 1.7 1.7 1.7h9.2c1 0 1.7-.8 1.7-1.7V9.2"/><path d="M9.4 20v-5.2c0-.7.6-1.3 1.3-1.3h2.6c.7 0 1.3.6 1.3 1.3V20"/>',
    automation: '<path d="M9.5 2.75h5M12 2.75V5"/><circle cx="12" cy="13" r="7.75"/><path d="M12 8.75V13l2.75 1.75"/>',
    compose: '<path d="M13.5 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-7.5"/><path d="M10 14l.7-3.2L17.5 4a1.8 1.8 0 0 1 2.5 2.5l-6.8 6.8z"/>',
    taskboard: '<path d="M4 8.5h16v10.25A1.75 1.75 0 0 1 18.25 20.5H5.75A1.75 1.75 0 0 1 4 18.75Z"/><path d="M3.5 8.5 5.1 4h13.8l1.6 4.5M3.5 8.5h17M9 12h6"/>',
    notice: '<path d="M18 8.5a6 6 0 0 0-12 0c0 6.5-2.8 8.5-2.8 8.5h17.6S18 15 18 8.5"/><path d="M13.8 21a2 2 0 0 1-3.6 0"/>',
  };
  const DOCK_GLYPHS = (global.SoduWorkIconRegistry && global.SoduWorkIconRegistry.dock) || FALLBACK_DOCK_GLYPHS;
  const dockSvg = (key) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + DOCK_GLYPHS[key] + '</svg>';
  const HOME_SVG = dockSvg('home');
  const AUTOMATION_SVG = dockSvg('automation');
  const TASKBOARD_SVG = dockSvg('taskboard');
  const NOTICE_SVG = dockSvg('notice');
  /* Quick skin selection from the dock. */
  const SKIN_SVG = '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18h1.8a2.2 2.2 0 0 0 1.6-3.7 2.2 2.2 0 0 1 1.6-3.7H19a2 2 0 0 0 2-2A8.6 8.6 0 0 0 12 3z"/>' +
    '<circle cx="7.6" cy="10.4" r="1.15"/><circle cx="11.1" cy="7.4" r="1.15"/><circle cx="15.6" cy="8.2" r="1.15"/></svg>';
  const DOCK_SNAP = 28;

  let dragActive = false, dragPointerId = null, dragMoved = false;
  let suppressClick = false;
  let suppressTimer = null;
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
  let pendingLeft = 0, pendingTop = 0, dragFrame = null;
  let dragW = 0, dragH = 0;          /* Cache dimensions during dragging to avoid layout reads on every frame. */

  function setTeamCap(cap) {
    global.__teamCap = cap || null;
  }

  /*
   * Retain dismissal for legacy overlays and the skin menu so outside clicks, blur, and
   * Escape share cleanup.
   */
  function closeDockMore() {
    const el = document.getElementById('dockMore');
    if (el) el.classList.remove('show');
    const skin = document.getElementById('dockSkin');
    if (skin) skin.classList.remove('show');
  }

  /* List local and remote skins, mark the current choice, and apply changes immediately.
   applySkin persists the choice and broadcasts it to the workspace. Keep the picker open for comparison. */
  function renderDockSkin() {
    const el = document.getElementById('dockSkin');
    if (!el) return;
    const skins = (typeof SkinRegistry !== 'undefined') ? SkinRegistry.getSkins() : [];
    const cur = (typeof currentSkinId === 'function') ? currentSkinId() : '';
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows = skins.map((s) => {
      const on = s.id === cur;
      return '<button class="dsk-item' + (on ? ' on' : '') + '" data-skin-id="' + esc(s.id) + '" title="' + esc(s.desc || s.name) + '">' +
        '<i class="dsk-dot" style="background:' + esc(s.bg || '#eef4ff') + '"><b style="background:' + esc(s.bearColor || '#8fbdf0') + '"></b></i>' +
        "<span class=\"dsk-name\" data-user-content>" + esc(s.name) + '</span>' +
        (on ? '<svg class="dsk-check" viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7.5"/></svg>' : '') +
        '</button>';
    }).join('');
    el.innerHTML = '<div class="dsk-head">皮肤</div>' + rows +
      '<div class="ed-sep dsk-sep"></div>' +
      '<button class="dsk-item dsk-manage" data-skin-open-manager="1">' +
      '<span class="dsk-name">皮肤管理…</span></button>';
  }

  function onDockSkinClick(event) {
    event.stopPropagation();
    const manage = event.target.closest('[data-skin-open-manager]');
    if (manage) {
      closeDockMore();
      if (typeof openSkinEntry === 'function') openSkinEntry();
      return;
    }
    const item = event.target.closest('[data-skin-id]');
    if (!item) return;
    if (typeof applySkin === 'function') applySkin(item.dataset.skinId);
    renderDockSkin();      /* Move the selection checkmark without closing the menu. */
    paintDock();
  }

  /* Refresh pet and dock badges together without rebuilding their SVG or menus. */
  function paintPetUnread() {
    const unread = typeof noticeUnread === 'function' ? Number(noticeUnread()) || 0 : 0;
    if (global.WorkspaceShell && typeof global.WorkspaceShell.setNoticeCount === 'function') {
      global.WorkspaceShell.setNoticeCount(unread);
    }
    const badge = document.getElementById('petUnreadBadge');
    if (!badge) return;
    const label = unread > 99 ? '99+' : String(unread);
    if (unread <= 0) {
      if (!badge.hidden) badge.hidden = true;
      if (badge.textContent) badge.textContent = '';
      return;
    }
    if (badge.textContent !== label) badge.textContent = label;
    if (badge.hidden) badge.hidden = false;
  }

  function paintDock() {
    paintPetUnread();
    const dock = document.getElementById('edgeDock');
    if (!dock) return;






    const sig = 'requirements-v2';
    if (dock.dataset.sig === sig && dock.firstElementChild) return;
    dock.dataset.sig = sig;
    const items = [
      '<button class="ed-view ed-home" data-act="workspace" aria-label="对话" title="对话 · 打开对话页">' + HOME_SVG + '</button>',
      '<button class="ed-view ed-automation" data-act="schedules" aria-label="自动化" title="自动化 · 管理定时任务">' + AUTOMATION_SVG + '</button>',
      '<button class="ed-view ed-taskboard" data-act="requirements" aria-label="需求池" title="需求池 · 查看需求、安排执行与交付">' + TASKBOARD_SVG + '</button>',
      '<button class="ed-view ed-notice" data-act="notices" aria-label="通知" title="通知 · 查看催办、派活与流转提醒">' + NOTICE_SVG + '</button>',
    ];
    dock.innerHTML = '<div class="ed-grip drag-handle" title="按住这里挪动竖条"></div>' +
      items.join('');
  }

  function placeDock(dock) {
    const rect = dock.getBoundingClientRect();
    const width = rect.width || 36, height = rect.height || 185;
    const maxX = Math.max(0, window.innerWidth - width);
    const y = (cfg.dockY != null)
      ? Math.max(0, Math.min(cfg.dockY, Math.max(0, window.innerHeight - height)))
      : Math.max(12, Math.round(window.innerHeight / 2 - height / 2));
    let edge = (cfg.dockX == null);

    if (!edge) {
      const x = Math.max(0, Math.min(cfg.dockX, maxX));
      if (x >= maxX - DOCK_SNAP) {
        edge = true;
        if (document.readyState === 'complete') {
          cfg.dockX = null;
          if (typeof saveCfg === 'function') saveCfg();
        }
      } else {
        dock.classList.add('floating');
        dock.style.right = 'auto';
        dock.style.transformOrigin = 'top left';
        dock.style.left = Math.round(x) + 'px';
        dock.style.top = Math.round(y) + 'px';
      }
    }

    if (edge) {
      dock.classList.remove('floating');
      dock.style.left = 'auto';
      dock.style.right = '';
      dock.style.transformOrigin = '';
      dock.style.top = Math.round(y) + 'px';
    }
  }

  function syncSidebar() {
    const dock = document.getElementById('edgeDock');
    if (!dock) return;
    /* Visibility follows the persisted preference; no temporary override is applied. */
    if (cfg.dockVisible !== true || cfg.tasksOn === false) {
      // Explicit hiding ends the current gesture and clears pending frames, document listeners, and overlay drag mode.
      if (dragActive) onPointerUp();
      dock.classList.remove('show');
      closeDockMore();
      return;
    }
    paintDock();
    dock.classList.add('show');
    // Task or configuration pushes may refresh the sidebar during a drag; the persisted coordinates must not replace the active gesture position.
    if (!dragMoved) placeDock(dock);
  }

  function openCreate() {
    if (typeof openCreateEntry === 'function') openCreateEntry();
    else if (typeof openPiChatEntry === 'function') openPiChatEntry();
  }

  function openWorkspace() {
    if (global.soduWorkAPI && typeof soduWorkAPI.openDeskWindow === 'function') {
      soduWorkAPI.openDeskWindow({ panel: 'workspace', view: 'create' });
    }
  }

  function onDockClick(event) {
    if (suppressClick) {
      suppressClick = false;
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    const button = event.target.closest('[data-act]');
    const act = button ? button.dataset.act : '';
    closeDockMore();

    if (!button) return;
    if (act === 'workspace') { openWorkspace(); return; }
    if (act === 'create') { openCreate(); return; }
    if (act === 'schedules') { if (typeof openSchedulesEntry === 'function') openSchedulesEntry(); return; }
    if (act === 'notices') { if (typeof openNoticeEntry === 'function') openNoticeEntry(); return; }
    if (act === 'approvals') { if (typeof openApprovalsEntry === 'function') openApprovalsEntry(); return; }
    if (act === 'requirements' && typeof openHistoryEntry === 'function') openHistoryEntry();
  }

  function onPointerDown(event) {
    if (event.button !== 0 || dragActive) return;
    dragActive = true;
    dragPointerId = event.pointerId;
    const dock = document.getElementById('edgeDock');
    const rect = dock.getBoundingClientRect();
    baseLeft = rect.left; baseTop = rect.top;
    startX = event.clientX; startY = event.clientY;
    dragMoved = false;
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    if (typeof armGrabCursor === 'function' && !event.target.closest('button, a, input')) armGrabCursor(false);
  }

  function onPointerMove(event) {
    if (!dragActive || event.pointerId !== dragPointerId) return;
    const dx = event.clientX - startX, dy = event.clientY - startY;
    const dock = document.getElementById('edgeDock');
    if (!dragMoved) {
      if (dx * dx + dy * dy < 25) return;
      dragMoved = true;
      dock.classList.add('floating');
      dock.style.right = 'auto';
      dock.style.transformOrigin = 'top left';
      if (typeof expandForOverlay === 'function') expandForOverlay();
      /*
       * Use the moving rectangular window region during dragging to avoid per-frame SetWindowRgn
       * work, full-window flashes, or clipped content.
       */
      if (typeof beginOverlayDrag === 'function') beginOverlayDrag();
      if (typeof armGrabCursor === 'function') armGrabCursor(true);
    }
    /*
     * Measure dimensions once per drag to avoid alternating layout reads and style writes on
     * every pointer event.
     */
    if (!dragW || !dragH) {
      const rect = dock.getBoundingClientRect();
      dragW = rect.width; dragH = rect.height;
    }
    pendingLeft = Math.max(0, Math.min(baseLeft + dx, window.innerWidth - dragW));
    pendingTop = Math.max(0, Math.min(baseTop + dy, window.innerHeight - dragH));
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = null;
      dock.style.left = Math.round(pendingLeft) + 'px';
      dock.style.top = Math.round(pendingTop) + 'px';
    });
  }

  function onPointerUp(event) {
    if (!dragActive || (event && event.pointerId !== dragPointerId)) return;
    const moved = dragMoved;
    dragActive = false;
    dragPointerId = null;
    dragMoved = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerUp);
    if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = null; }
    dragW = 0; dragH = 0;
    if (typeof disarmGrabCursor === 'function') disarmGrabCursor();
    if (moved && typeof endOverlayDrag === 'function') endOverlayDrag();
    if (!moved) return;

    suppressClick = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppressClick = false; }, 350);
    const dock = document.getElementById('edgeDock');
    const width = dock ? (dock.getBoundingClientRect().width || 36) : 36;
    const maxX = Math.max(0, window.innerWidth - width);
    cfg.dockY = Math.round(pendingTop);
    cfg.dockX = (pendingLeft >= maxX - DOCK_SNAP) ? null : Math.round(pendingLeft);
    if (typeof saveCfg === 'function') saveCfg();
    if (dock) placeDock(dock);
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }

  function bindDock() {
    const dock = document.getElementById('edgeDock');
    if (!dock || dock._dockBound) return;
    dock._dockBound = true;
    dock.addEventListener('click', onDockClick);
    dock.addEventListener('pointerdown', onPointerDown);
    dock.addEventListener('dragstart', (event) => event.preventDefault());
    const skinFly = document.getElementById('dockSkin');
    if (skinFly) skinFly.addEventListener('click', onDockSkinClick);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDockMore();
    });
  }

  global.closeDockMore = closeDockMore;
  global._paintDock = paintDock;
  global._syncSidebar = syncSidebar;
  global.setTeamCap = setTeamCap;
  global.updateNoticeBadge = paintDock;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindDock);
  } else {
    bindDock();
  }
})(window);
