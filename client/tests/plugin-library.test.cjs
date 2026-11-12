'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'components', 'panels', name), 'utf8');

function library() {
  const sandbox = { window: { SoduWorkPluginCatalogFormat: { processBadge: () => '' } } };
  vm.createContext(sandbox);
  vm.runInContext(read('panels-capability-directory.js'), sandbox);
  vm.runInContext(read('plugin-presentation.js'), sandbox);
  const model = sandbox.window.SoduWorkPluginPresentation.libraryModel;
  assert.equal(typeof model, 'function', 'the real presentation module exports the library model');
  const evaluate = (catalog, filters = {}, matches = search, stateFor = item => item.fixtureState || 'ready') =>
    model(catalog, filters, matches, stateFor);
  evaluate.presentation = sandbox.window.SoduWorkPluginPresentation;
  return evaluate;
}

function search(item, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  return [item.name, item.description, item.key].some(value =>
    String(value || '').toLocaleLowerCase().includes(needle));
}

function ids(items) { return Array.from(items, item => item.pluginId); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function fixture() {
  const row = (pluginId, personal, category, fixtureState, name) => ({
    pluginId, personal, installed: !personal, name, description: 'Knowledge and office work',
    enabled: fixtureState !== 'disabled', fixtureState,
    marketPolicy: { configured: true, category },
  });
  return {
    categories: [
      { key: 'research', name: 'Research', enabled: true, sort: 10 },
      { key: 'office', name: 'Office', enabled: true, sort: 20 },
      { key: 'empty', name: 'Empty', enabled: true, sort: 30 },
    ],
    items: [
      row('personal-ready', true, 'research', 'ready', 'Research helper'),
      row('personal-disabled', true, 'office', 'disabled', 'Office helper'),
      row('personal-setup', true, 'research', 'attention', 'Research setup'),
      row('enterprise-ready', false, 'office', 'ready', 'Office team helper'),
      row('enterprise-update', false, 'research', 'attention', 'Research update'),
      row('enterprise-disabled', false, 'research', 'disabled', 'Research paused'),
      { ...row('market-only', false, 'office', 'ready', 'Market helper'), installed: false },
    ],
    submissions: [],
  };
}

function creatorCatalog() {
  return {
    categories: [
      { key: 'office', name: 'Office', enabled: true },
      { key: 'research', name: 'Research', enabled: true },
    ],
    items: [{
      pluginId: 'local:weekly-report', key: 'weekly-report', name: 'My working draft',
      description: 'Personal working copy', personal: true, installed: true, enabled: true,
      version: '3.0.0', fixtureState: 'ready', entrypoints: { conversation: true },
      marketPolicy: { configured: true, category: 'office' },
    }, {
      pluginId: 'company-report', key: 'weekly-report', name: 'Company reporting guide',
      description: 'Published company instructions', scope: 'organization',
      qualifiedKey: 'org:example/weekly-report', version: '1.0.0', versionId: 'published-v1',
      installed: false, enabled: true, trustState: 'approved', catalogReady: true,
      permissions: { canEdit: true, canUse: true }, fixtureState: 'attention',
      marketPolicy: { configured: true, category: 'research' },
    }],
    submissions: [{
      pluginId: 'company-report', key: 'weekly-report', name: 'Submitted working copy',
      scope: 'organization', qualifiedKey: 'org:example/weekly-report',
      version: '2.0.0', versionId: 'submitted-v2', createdAt: 20, reviewedAt: 0,
      trustState: 'quarantined', enabled: false, catalogReady: false,
    }],
  };
}

test('a creator sees one library card without changing local, published or submitted versions', () => {
  const model = library();
  const catalog = creatorCatalog();
  const before = JSON.stringify(catalog);
  const view = model(catalog);
  assert.deepEqual(ids(view.items), ['local:weekly-report']);
  assert.deepEqual(ids(model.presentation.managedPlugins(catalog)), ids(view.managed));
  const card = view.items[0];
  assert.equal(card.version, '3.0.0');
  assert.equal(card.personal, true);
  assert.equal(card.enabled, true);
  assert.equal(card.creatorPublication.company.pluginId, 'company-report');
  assert.equal(card.creatorPublication.company.version, '1.0.0');
  assert.equal(card.creatorPublication.submission.versionId, 'submitted-v2');
  assert.equal(card.creatorPublication.submission.catalogReady, false);
  assert.equal(JSON.stringify(catalog), before, 'projection must not rewrite execution records or receipts');
});

test('combined creator cards count once overall and remain in both source filters with local availability and category', () => {
  const model = library();
  const catalog = creatorCatalog();
  catalog.items[0].enabled = false;
  catalog.items[0].fixtureState = 'disabled';
  for (const source of ['all', 'personal', 'enterprise']) {
    const view = model(catalog, { source, category: 'office', status: 'disabled' });
    assert.deepEqual(ids(view.items), ['local:weekly-report'], source);
    assert.deepEqual(plain(view.counts), { all: 1, personal: 1, enterprise: 1 });
    assert.equal(view.categories.find(row => row.key === 'office').count, 1);
    assert.equal(view.categories.find(row => row.key === 'research').count, 0);
  }
  assert.deepEqual(ids(model(catalog, { category: 'research' }).items), []);
  assert.deepEqual(ids(model(catalog, { status: 'attention' }).items), []);
  for (const query of ['working draft', 'company reporting', 'published company']) {
    assert.deepEqual(ids(model(catalog, { source: 'enterprise', query }).items), ['local:weekly-report'], query);
  }
});

test('same names, edit permissions and another publisher do not establish a creator association', () => {
  const model = library();
  for (const change of [
    catalog => { catalog.submissions = []; },
    catalog => { catalog.items[0].key = 'unrelated-draft'; },
    catalog => { catalog.items[0].builtIn = true; },
    catalog => { catalog.submissions[0].scope = 'platform'; },
    catalog => { catalog.submissions[0].qualifiedKey = 'org:other/weekly-report'; },
    catalog => { delete catalog.submissions[0].qualifiedKey; },
    catalog => { catalog.submissions[0].qualifiedKey = ''; },
    catalog => { catalog.submissions[0].qualifiedKey = 'soduwork/weekly-report'; },
    catalog => { delete catalog.items[1].qualifiedKey; },
    catalog => { catalog.items[1].scope = 'platform'; },
    catalog => { catalog.items[1].key = 'different-key'; },
  ]) {
    const catalog = creatorCatalog();
    catalog.items[0].name = catalog.items[1].name;
    change(catalog);
    const view = model(catalog);
    assert.deepEqual(ids(view.items), ['local:weekly-report', 'company-report']);
    assert.ok(view.items.every(item => !item.creatorPublication));
  }
  const catalog = creatorCatalog();
  catalog.submissions[0].pluginId = 'my-other-company-report';
  const view = model(catalog);
  assert.deepEqual(ids(view.items), ['local:weekly-report', 'company-report']);
  assert.equal(view.items[0].creatorPublication.submission.pluginId, 'my-other-company-report');
  assert.equal(view.items[0].creatorPublication.company, undefined,
    'a matching key cannot substitute a different publisher record for the exact submission ID');
});

test('ambiguous local keys, submission identities and organizations remain separate', () => {
  const model = library();
  for (const kind of ['local', 'submission', 'organization']) {
    const catalog = creatorCatalog();
    if (kind === 'local') catalog.items.push({ ...catalog.items[0], pluginId: 'local:second-copy' });
    if (kind === 'submission') {
      catalog.items.push({ ...catalog.items[1], pluginId: 'second-company-report' });
      catalog.submissions.push({ ...catalog.submissions[0], pluginId: 'second-company-report' });
    }
    if (kind === 'organization') catalog.submissions.push({
      ...catalog.submissions[0], qualifiedKey: 'org:other/weekly-report', versionId: 'other-org-version',
    });
    const view = model(catalog);
    assert.deepEqual(ids(view.items), ids(catalog.items), kind);
    assert.ok(view.items.every(item => !item.creatorPublication), kind);
  }
});

test('receipt selection uses the newest submission deterministically without requiring version equality', () => {
  const model = library();
  const catalog = creatorCatalog();
  const receipt = catalog.submissions[0];
  const old = { ...receipt, version: '9.0.0', versionId: 'older-created', createdAt: 10, reviewedAt: 99 };
  const reviewed = { ...receipt, version: '2.1.0', versionId: 'latest-reviewed', reviewedAt: 30 };
  const fallback = { ...reviewed, version: '2.10.0', versionId: 'latest-version' };
  for (const submissions of [
    [old, reviewed, fallback, receipt], [receipt, fallback, reviewed, old],
  ]) {
    catalog.submissions = submissions;
    const before = JSON.stringify(catalog);
    const card = model(catalog).items[0];
    assert.equal(card.creatorPublication.submission.versionId, 'latest-version');
    assert.equal(card.version, '3.0.0');
    assert.equal(card.creatorPublication.company.version, '1.0.0');
    assert.equal(JSON.stringify(catalog), before, 'choosing a receipt must not sort the source collection');
  }
  catalog.items[1].version = '4.0.0';
  catalog.items[1].versionId = 'another-editor-version';
  assert.equal(model(catalog).items[0].creatorPublication.submission.versionId, 'latest-version');
});

test('unpublished or revoked submissions preserve local use and disappear with the current account receipt', () => {
  const model = library();
  for (const receiptState of [
    { trustState: 'quarantined', reviewDecision: '', catalogReady: false },
    { trustState: 'quarantined', reviewDecision: 'reject', catalogReady: false },
    { trustState: 'revoked', reviewDecision: 'revoke', catalogReady: false },
    { trustState: 'approved', reviewDecision: 'approve', enabled: false, catalogReady: false },
  ]) {
    const catalog = creatorCatalog();
    Object.assign(catalog.submissions[0], receiptState);
    catalog.items = [catalog.items[0]];
    const card = model(catalog, { status: 'ready' }).items[0];
    assert.equal(card.pluginId, 'local:weekly-report');
    assert.equal(card.enabled, true);
    assert.equal(card.creatorPublication.company, undefined);
    assert.equal(card.creatorPublication.submission.reviewDecision, receiptState.reviewDecision);
    catalog.submissions = [];
    assert.equal(model(catalog).items[0].creatorPublication, undefined,
      'a later account or organization catalog must not inherit a previous association');
  }
  const catalog = creatorCatalog();
  model(catalog);
  catalog.items = [catalog.items[1]];
  const view = model(catalog);
  assert.deepEqual(ids(view.items), ['company-report'], 'removing the personal draft restores the company card');
  assert.deepEqual(plain(view.counts), { all: 1, personal: 0, enterprise: 1 });
});

test('library lists each managed plugin once, excludes market-only items and keeps disabled plugins', () => {
  const model = library();
  const catalog = fixture();
  catalog.items.push({ ...catalog.items[0] }, { ...catalog.items[3] });
  const before = JSON.stringify(catalog);
  const view = model(catalog);
  assert.deepEqual(ids(view.managed), [
    'personal-ready', 'personal-disabled', 'personal-setup',
    'enterprise-ready', 'enterprise-update', 'enterprise-disabled',
  ]);
  assert.deepEqual(ids(view.items), ids(view.managed));
  assert.deepEqual(plain(view.counts), { all: 6, personal: 3, enterprise: 3 });
  assert.equal(view.source, 'all');
  assert.equal(view.status, 'all');
  assert.equal(view.category, '');
  assert.equal(view.filtered, false);
  assert.equal(JSON.stringify(catalog), before, 'rendering does not mutate the catalog');
});

test('source, category, state and text filters compose without duplicating or dropping eligible plugins', () => {
  const model = library();
  const catalog = fixture();
  const managed = catalog.items.filter(item => item.personal || item.installed);
  for (const source of ['all', 'personal', 'enterprise']) {
    for (const category of ['', 'research', 'office', 'empty']) {
      for (const status of ['all', 'ready', 'attention', 'disabled']) {
        for (const query of ['', 'helper', 'RESEARCH', 'no-match']) {
          const filters = { source, category, status, query };
          const expected = managed.filter(item =>
            (source === 'all' || (source === 'personal' ? item.personal : !item.personal)) &&
            (!category || item.marketPolicy.category === category) &&
            (status === 'all' || item.fixtureState === status) && search(item, query));
          const view = model(catalog, filters);
          assert.deepEqual(ids(view.items), ids(expected), JSON.stringify(filters));
          assert.equal(view.category, category, 'valid category remains selected even with zero results');
          assert.deepEqual(plain(view.counts), { all: 6, personal: 3, enterprise: 3 });
          assert.equal(view.filtered, source !== 'all' || category !== '' || status !== 'all' || query !== '');
        }
      }
    }
  }
});

test('classification is computed from the whole library and remains stable during search or source filtering', () => {
  const model = library();
  const catalog = fixture();
  const baseline = model(catalog);
  const categories = plain(baseline.categories);
  assert.equal(categories.find(row => row.key === 'research').count, 4);
  assert.equal(categories.find(row => row.key === 'office').count, 2);
  assert.equal(categories.find(row => row.key === 'empty').count, 0);
  const filters = { source: 'personal', category: 'office', status: 'ready', query: 'not present' };
  const view = model(catalog, filters);
  assert.deepEqual(plain(view.categories), categories);
  assert.deepEqual(ids(view.items), []);
  assert.equal(view.category, 'office');
  assert.deepEqual(filters, { source: 'personal', category: 'office', status: 'ready', query: 'not present' });
});

test('administrator category renames and disabled-but-used categories preserve stable selection', () => {
  const model = library();
  const catalog = fixture();
  catalog.categories[0] = { ...catalog.categories[0], name: 'New research name', enabled: false };
  const view = model(catalog, { category: 'research' });
  assert.equal(view.category, 'research');
  assert.equal(view.categories.find(row => row.key === 'research').name, 'New research name');
  assert.equal(view.categories.find(row => row.key === 'research').count, 4);
  assert.deepEqual(ids(view.items), ['personal-ready', 'personal-setup', 'enterprise-update', 'enterprise-disabled']);
});

test('a removed or disabled-unused category falls back without corrupting other active filters', () => {
  const model = library();
  const catalog = fixture();
  catalog.categories = catalog.categories.filter(row => row.key !== 'research');
  let view = model(catalog, { source: 'personal', category: 'research', status: 'attention', query: 'setup' });
  assert.equal(view.category, '');
  assert.equal(view.source, 'personal');
  assert.equal(view.status, 'attention');
  assert.deepEqual(ids(view.items), ['personal-setup']);
  catalog.categories.find(row => row.key === 'empty').enabled = false;
  view = model(catalog, { category: 'empty' });
  assert.equal(view.category, '');
  assert.ok(!view.categories.some(row => row.key === 'empty'));
});

test('invalid source and status filters fall back while an empty library remains usable', () => {
  const model = library();
  const view = model({ items: [], categories: [], submissions: [] }, {
    source: 'unknown', category: 'unknown', status: 'unknown', query: '',
  });
  assert.deepEqual(ids(view.managed), []);
  assert.deepEqual(ids(view.items), []);
  assert.deepEqual(plain(view.counts), { all: 0, personal: 0, enterprise: 0 });
  assert.equal(view.source, 'all');
  assert.equal(view.status, 'all');
  assert.equal(view.category, '');
  assert.equal(view.filtered, false);
});

test('duplicate plugin names remain distinct and unsafe-looking IDs or names stay inert data', () => {
  const model = library();
  const name = '<img src=x onerror="globalThis.executed=true">';
  const catalog = {
    categories: [{ key: 'constructor', name: '<svg onload="alert(1)">', enabled: true }],
    items: ['__proto__', 'constructor', 'toString', 'ordinary'].map(pluginId => ({
      pluginId, personal: true, installed: true, name, fixtureState: 'ready',
      marketPolicy: { configured: true, category: 'constructor' },
    })),
  };
  const view = model(catalog, { category: 'constructor', query: name });
  assert.deepEqual(ids(view.items), ['__proto__', 'constructor', 'toString', 'ordinary']);
  assert.equal(view.categories.find(row => row.key === 'constructor').name, catalog.categories[0].name);
  assert.equal(view.items[0].name, name, 'data stays raw until the rendering layer escapes it');
  assert.equal(Object.prototype.executed, undefined);
  assert.equal(model(catalog, { query: '.*' }).items.length, 0, 'search callback treats metacharacters as literal text');
});

test('search and availability decisions use the supplied capability callbacks', () => {
  const model = library();
  const catalog = fixture();
  const calls = [];
  const view = model(catalog, { status: 'attention', query: 'connector' }, (item, query) => {
    calls.push({ id: item.pluginId, query });
    return item.pluginId === 'enterprise-ready';
  }, item => item.pluginId === 'enterprise-ready' ? 'attention' : 'ready');
  assert.deepEqual(ids(view.items), ['enterprise-ready'], 'a connection issue overrides apparently-ready metadata');
  assert.ok(calls.some(row => row.id === 'enterprise-ready' && row.query === 'connector'));
  assert.ok(calls.every(row => row.id !== 'market-only'), 'uninstalled market plugins do not enter the library');
});

test('real plugin page keeps disabled plugins filterable when updates, setup or connections also need attention', async () => {
  const row = (pluginId, values = {}) => ({ pluginId, name: pluginId, installed: true, enabled: true, ...values });
  const catalog = { items: [
    row('disabled-update', { enabled: false, updateAvailable: true }),
    row('disabled-connection', { enabled: false, dependencyReadiness: { missingMcp: ['crm'] } }),
    row('disabled-setup', { enabled: false, setupState: 'needs_setup' }),
    row('default-disabled-update', { installationState: 'default_disabled', updateAvailable: true }),
    row('default-disabled-connection', { installationState: 'default_disabled', dependencyReadiness: { missingMcp: ['crm'] } }),
    row('default-disabled-setup', { installationState: 'default_disabled', setupState: 'needs_setup' }),
    row('personal-disabled-setup', { personal: true, enabled: false, setupState: 'needs_setup' }),
    row('enabled-update', { updateAvailable: true }),
    row('enabled-connection', { dependencyReadiness: { missingMcp: ['crm'] } }),
    row('enabled-setup', { setupState: 'needs_setup' }),
    row('enabled-ready'),
  ], categories: [], submissions: [] };
  const sandbox = { window: {}, document: { activeElement: null },
    SoduWorkAPI: { pluginCatalog: async () => catalog } };
  vm.createContext(sandbox);
  for (const file of ['plugin-catalog-format.js', 'plugin-dependency-ux.js', 'plugin-lifecycle.js',
    'panels-capability-directory.js', 'plugin-presentation.js', 'panels-capability-plugins.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  const realModel = sandbox.window.SoduWorkPluginPresentation.libraryModel;
  let currentView;
  sandbox.window.SoduWorkPluginPresentation.libraryModel = (...args) => {
    currentView = realModel(...args); return currentView;
  };
  const listeners = new Map();
  const statusControl = { addEventListener: (event, handler) => listeners.set(event, handler) };
  const content = { innerHTML: '', scrollTop: 0, contains: () => false,
    querySelector: selector => selector === '#capPluginStatus' ? statusControl : null,
    querySelectorAll: () => [] };
  const panel = sandbox.window.SoduWorkCapabilityPlugins;
  await panel.load();
  panel.render(content, '', {});
  const selectStatus = value => listeners.get('change')({ target: { value } });
  selectStatus('disabled');
  assert.deepEqual(ids(currentView.items), catalog.items.slice(0, 7).map(item => item.pluginId));
  selectStatus('attention');
  assert.deepEqual(ids(currentView.items), ['enabled-update', 'enabled-connection', 'enabled-setup']);
  selectStatus('ready');
  assert.deepEqual(ids(currentView.items), ['enabled-ready']);
  selectStatus('all');
  assert.equal(currentView.items.length, catalog.items.length);
  assert.deepEqual(plain(currentView.counts), { all: 11, personal: 1, enterprise: 10 });

  const { SoduWorkPluginDependencies: dependencies, SoduWorkPluginLifecycle: lifecycle } = sandbox.window;
  for (const [pluginId, expected] of [
    ['disabled-update', 'upgrade'], ['disabled-connection', 'connect'], ['disabled-setup', 'setup'],
  ]) {
    const item = catalog.items.find(candidate => candidate.pluginId === pluginId);
    assert.equal(lifecycle.resolve(item, dependencies.state(item)).code, expected,
      'library filtering must preserve the detailed lifecycle and recovery action');
  }
});

test('creator card renders separate versions and routes use, company detail and review to their exact records', async () => {
  const catalog = creatorCatalog();
  const [local, company] = catalog.items;
  const receipt = catalog.submissions[0];
  catalog.submissions.unshift({ ...receipt, version: '1.0.0', versionId: 'submitted-v1', createdAt: 10 });
  const used = [], details = [], submissions = [];
  const sandbox = { window: {}, document: { activeElement: null },
    SoduWorkAPI: { pluginCatalog: async () => catalog } };
  vm.createContext(sandbox);
  for (const file of ['plugin-catalog-format.js', 'plugin-dependency-ux.js', 'plugin-lifecycle.js',
    'plugin-publication-ux.js', 'panels-capability-directory.js', 'plugin-presentation.js',
    'panels-capability-plugins.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  sandbox.window.SoduWorkPluginPublication.openSubmission = (item, ctx, options) => {
    submissions.push({ item, options });
  };
  sandbox.window.PluginUIHost = {
    catalogPresentation: () => ({ notice: '', rows: [], descriptions: [], action: '' }),
    bindCatalogDetail: (layer, item) => details.push(item),
  };
  sandbox.PluginUIHost = sandbox.window.PluginUIHost;
  sandbox.window.SoduWorkPluginPresentation.detail = () => {};
  const buttons = new Map();
  const content = { innerHTML: '', scrollTop: 0, contains: () => false, querySelector: () => null,
    querySelectorAll(selector) {
      const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1];
      if (!attribute) return [];
      return Array.from(this.innerHTML.matchAll(/<button\b([^>]*)>/g)).flatMap((match, index) => {
        const attributes = Object.fromEntries(Array.from(match[1].matchAll(/([\w-]+)="([^"]*)"/g),
          entry => [entry[1], entry[2]]));
        if (!(attribute in attributes)) return [];
        if (!buttons.has(index)) {
          const listeners = new Map();
          buttons.set(index, {
            dataset: Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('data-'))
              .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])),
            listeners, addEventListener: (name, handler) => listeners.set(name, handler),
          });
        }
        return [buttons.get(index)];
      });
    },
  };
  const ctx = {
    tryPlugin: item => used.push(item),
    openModal: () => ({ querySelector: () => null, querySelectorAll: () => [] }),
  };
  const panel = sandbox.window.SoduWorkCapabilityPlugins;
  await panel.load();
  assert.equal(panel.snapshot().remoteError, undefined);
  const before = JSON.stringify(panel.snapshot());
  panel.render(content, '', ctx);
  assert.equal((content.innerHTML.match(/<article\b/g) || []).length, 1);
  assert.equal(panel.managedCount(), 1);
  assert.equal(panel.marketCount(), 1, 'the marketplace keeps the published record');
  assert.equal(panel.marketItems()[0], company);
  assert.match(content.innerHTML, /个人插件/);
  assert.match(content.innerHTML, /企业插件/);
  assert.match(content.innerHTML, /v3\.0\.0/);
  assert.match(content.innerHTML, /v2\.0\.0/);
  assert.match(content.innerHTML, /v1\.0\.0/);
  assert.match(content.innerHTML, /上架审核中/);
  const use = content.querySelectorAll('[data-plugin-use]');
  assert.equal(use.length, 1);
  assert.equal(use[0].dataset.pluginUse, local.pluginId);
  use[0].listeners.get('click')();
  assert.equal(used[0], local, 'using the card must resolve the original local execution record');
  const detail = content.querySelectorAll('[data-plugin]').find(button => button.dataset.plugin === company.pluginId);
  assert.ok(detail, 'company detail remains reachable through its original ID');
  detail.listeners.get('click')();
  assert.equal(details[0], company, 'company detail must receive the original governed record');
  const review = content.querySelectorAll('[data-plugin-submission]');
  assert.equal(review.length, 1);
  assert.equal(review[0].dataset.pluginSubmission, receipt.pluginId);
  assert.equal(review[0].dataset.pluginSubmissionVersion, receipt.versionId);
  assert.equal(review[0].dataset.pluginDraft, local.pluginId);
  review[0].listeners.get('click')();
  assert.equal(submissions[0].item, receipt, 'open the displayed submission version, not an older receipt');
  assert.equal(submissions[0].options.localPluginId, local.pluginId, 'improve keeps the exact personal draft');
  assert.equal(submissions[0].options.items, catalog.items);
  assert.equal(JSON.stringify(panel.snapshot()), before);
  delete receipt.versionId;
  buttons.clear();
  panel.render(content, '', ctx);
  const legacyReview = content.querySelectorAll('[data-plugin-submission]')[0];
  assert.equal(legacyReview.dataset.pluginSubmissionVersion, receipt.version);
  legacyReview.listeners.get('click')();
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].item, receipt, 'receipts without a version ID retain their exact version target');
  catalog.submissions = [];
  legacyReview.listeners.get('click')();
  assert.equal(submissions.length, 2, 'an old button cannot reopen a receipt absent from the current catalog');
});

test('rejected creator submissions improve only the explicit draft and offer import when that draft is missing', () => {
  const catalog = creatorCatalog();
  const intended = catalog.items[0];
  const receipt = { ...catalog.submissions[0], reviewDecision: 'reject' };
  const unrelated = { ...intended, pluginId: 'local:unrelated', key: 'unrelated', name: receipt.name };
  const sameKey = { ...intended, pluginId: 'local:replacement' };
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read('plugin-publication-ux.js'), sandbox);
  const opened = [], imported = [];
  let buttons;
  const ctx = {
    closeModal() {},
    openModal(title, subtitle, body, footer) {
      buttons = new Map(Array.from(footer.matchAll(/id="([^"]+)"/g), match => {
        const listeners = new Map();
        return [match[1], { listeners, addEventListener: (event, handler) => listeners.set(event, handler) }];
      }));
      return { querySelector: selector => buttons.get(selector.slice(1)) || null };
    },
  };
  const options = {
    items: [unrelated, intended], localPluginId: intended.pluginId,
    trustName: () => ['Rejected', 'danger'], sourceName: () => 'Organization',
    openDetail: item => opened.push(item), choosePackage: context => imported.push(context),
  };
  const open = sandbox.window.SoduWorkPluginPublication.openSubmission;
  open(receipt, ctx, options);
  assert.ok(buttons.has('capSubmissionImprove'));
  assert.ok(!buttons.has('capSubmissionImport'));
  buttons.get('capSubmissionImprove').listeners.get('click')();
  assert.equal(opened[0], intended, 'an earlier same-name draft must not receive the recovery action');
  open(receipt, ctx, { ...options, items: [unrelated, sameKey] });
  assert.ok(!buttons.has('capSubmissionImprove'), 'a missing explicit ID must not fall back to name or key');
  assert.ok(buttons.has('capSubmissionImport'));
  buttons.get('capSubmissionImport').listeners.get('click')();
  assert.deepEqual(opened, [intended]);
  assert.deepEqual(imported, [ctx]);
});

test('filter markup escapes category names and attribute values without changing their identities', () => {
  const model = library();
  const key = 'research" onfocus="alert(1)';
  const categoryName = '<img src=x onerror="alert(2)">';
  const catalog = { categories: [{ key, name: categoryName, enabled: true }], items: [{
    pluginId: 'one', personal: true, name: 'One', marketPolicy: { configured: true, category: key },
  }] };
  const view = model(catalog, { category: key });
  const html = model.presentation.libraryToolbar(view, []);
  assert.equal(view.category, key, 'the data identity is preserved');
  assert.ok(html.includes('value="research&quot; onfocus=&quot;alert(1)" selected'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes(' onfocus="'));
});

function publicationFixture() {
  const elements = new Map();
  const events = [];
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const node = {
      id, innerHTML: '', value: '', dataset: {}, listeners,
      classList: { add() {}, contains: () => false },
      addEventListener: (name, handler) => listeners.set(name, handler),
      setAttribute() {}, focus: () => events.push(['focus', id]),
      querySelector: selector => element(selector),
      querySelectorAll: selector => selector === '[data-submission]'
        ? Array.from(node.innerHTML.matchAll(/data-submission="([^"]+)" data-submission-version="([^"]*)"/g), match => {
          const button = element('record:' + match[1] + ':' + match[2]);
          button.dataset.submission = match[1];
          button.dataset.submissionVersion = match[2];
          return button;
        }) : [],
    };
    elements.set(id, node);
    return node;
  }
  const layer = element('layer');
  const owner = element('capPluginSubmissions');
  const sandbox = {
    window: {}, AbortController,
    document: { activeElement: owner, getElementById: id => element(id) },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('plugin-publication-ux.js'), sandbox);
  vm.runInContext(read('plugin-presentation.js'), sandbox);
  const ctx = {
    openModal(title, subtitle, body) { events.push(['open', title]); layer.innerHTML = body; return layer; },
    closeModal() { layer.hidden = true; events.push(['close']); },
  };
  const open = rows => sandbox.window.SoduWorkPluginPresentation.records(rows, ctx,
    () => ['Reviewing', 'pending'], (item, recordContext, back) => events.push(['detail', item, recordContext, back]));
  return { open, element, events };
}

test('publication records include all submissions and preserve search when returning from a late record', () => {
  const fixture = publicationFixture();
  const rows = Array.from({ length: 8 }, (_, index) => ({
    pluginId: 'record-' + index, name: 'Research ' + index, version: '1.0.' + index,
    trustState: 'pending', reviewNote: index === 7 ? 'Need citation evidence' : '',
  }));
  fixture.open(rows);
  const list = fixture.element('#capRecordList');
  assert.equal(list.querySelectorAll('[data-submission]').length, 8);
  const search = fixture.element('#capRecordSearch');
  search.value = 'CITATION'; search.listeners.get('input')();
  const shown = list.querySelectorAll('[data-submission]');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].dataset.submission, 'record-7');
  shown[0].listeners.get('click')();
  const detail = fixture.events.find(event => event[0] === 'detail');
  assert.equal(detail[1], rows[7], 'clicking the eighth record opens that exact submission');
  detail[3]();
  assert.equal(list.querySelectorAll('[data-submission]').length, 1, 'back navigation retains the query');
  assert.ok(fixture.element('layer').innerHTML.includes('value="CITATION"'));
  detail[2].closeModal();
  assert.deepEqual(fixture.events.at(-1), ['focus', 'capPluginSubmissions']);
});

test('publication history opens every exact version and preserves search across detail and back navigation', () => {
  const fixture = publicationFixture();
  const rows = [
    { pluginId: 'shared-plugin', versionId: 'version-2', name: 'Report', version: '2.0.0' },
    { pluginId: 'shared-plugin', versionId: 'version-1', name: 'Report', version: '1.0.0',
      reviewHistory: [{ decision: 'reject', note: 'Initial citation changes', reviewedBy: 'Reviewer' }] },
    { pluginId: 'legacy-plugin', name: 'Legacy report', version: '2.0.0' },
    { pluginId: 'legacy-plugin', name: 'Legacy report', version: '1.0.0' },
  ];
  fixture.open(rows);
  const list = fixture.element('#capRecordList');
  const buttons = list.querySelectorAll('[data-submission]');
  assert.equal(buttons.length, rows.length, 'each submitted version has its own row');
  buttons.forEach((button, index) => {
    button.listeners.get('click')();
    assert.equal(fixture.events.at(-1)[1], rows[index], 'click must not resolve the first receipt for the plugin');
  });
  const input = fixture.element('#capRecordSearch');
  input.value = 'CITATION'; input.listeners.get('input')();
  const shown = list.querySelectorAll('[data-submission]');
  assert.equal(shown.length, 1, 'historical review feedback is searchable');
  assert.equal(shown[0].dataset.submissionVersion, 'version-1');
  shown[0].listeners.get('click')();
  const detail = fixture.events.at(-1);
  assert.equal(detail[1], rows[1]);
  detail[3]();
  assert.equal(list.querySelectorAll('[data-submission]').length, 1);
  assert.equal(list.querySelectorAll('[data-submission]')[0].dataset.submissionVersion, 'version-1');
  assert.ok(fixture.element('layer').innerHTML.includes('value="CITATION"'));
});

test('submission detail retains each review decision and safely renders reviewer feedback with legacy fallback', () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read('plugin-publication-ux.js'), sandbox);
  let body;
  const ctx = { closeModal() {}, openModal(title, subtitle, html) {
    body = html;
    return { querySelector: selector => selector === '#capSubmissionClose' ? { addEventListener() {} } : null };
  } };
  const options = { trustName: () => ['Revoked', 'danger'], sourceName: () => 'Organization' };
  const receipt = { pluginId: 'report', versionId: 'version-1', version: '1.0.0', name: 'Report',
    reviewDecision: 'revoke', reviewNote: 'Latest revocation', reviewedBy: 'Latest reviewer', reviewedAt: 3000,
    reviewHistory: [
      { id: 'review-3', decision: 'revoke', note: 'Latest revocation', reviewedBy: 'Latest reviewer', reviewedAt: 3000 },
      { id: 'review-2', decision: 'approve', note: 'Approved after correction', reviewedBy: 'Approval reviewer', reviewedAt: 2000 },
      { id: 'review-1', decision: 'reject', note: '<img src=x onerror="alert(1)">',
        reviewedBy: '<script>alert(2)</script>', reviewedAt: 1000 },
    ],
  };
  const before = JSON.stringify(receipt);
  const open = sandbox.window.SoduWorkPluginPublication.openSubmission;
  open(receipt, ctx, options);
  assert.equal((body.match(/class="cap-review-feedback"/g) || []).length, 3);
  assert.ok(body.includes('审核记录'));
  assert.ok(body.includes('上架已撤销'));
  assert.ok(body.includes('审核已通过'));
  assert.ok(body.includes('审核未通过'));
  assert.ok(body.indexOf('Latest revocation') < body.indexOf('Approved after correction'));
  assert.ok(body.indexOf('Approved after correction') < body.indexOf('&lt;img'));
  assert.ok(body.includes('<p data-user-content>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>'));
  assert.ok(body.includes('<span data-user-content>&lt;script&gt;alert(2)&lt;/script&gt;</span>'));
  for (const reviewedAt of [1000, 2000, 3000]) assert.ok(body.includes(new Date(reviewedAt).toLocaleString()));
  assert.ok(!/<img|<script|onerror="/.test(body));
  assert.equal(JSON.stringify(receipt), before);
  for (const reviewHistory of [undefined, [], {}, [null]]) {
    open({ ...receipt, reviewHistory, reviewNote: '<legacy feedback>', reviewedBy: '<legacy reviewer>' }, ctx, options);
    assert.equal((body.match(/class="cap-review-feedback"/g) || []).length, 1);
    assert.ok(body.includes('&lt;legacy feedback&gt;'));
    assert.ok(body.includes('&lt;legacy reviewer&gt;'));
    assert.ok(!body.includes('cap-review-history'));
  }
  open({ ...receipt, reviewHistory: [], reviewDecision: '', reviewNote: '', reviewedAt: 0 }, ctx, options);
  assert.ok(body.includes('管理员还没有给出审查结论。'));
});

test('publication records show distinct empty states and escape plugin and review content', () => {
  const fixture = publicationFixture();
  fixture.open([]);
  const list = fixture.element('#capRecordList');
  assert.ok(list.innerHTML.includes('还没有提交申请'));
  fixture.open([{
    pluginId: 'unsafe-id" onmouseover="alert(1)', name: '<img src=x onerror="alert(2)">',
    version: '<svg>', reviewNote: '<script>alert(3)</script>', trustState: 'pending',
  }]);
  assert.ok(list.innerHTML.includes('unsafe-id&quot; onmouseover=&quot;alert(1)'));
  assert.ok(list.innerHTML.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'));
  assert.ok(list.innerHTML.includes('&lt;script&gt;alert(3)&lt;/script&gt;'));
  assert.ok(!/<img|<script|onmouseover="/.test(list.innerHTML));
  const search = fixture.element('#capRecordSearch');
  search.value = 'missing'; search.listeners.get('input')();
  assert.ok(list.innerHTML.includes('没有匹配的申请'));
});
