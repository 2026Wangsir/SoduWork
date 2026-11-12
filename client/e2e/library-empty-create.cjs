'use strict';
// Production library rendering and native Electron pointer/key events. Storage
// APIs and conversation handoff are fixtures; this never opens a user profile.
const electron = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const output = path.resolve(process.argv[2] || path.join(__dirname, '../../outputs/library-empty-create'));
if (typeof electron === 'string') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-empty-create-'));
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename, output, temporary],
    { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 90000);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    clearTimeout(timeout);
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith('soduwork-library-empty-create-')) throw Error('Unsafe fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow } = electron;
  const assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), temporary = path.resolve(process.argv[3] || '');
  if (path.dirname(temporary) !== path.resolve(os.tmpdir()) ||
      !path.basename(temporary).startsWith('soduwork-library-empty-create-')) throw Error('Isolated profile required');
  app.setPath('userData', path.join(temporary, 'profile'));
  fs.mkdirSync(output, { recursive: true });
  const report = { ok: false, boundary: 'Production library renderer, CSS and native Electron mouse/key input. In-memory storage API, conversation handoff and file picker boundary; no live Hub or model.', cases: [], errors: [] };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 80; i++) { if (await js(code)) return; await wait(25); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    const point = await js(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw Error('Missing control: ' + ${JSON.stringify(selector)});
      const visible = element.querySelector('.library-card-name') || element;
      visible.scrollIntoView({ block: 'nearest' });
      const box = visible.getBoundingClientRect();
      if (!box.width || !box.height) throw Error('Hidden control: ' + ${JSON.stringify(selector)});
      const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      if (!element.contains(document.elementFromPoint(point.x, point.y))) throw Error('Obscured control');
      return point;
    })()`);
    for (const type of ['mouseDown', 'mouseUp'])
      win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await wait(30);
  }
  async function enter(selector, text) {
    await click(selector);
    // Use the native edit action; Control+A is not Select All on macOS.
    win.webContents.selectAll();
    await until(`(() => { const input = document.querySelector(${JSON.stringify(selector)});
      return input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === input.value.length; })()`);
    if (text) await win.webContents.insertText(text);
    else for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Backspace' });
  }
  async function loaded() {
    await until('!!document.querySelector("[data-library-title]") && !document.querySelector(".library-spinner")');
  }
  async function menuCreate(menu, kind) {
    await click(`[data-library-menu-toggle="${menu}"]`);
    await click(`[data-library-menu="${menu}"] [data-library-create-kind="${kind}"]`);
  }
  async function snapshot(name) {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  async function checkActions(menu, storage, folderId = '') {
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-library-menu="${menu}"] [data-library-create-kind]')].map(e => e.dataset.libraryCreateKind)`),
      ['image', 'spreadsheet', 'presentation', 'folder', 'upload']);
    assert.deepEqual(await js(`[...document.querySelectorAll('[data-library-filter-kind]')].map(e => e.dataset.libraryFilterKind)`),
      ['all', 'document', 'image', 'spreadsheet', 'presentation', 'folder']);
    for (const kind of ['image', 'spreadsheet', 'presentation']) {
      const before = await js('fixture.handoffs.length');
      await menuCreate(menu, kind);
      assert.equal(await js('fixture.handoffs.length'), before + 1, kind + ' must hand off once');
      const handoff = await js('fixture.handoffs.at(-1)');
      assert.equal(handoff.view, 'create'); assert.equal(handoff.payload.newSession, true);
      assert.ok(handoff.payload.prefill && handoff.payload.contextPrompts.length === 1);
      const previous = await js(`fixture.expected[${JSON.stringify(kind)}] || null`);
      if (previous) assert.deepEqual(handoff, previous, 'Both menus use the same creation handoff');
      else await js(`fixture.expected[${JSON.stringify(kind)}] = ${JSON.stringify(handoff)}; void 0;`);
    }
    await menuCreate(menu, 'folder');
    await until('!!document.querySelector(".library-folder-dialog")');
    await enter('[data-library-folder-name]', '验证文件夹');
    await click('.library-folder-editor-save');
    await until('!document.querySelector(".library-folder-dialog")'); await loaded();
    assert.deepEqual(await js('fixture.folders.at(-1)'), { name: '验证文件夹', folderId, storage });
    const beforePicker = await js('fixture.pickerCalls');
    const beforeUploads = await js('fixture.uploads.length');
    await menuCreate(menu, 'upload');
    assert.equal(await js('fixture.pickerCalls'), beforePicker + 1, 'Upload must open its picker once');
    await js(`(() => { const input = document.querySelector('[data-library-upload]'), transfer = new DataTransfer();
      transfer.items.add(new File(['上传原文'], '验证上传.txt', { type: 'text/plain' }));
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await until(`fixture.uploads.length === ${beforeUploads + 1}`);
    await loaded();
    assert.deepEqual(await js('fixture.uploads.at(-1)'), { name: '验证上传.txt', content: '上传原文', folderId, storage });
    assert.equal(await js('document.querySelectorAll("[data-library-menu]:not([hidden])").length'), 0);
    report.cases.push(`${menu}: all 5 actions (no document creation) run once in ${storage}/${folderId || 'root'} with exact storage/folder context`);
  }
  async function checkSavedVisibility() {
    await js(`fixture.saved = [
      { id: 'saved-normal', title: 'report.txt', filename: 'report.txt', kind: 'file' },
      { id: 'saved-dot', title: '.notes.md', filename: '.notes.md', kind: 'document', favorite: true },
      { id: 'saved-hidden', title: 'legacy.txt', filename: 'legacy.txt', kind: 'file', extra: { hidden: true } },
      { id: 'saved-trash', title: '.deleted.txt', filename: '.deleted.txt', kind: 'file', deletedAt: '2026-11-03' },
    ];
    SoduWorkAPI.listLibrary = async filters => ({
      items: fixture.saved.filter(item => Boolean(item.deletedAt) === (filters.scope === 'trash')
        && (filters.scope !== 'favorites' || item.favorite)
        && (!filters.query || item.filename.includes(filters.query))).map(item => ({ ...item, backend: filters.storage })),
      folders: !filters.folderId && filters.scope !== 'trash' ? [{ id: 'saved-folder', name: '.saved-folder', backend: filters.storage }] : [],
      folder: null, trashCount: 1,
    }); void 0;`);
    const ids = () => js('[...document.querySelectorAll("[data-library-select]")].map(e => e.dataset.librarySelect).sort()');
    for (const preference of ['0', '1']) {
      await js(`closeLibraryPanel(); document.querySelector('#libraryPanel').remove();
        localStorage.setItem('soduwork_work_library_show_hidden', ${JSON.stringify(preference)});
        openLibraryPanel(); void 0;`); await loaded();
      for (const storage of ['local', 'remote']) {
        await click(`[data-library-storage="${storage}"]`); await loaded();
        await click('[data-library-scope=recommended]'); await loaded();
        assert.deepEqual(await ids(), ['saved-dot', 'saved-hidden', 'saved-normal']);
        for (const view of ['list', 'grid']) {
          await click(`[data-library-view="${view}"]`);
          assert.deepEqual(await ids(), ['saved-dot', 'saved-hidden', 'saved-normal']);
          assert.equal(await js('document.querySelectorAll(".is-hidden-item").length'), 0);
          assert.equal(await js('document.querySelector("[data-library-content]").textContent.includes("已隐藏")'), false);
        }
        assert.equal(await js('document.querySelector("[data-library-hidden-files]")'), null);
        assert.equal(await js('document.querySelector("[data-library-menu=options]")'), null);
        assert.equal(await js('document.querySelector("[data-library-trash]").textContent.trim()'), '回收站');
        await snapshot(`saved-files-${storage}-${preference}`);
        await click('[data-library-trash]'); await loaded();
        assert.deepEqual(await ids(), ['saved-trash']);
        await click('[data-library-root]'); await loaded();
        await click('[data-library-scope=all]'); await loaded();
        assert.equal(await js('!!document.querySelector("[data-library-folder=saved-folder]")'), true);
        await click('[data-library-scope=folders]'); await loaded();
        assert.equal(await js('!!document.querySelector("[data-library-folder=saved-folder]")'), true);
        assert.deepEqual(await ids(), []);
        await click('[data-library-scope=favorites]'); await loaded();
        assert.deepEqual(await ids(), ['saved-dot']);
        await click('[data-library-scope=all]'); await loaded();
        await enter('[data-library-search]', '.notes');
        await until('document.querySelectorAll("[data-library-select]").length === 1');
        assert.deepEqual(await ids(), ['saved-dot']);
        await enter('[data-library-search]', '');
        await until('document.querySelectorAll("[data-library-select]").length === 3');
        report.cases.push(`${storage}: saved dotfiles, legacy hidden items and dotfolders remain visible with old preference ${preference}; list/grid, search, favorites and trash work`);
      }
    }
    assert.equal(await js('fixture.saved.find(item => item.id === "saved-hidden").extra.hidden'), true,
      'Displaying previously hidden files must not rewrite stored metadata');
  }
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, width: 1250, height: 1050,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, callback) => callback({ cancel: true }));
    await win.loadFile(path.join(__dirname, 'fixtures/library.html'));
    await js(`window.fixture = { documents: [], folders: [], uploads: [], handoffs: [], expected: {}, pickerCalls: 0, showFolder: false };
      window.WorkspaceHost = { open: (view, payload) => fixture.handoffs.push({ view, payload }) };
      window.SoduWorkAPI = {
        getLibraryStorageStatus: async () => ({ storage: { local: { available: true }, remote: { backend: 'nfs', configured: true, connected: true, available: true } } }),
        listLibrary: async filters => ({ items: [], folders: fixture.showFolder && !filters.folderId ? [{ id: 'fixture-folder', name: '现有文件夹', backend: filters.storage }] : [],
          folder: filters.folderId ? { id: filters.folderId, name: '现有文件夹', backend: filters.storage } : null, trashCount: 0 }),
        createLibraryItem: async payload => { fixture.documents.push(payload); return { item: { id: 'fixture-document' } }; },
        createLibraryFolder: async (name, folderId, storage) => { fixture.folders.push({ name, folderId, storage }); return { folder: { id: 'fixture-created-folder' } }; },
        uploadLibraryFile: async (file, folderId, storage) => { fixture.uploads.push({ name: file.name, content: await file.text(), folderId, storage }); return { item: { id: 'fixture-upload' } }; },
      }; void 0;`);
    for (const file of ['library-file-icons.js', 'panels-library-dialogs.js', 'panels-library.js'])
      await js(fs.readFileSync(path.join(client, 'components/panels', file), 'utf8') + '\nvoid 0;');
    await js('openLibraryPanel(); void 0;'); await loaded();
    await until('!document.querySelector("[data-library-storage=remote]").disabled');
    await js(`document.querySelector('[data-library-upload]').addEventListener('click', event => {
      event.preventDefault(); fixture.pickerCalls++;
    }); void 0;`);
    // Native pointerdown followed by pointerup catches dismissal-before-click;
    // element.click() alone cannot reproduce this regression.
    await checkActions('empty-create', 'local');
    await checkActions('create', 'local');
    for (const theme of ['azure', 'ruby', 'steady', 'warm', 'minimal']) {
      await js(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; void 0;`);
      const colors = await js(`(() => { const button = document.querySelector('[data-library-menu-toggle="empty-create"]');
        return { foreground: getComputedStyle(button).color, chevron: getComputedStyle(button.querySelector('svg')).color }; })()`);
      assert.equal(colors.chevron, colors.foreground, `${theme}: chevron inherits the primary foreground`);
      assert.equal(colors.foreground, 'rgb(255, 255, 255)');
      await click('[data-library-menu-toggle="empty-create"]');
      await until('!document.querySelector("[data-library-menu=empty-create]").hidden');
      const menuColors = await js(`(() => { const row = document.querySelector('[data-library-menu="empty-create"] button');
        const header = document.querySelector('[data-library-menu="create"] button');
        return { row: getComputedStyle(row).color, label: getComputedStyle(row.querySelector('span')).color,
          header: getComputedStyle(header.querySelector('span')).color, icon: getComputedStyle(row.querySelector('svg')).color }; })()`);
      assert.equal(menuColors.label, menuColors.row, theme + ': menu labels do not inherit empty-state muted color');
      assert.equal(menuColors.label, menuColors.header, theme + ': menu label matches toolbar menu');
      assert.equal(menuColors.icon, menuColors.row, theme + ': menu glyph follows menu text');
      await snapshot('empty-menu-' + theme);
      await click('[data-library-title]');
      assert.equal(await js('document.querySelector("[data-library-menu=empty-create]").hidden'), true);
      await click('[data-library-menu-toggle="empty-create"]');
      for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
      await until('document.querySelector("[data-library-menu=empty-create]").hidden');
      assert.equal(await js('document.querySelector("[data-library-menu-toggle=empty-create]").getAttribute("aria-expanded")'), 'false');
      report.cases.push(theme + ': white primary chevron, neutral menu, outside click and Escape close correctly');
    }
    await click('[data-library-storage=remote]'); await loaded();
    await checkActions('empty-create', 'nfs');
    await checkActions('create', 'nfs');
    await js('fixture.showFolder = true; void 0;');
    await click('[data-library-scope=all]'); await loaded();
    await click('[data-library-folder=fixture-folder]'); await loaded();
    assert.equal(await js('document.querySelector("[data-library-menu-toggle=empty-create]")'), null,
      'Preserve the folder view with one toolbar create entry');
    await checkActions('create', 'nfs', 'fixture-folder');
    assert.equal(await js('fixture.documents.length'), 0);
    assert.equal(await js('fixture.folders.length'), 5);
    assert.equal(await js('fixture.uploads.length'), 5);
    await checkSavedVisibility();
    assert.deepEqual(report.errors, []);
    report.ok = true;
  }).catch(async error => {
    report.error = error.stack;
    if (win && !win.isDestroyed()) await snapshot('failure').catch(() => {});
  }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    win?.destroy(); app.exit(report.ok ? 0 : 1);
  });
}
