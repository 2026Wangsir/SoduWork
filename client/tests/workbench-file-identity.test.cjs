'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };

function fixture(cwd = 'C:/project', codeMirror = true) {
  const frames = new Map(), reads = [], shows = [], editors = [], events = new Map();
  let frame = 0, ref = 'chat-a';
  const node = () => ({ dataset: {}, setAttribute() {}, classList: { toggle() {}, remove() {} } });
  const makeTextarea = () => ({ value: '', scrollTop: 0, scrollLeft: 0, selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
    addEventListener(name, fn) { this[name] = fn; }, focus() { window.document.activeElement = this; },
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
    scrollTo(left, top) { this.scrollLeft = left; this.scrollTop = top; } });
  let textarea = makeTextarea(), bodyHtml = '';
  const save = { disabled: true };
  const body = { ...node(), get innerHTML() { return bodyHtml; }, set innerHTML(value) { bodyHtml = value; textarea = makeTextarea(); save.disabled = true; } };
  const tabs = { ...node(), innerHTML: '' };
  const scroller = { scrollTop: 0, scrollLeft: 0 };
  const nodes = { '.ncw': node(), '.ncw-tabs': tabs, '.ncw-body': body, '.ncw-markdown': scroller,
    '[data-wb-code-save]': save, '[data-code-editor]': { querySelector: () => textarea },
    '[data-wb-native]': { ...node(), getBoundingClientRect: () => ({ x: 0, y: 0, width: 600, height: 400 }) } };
  const root = { ...node(), offsetParent: {}, querySelector: selector => nodes[selector] || null,
    addEventListener: (name, fn) => events.set(name, fn) };
  const window = { URL, console, document: { activeElement: null }, addEventListener() {},
    requestAnimationFrame(fn) { frames.set(++frame, fn); return frame; }, cancelAnimationFrame(id) { frames.delete(id); },
    ChatWorkspaceSplit: { DEFAULT: 0.5, set() {}, bind: () => ({ dispose() {} }) },
    CodeMirror: { fromTextArea(area) {
      const listeners = {}; let value = area.value, scroll = { left: 0, top: 0 }, selection = [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }], history = { done: [], undone: [] };
      const editor = { getValue: () => value, on: (name, fn) => { listeners[name] = fn; }, toTextArea() {},
        edit(next) { value = next; history.done.push(next); listeners.change(); },
        getScrollInfo: () => scroll, scrollTo(left, top) { scroll = { left, top }; },
        listSelections: () => selection, setSelections: next => { selection = next; },
        getHistory: () => history, setHistory: next => { history = next; } };
      editors.push(editor); return editor;
    } },
    soduWorkAPI: { conversationSession: {}, workPreview: { onState: () => () => {}, hide: async () => ({}), destroy: async () => ({}),
      async show(payload) { shows.push(payload); return { ok: true }; } } } };
  if (!codeMirror) delete window.CodeMirror;
  const sandbox = vm.createContext({ window, URL, setTimeout: () => 1, clearTimeout() {} });
  for (const name of ['chat-output-links', 'chat-dom-patch', 'panels-chat-tools', 'chat-workspace-info', 'chat-workspace-controls', 'panels-chat-workspace']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8'), sandbox);
  }
  window.ChatOutputLinks.readPreview = file => new Promise(resolve => reads.push({ file, resolve }));
  const wb = window.ChatWorkbench; wb.bind(root, () => ({ ref, cwd }));
  return { wb, window, reads, shows, editors, save, scroller, root, body, get textarea() { return textarea; },
    tabs: () => [...tabs.innerHTML.matchAll(/role="tab" data-wb-tab="([^"]+)"/g)].map(match => match[1]),
    render: (snapshot, files) => wb.render(root, snapshot, files),
    setRef: next => { ref = next; },
    click(attribute, dataset = {}) {
      const button = { ...node(), dataset, hasAttribute: name => name === attribute,
        closest: selector => selector === '.ncw-markdown a' ? null : button };
      events.get('click')({ target: button, preventDefault() {}, stopPropagation() {} });
    },
    async flush() { await tick(); while (frames.size) { const batch = [...frames.values()]; frames.clear(); for (const fn of batch) await fn(); } await tick(); },
  };
}
const journal = (name = 'report.md', cwd = 'C:/project', at = 1200) => ({
  messages: [{ role: 'user', at: 1000, blocks: [{ kind: 'text', text: 'Create ' + name }] }],
  tools: [{ name: 'write', state: 'done', after: 0, args: { path: name } }],
  fileChanges: { cwd, capturedAt: at, files: [{ path: name, action: 'created', after: { exists: true, text: '# Original', size: 20, mtimeMs: at } }] },
});
const artifact = (relative = 'report.md', extra = {}) => ({ artifactId: 'published-' + relative, relative,
  name: relative.split('/').pop(), size: 20, at: 1200, primary: true, changedInTurn: true, ...extra });

test('journal then published artifact keeps one tab; two turns produce two tabs', () => {
  const f = fixture(), first = journal(); f.render(first, []); const original = f.tabs();
  f.render(first, [artifact()]); assert.deepEqual(f.tabs(), original);
  const second = journal('second.md', 'C:/project', 1400); f.render(second, [artifact()]);
  assert.equal(f.tabs().length, 2);
  f.render(second, [artifact(), artifact('second.md', { at: 1400 })]); assert.equal(f.tabs().length, 2);
});

test('promotion preserves the selected source view, unsaved draft, undo, selection and scroll', async () => {
  const f = fixture(), snapshot = journal(); f.render(snapshot, []);
  f.reads[0].resolve({ ok: true, text: '# Original' }); await f.flush();
  f.click('data-wb-code-view', { wbCodeView: 'code' }); await f.flush();
  const editor = f.editors.at(-1); editor.edit('unsaved work'); editor.scrollTo(27, 430);
  editor.setSelections([{ anchor: { line: 7, ch: 2 }, head: { line: 8, ch: 4 } }]);
  const original = f.tabs(); f.render(snapshot, [artifact()]); await f.flush();
  assert.deepEqual(f.tabs(), original); const next = f.editors.at(-1);
  assert.equal(next.getValue(), 'unsaved work'); assert.deepEqual(next.getScrollInfo(), { left: 27, top: 430 });
  assert.deepEqual(next.listSelections(), editor.listSelections()); assert.deepEqual(next.getHistory(), editor.getHistory());
  assert.equal(f.save.disabled, false); assert.match(f.body.innerHTML, /data-code-editor/);
});

test('late local preview cannot overwrite the published artifact read', async () => {
  const f = fixture(), snapshot = journal(); f.render(snapshot, []); const local = f.reads[0];
  f.render(snapshot, [artifact()]); const published = f.reads.at(-1);
  assert.equal(published.file.artifactId, artifact().artifactId);
  published.resolve({ ok: true, text: 'Published content' }); await f.flush();
  local.resolve({ ok: true, text: 'STALE LOCAL CONTENT' }); await f.flush();
  assert.equal(f.tabs().length, 1); assert.match(f.body.innerHTML, /Published content/);
  assert.doesNotMatch(f.body.innerHTML, /STALE LOCAL/);
});

test('textarea fallback retains edited text, selection, scroll and focus during promotion', async () => {
  const f = fixture('C:/project', false), snapshot = journal(); f.render(snapshot, []);
  f.reads[0].resolve({ ok: true, text: '# Original' }); await f.flush();
  f.click('data-wb-code-view', { wbCodeView: 'code' }); await f.flush();
  const old = f.textarea; old.value = 'fallback unsaved text'; old.input();
  old.setSelectionRange(3, 12, 'backward'); old.scrollTo(20, 300); old.focus();
  f.render(snapshot, [artifact()]); await f.flush();
  assert.equal(f.tabs().length, 1); assert.notEqual(f.textarea, old);
  assert.equal(f.textarea.value, 'fallback unsaved text');
  assert.deepEqual([f.textarea.selectionStart, f.textarea.selectionEnd, f.textarea.selectionDirection], [3, 12, 'backward']);
  assert.deepEqual([f.textarea.scrollLeft, f.textarea.scrollTop], [20, 300]);
  assert.equal(f.window.document.activeElement, f.textarea);
});

for (const codeMirror of [true, false]) test('a follow-up without file changes keeps the selected Markdown source populated (' + (codeMirror ? 'CodeMirror' : 'textarea') + ')', async () => {
  const f = fixture('C:/project', codeMirror);
  f.render(journal(), [artifact()]);
  f.reads[0].resolve({ ok: true, text: '# Original' }); await f.flush();
  f.click('data-wb-code-view', { wbCodeView: 'code' }); await f.flush();
  const tabs = f.tabs(), previous = codeMirror ? f.editors.length : f.textarea;
  f.render({ messages: [{ role: 'user', at: 2000, blocks: [{ kind: 'text', text: 'Explain the result without changing it' }] }], tools: [] },
    [artifact('report.md', { changedInTurn: false })]);
  await f.flush();
  assert.deepEqual(f.tabs(), tabs, 'the retained title still identifies the same document');
  assert.match(f.body.innerHTML, /data-wb-code-copy/, 'source controls remain usable after the change journal clears');
  if (codeMirror) {
    assert.ok(f.editors.length > previous, 'the replacement source textarea must be mounted');
    assert.equal(f.editors.at(-1).getValue(), '# Original');
  } else {
    assert.notEqual(f.textarea, previous);
    assert.equal(f.textarea.value, '# Original');
    assert.equal(f.textarea.className, 'ncw-editor-fallback');
  }
});

test('a retained Markdown diff can switch to source after a follow-up clears the journal', async () => {
  const f = fixture();
  f.render(journal(), [artifact()]);
  f.reads[0].resolve({ ok: true, text: '# Original' }); await f.flush();
  f.click('data-wb-code-view', { wbCodeView: 'diff' }); await f.flush();
  f.render({ messages: [{ role: 'user', at: 2000, blocks: [{ kind: 'text', text: 'Explain only' }] }], tools: [] },
    [artifact('report.md', { changedInTurn: false })]);
  await f.flush();
  assert.match(f.body.innerHTML, /ncw-diff-empty/);
  f.click('data-wb-code-view', { wbCodeView: 'code' }); await f.flush();
  assert.match(f.body.innerHTML, /data-code-editor/);
  assert.equal(f.editors.at(-1).getValue(), '# Original');
});

test('native preview reuses the existing tab without navigation when only identity changes', async () => {
  const f = fixture(), snapshot = journal('index.html'); f.render(snapshot, []); await f.flush();
  const first = f.shows.at(-1); assert.equal(first.kind, 'file');
  f.render(snapshot, [artifact('index.html')]); await f.flush();
  assert.equal(f.tabs().length, 1); assert.equal(f.shows.at(-1).tabId, first.tabId);
  assert.equal(f.shows.at(-1).kind, undefined); assert.equal(f.shows.at(-1).reload, undefined);
});

test('a real content version still reloads the same native tab after promotion', async () => {
  const f = fixture(), snapshot = journal('index.html'); f.render(snapshot, []); await f.flush();
  const tabId = f.shows.at(-1).tabId;
  f.render(snapshot, [artifact('index.html', { at: 1300, size: 30 })]); await f.flush();
  assert.deepEqual(f.tabs(), [tabId]); assert.equal(f.shows.at(-1).tabId, tabId);
  assert.equal(f.shows.at(-1).kind, 'artifact'); assert.equal(f.shows.at(-1).reload, true);
});

test('promotion of a background file does not activate it or discard its earlier draft', async () => {
  const f = fixture(), snapshot = journal(); f.render(snapshot, []);
  f.reads[0].resolve({ ok: true, text: '# Original' }); await f.flush();
  f.click('data-wb-code-view', { wbCodeView: 'code' }); await f.flush();
  f.editors.at(-1).edit('background unsaved draft');
  f.wb.openLink('https://chosen.example.test'); await f.flush();
  f.render(snapshot, [artifact()]); await f.flush();
  assert.equal(f.tabs().length, 2); assert.match(f.body.innerHTML, /chosen.example.test/);
  f.click('data-wb-tab', { wbTab: f.tabs()[0] }); await f.flush();
  assert.equal(f.editors.at(-1).getValue(), 'background unsaved draft');
});

test('exact workspace identity respects Windows case and POSIX case, and never basename', () => {
  for (const [cwd, local, published, expected] of [
    ['C:/project', 'Docs/Report.md', 'docs/report.md', 1],
    ['/project', 'Docs/Report.md', 'docs/report.md', 2],
    ['C:/project', 'one/report.md', 'two/report.md', 2],
    ['C:/project', 'report.md', '../report.md', 2],
  ]) {
    const f = fixture(cwd), snapshot = journal(local, cwd); f.render(snapshot, []);
    f.render({ messages: snapshot.messages }, [artifact(published)]); f.wb.openOutput(artifact(published).artifactId);
    assert.equal(f.tabs().length, expected, JSON.stringify({ cwd, local, published }));
  }
});

test('snapshots, input tabs, task/remote files, ambiguous paths and another chat are not promoted', () => {
  for (const kind of ['snapshot', 'input', 'task', 'remote', 'ambiguous', 'other-chat', 'outside', 'name-only']) {
    const f = fixture(), snapshot = journal();
    if (kind === 'snapshot') f.wb.openPath('report.md', { readSnapshot: { id: 'read-1', text: 'read snapshot' } });
    else if (kind === 'input') f.wb.openInput({ path: 'C:/project/report.md', name: 'report.md' });
    else f.render(snapshot, []);
    if (kind === 'other-chat') f.setRef('chat-b');
    const extra = kind === 'task' ? { taskId: 'task-1', attachmentId: 'attachment-1' }
      : kind === 'remote' ? { cloudPending: true } : kind === 'outside' ? { path: 'C:/elsewhere/report.md' }
      : kind === 'name-only' ? { relative: undefined } : {};
    const files = [artifact('report.md', extra)]; if (kind === 'ambiguous') files.push(artifact('report.md', { artifactId: 'another' }));
    f.render({ messages: snapshot.messages }, files);
    if (kind !== 'task' && kind !== 'remote') f.wb.openOutput(files[0].artifactId);
    // No automatic identity upgrade: the original file/snapshot remains separately addressable.
    if (kind !== 'input' && kind !== 'task' && kind !== 'remote') assert.ok(f.tabs().length >= 2, kind);
    if (kind === 'input') assert.equal(f.tabs().length, 1, 'existing explicit input reuse stays intact');
    if (kind === 'task' || kind === 'remote') assert.equal(f.reads.at(-1).file.artifactId, undefined, kind + ' cannot replace the active local preview');
  }
});


test('an obsolete indexed identity for the same unique workspace path reuses the native tab', async () => {
  const f = fixture(), snapshot = journal('index.html');
  f.render(snapshot, [artifact('index.html', { artifactId: 'old-index-id' })]); await f.flush();
  const first = f.tabs();
  f.render(snapshot, [artifact('index.html', { artifactId: 'current-index-id' })]); await f.flush();
  assert.deepEqual(f.tabs(), first);
  f.wb.openOutput('current-index-id'); await f.flush();
  assert.deepEqual(f.tabs(), first);
});
