import { briefsJourney, requirementsJourney, catalogJourney } from './user-journeys-catalog.mjs';
import {
  CdpPage,
  delay,
  listPages,
  waitForPage,
  waitForPageGone,
} from './lib/cdp.mjs';

const options = Object.fromEntries(process.argv.slice(2).map((item) => {
  const split = item.replace(/^--/, '').split('=');
  return [split.shift(), split.join('=') || '1'];
}));
const PORT = Number(options.port || process.env.SODUWORK_E2E_CDP || 9222);
let HUB = String(options.hub || process.env.SODUWORK_E2E_HUB || 'http://127.0.0.1:9080');
while (HUB.endsWith('/')) HUB = HUB.slice(0, -1);
const startedAt = Date.now();
const token = startedAt.toString(36) + Math.random().toString(36).slice(2, 7);
const taskTitle = '【E2E 用户旅程】任务创建与跟踪 ' + token;
const conversationTaskTitle = '【E2E 用户旅程】会话沉淀任务 ' + token;
const requirementTitle = 'E2E Requirement Pool ' + token;

let passed = 0;
let failed = 0;
let main = null;
let taskId = '';
let conversationTaskId = '';
let requirementId = '';
let requirementTaskId = '';
let addTarget = null;
let detailTarget = null;
let journeyStep = '';

function assert(condition, message, evidence) {
  if (condition) return;
  const suffix = evidence === undefined ? '' : '；现场=' + JSON.stringify(evidence);
  throw new Error(message + suffix);
}

async function journey(id, name, action) {
  if (options.only && !options.only.split(',').includes(id)) return;
  journeyStep = id;
  const begin = Date.now();
  if (main) main.takeRuntimeErrors();
  try {
    await action();
    const runtimeErrors = main ? main.takeRuntimeErrors() : [];
    assert(runtimeErrors.length === 0, '页面产生运行异常', runtimeErrors);
    passed += 1;
    console.log('  PASS  ' + id + ' ' + name + ' (' + (Date.now() - begin) + 'ms)');
  } catch (error) {
    failed += 1;
    console.error('  FAIL  ' + id + ' ' + name + ' (' + (Date.now() - begin) + 'ms)');
    console.error('        ' + String(error && error.message || error) + (journeyStep ? '；阶段：' + journeyStep : ''));
  }
}

async function navigate(view, timeoutMs = 3000) {
  let clicked = await main.run((key) => {
    const button = document.querySelector('.ws-nav-item[data-view="' + key + '"]');
    if (!button) return false;
    button.click();
    return true;
  }, view);
  if (!clicked) {
    /*
     * Return home before selecting home navigation after settings mode, matching the actual
     * user journey.
     */
    const returned = await main.run(() => {
      const button = document.querySelector('#wsBack');
      if (!button || getComputedStyle(button).display === 'none') return false;
      button.click();
      return true;
    });
    if (returned) {
      await main.waitFor(() => document.querySelector('.ws-nav-item[data-view="create"]'), null, timeoutMs);
      clicked = await main.run((key) => {
        const button = document.querySelector('.ws-nav-item[data-view="' + key + '"]');
        if (!button) return false;
        button.click();
        return true;
      }, view);
    }
  }
  assert(clicked, '找不到主菜单：' + view);
  await main.waitFor((key) => {
    const button = document.querySelector('.ws-nav-item.active');
    return button && button.dataset.view === key;
  }, view, timeoutMs);
}

async function newWindow(fragment, beforeIds, timeoutMs = 4000) {
  return waitForPage(PORT, (row) =>
    row.url.includes(fragment) && !beforeIds.has(row.id), timeoutMs);
}

async function openRequirementJourney(id, title) {
  await main.run((query) => {
    const scope = document.querySelector('[data-rq-scope="all"]');
    if (scope?.getClientRects().length) scope.click();
    else { const select = document.querySelector('#rqScope'); select.value = 'all'; select.dispatchEvent(new Event('change', { bubbles: true })); }
    const kind = document.querySelector('#rqKind'); kind.value = ''; kind.dispatchEvent(new Event('change', { bubbles: true }));
    const input = document.querySelector('#hbSearch'); input.value = query; input.dispatchEvent(new Event('input', { bubbles: true }));
  }, title);
  await main.waitFor((wanted) => {
    const card = document.querySelector('.rq-card[data-hbid="' + wanted + '"]');
    if (!card) return false;
    const lane = card.closest('[data-rq-lane]');
    const toggle = lane?.querySelector('[data-rq-collapse][aria-expanded="false"]');
    if (toggle) { toggle.click(); return false; }
    return !!card.querySelector('[data-rq-open]')?.getClientRects().length;
  }, id, 5000);
  await main.run((wanted) => document.querySelector(
    '.rq-card[data-hbid="' + wanted + '"] [data-rq-open]').click(), id);
  const summary = await main.waitFor(() => {
    const root = document.querySelector('.rq-detail');
    const title = root?.querySelector('[name="title"]')?.value ||
      root?.querySelector('h3[data-user-content]')?.textContent.trim();
    if (!title) return false;
    const action = root.querySelector('[data-rq-journey]');
    return { title, canOpen: !!action && !action.disabled && !!action.getClientRects().length };
  }, null, 6000);
  assert(summary.title === title, '需求详情没有打开所选的工作记录', summary);
  assert(summary.canOpen, '当前账号没有可用的执行详情入口', summary);
  await main.run(() => document.querySelector('.rq-detail [data-rq-journey]').click());
  await main.waitFor(() => !document.querySelector('.rq-detail-backdrop'), null, 3000);
}

async function closeTarget(target) {
  if (!target) return;
  const rows = await listPages(PORT);
  if (!rows.some((row) => row.id === target.id)) return;
  const page = await CdpPage.connect(target);
  try {
    await page.run(() => {
      setTimeout(() => {
        if (window.soduWorkAPI && soduWorkAPI.closeDeskWindow) soduWorkAPI.closeDeskWindow();
        else window.close();
      }, 0);
      return true;
    });
  } catch (_error) {
    // Closing the page can end the CDP channel before Chromium returns the result.
  } finally {
    page.close();
  }
  await waitForPageGone(PORT, target.id, 3000);
}

async function reopenWorkspace(view = 'history') {
  const previous = main && main.target;
  assert(previous, '没有可重开的 SoduWork 主工作窗');
  const pages = await listPages(PORT);
  const overlayTarget = pages.find((row) => row.url.endsWith('/index.html'));
  assert(overlayTarget, '桌宠宿主页不存在，无法验证主工作窗恢复', pages.map((row) => row.url));
  const overlay = await CdpPage.connect(overlayTarget);
  const previousErrors = main.takeRuntimeErrors();
  assert(previousErrors.length === 0, '关闭主工作窗前页面已有运行异常', previousErrors);
  try {
    try {
      await main.run(() => {
        setTimeout(() => soduWorkAPI.closeDeskWindow(), 0);
        return true;
      });
    } catch (_error) {
      // Closing the window can end the CDP channel before Chromium returns the result.
    }
    main.close();
    assert(await waitForPageGone(PORT, previous.id, 3500), '主工作窗没有正常关闭');
    const opened = await overlay.run((targetView) => {
      if (!(window.soduWorkAPI && soduWorkAPI.openDeskWindow)) return false;
      soduWorkAPI.openDeskWindow({ panel: 'workspace', view: targetView });
      return true;
    }, view);
    assert(opened, '桌宠宿主无法重新打开 SoduWork 主工作窗');
    const target = await waitForPage(PORT,
      (row) => row.url.includes('panel=workspace'), 4000);
    main = await CdpPage.connect(target);
    await main.waitFor(() => {
      const shell = document.querySelector('.workspace-shell');
      return shell && getComputedStyle(shell).display !== 'none' &&
        shell.getBoundingClientRect().width > 0;
    }, null, 3500);
    return { previousId: previous.id, currentId: target.id };
  } finally {
    overlay.close();
  }
}

async function findTaskOnServer(title) {
  return main.waitFor(async (wanted) => {
    const rows = await SoduWorkAPI.getTasks();
    const matches = rows.filter((item) => item.title === wanted);
    const task = matches[0];
    return task ? {
      id: task.id,
      title: task.title,
      status: task.status,
      actualStart: task.actualStart || 0,
      matches: matches.length,
    } : false;
  }, title, 6000, 160);
}

async function cleanupNamedTask(id, title) {
  if (!main || !title) return;
  await navigate('create');
  const result = await main.run(async (wanted) => {
    let rows = await SoduWorkAPI.getTasks();
    const ids = new Set();
    if (wanted.id) ids.add(wanted.id);
    rows.filter((item) => item.title === wanted.title).forEach((item) => ids.add(item.id));
    Store.tasks.filter((item) => item.title === wanted.title).forEach((item) => ids.add(item.id));
    for (const id of ids) {
      const local = Store.tasks.find((item) => item.id === id);
      if (local) {
        Store.removeTask(id, 0);
        await Store._flushTaskOps();
        for (let attempt = 0; attempt < 50; attempt++) {
          rows = await SoduWorkAPI.getTasks();
          if (!rows.some(item => item.id === id)) break;
          await new Promise(resolve => setTimeout(resolve, 120));
        }
      } else if (rows.some(item => item.id === id)) {
        await SoduWorkAPI.deleteTask(id);
      }
      Store.dropTask(id);
    }
    rows = await SoduWorkAPI.getTasks();
    return {
      removed: Array.from(ids),
      serverGone: !rows.some((item) => ids.has(item.id) || item.title === wanted.title),
      clientGone: !Store.tasks.some((item) => ids.has(item.id) || item.title === wanted.title),
    };
  }, { id, title }, 15000);
  assert(result.serverGone && result.clientGone, 'E2E 临时任务未清理干净', result);
  return result;
}

async function cleanupTask() {
  await cleanupNamedTask(taskId, taskTitle);
  taskId = '';
}

async function cleanupConversationTask() {
  await cleanupNamedTask(conversationTaskId, conversationTaskTitle);
  conversationTaskId = '';
}

async function cleanupRequirement() {
  if (!main || !requirementTitle) return;
  await cleanupNamedTask(requirementId, requirementTitle);
  requirementId = '';
  requirementTaskId = '';
}

async function boot() {
  const health = await fetch(HUB + '/healthz');
  assert(health.ok, 'Hub 健康检查失败', health.status);
  const target = await waitForPage(PORT, (row) =>
    row.url.includes('desk.html?panel=workspace'), 6000);
  main = await CdpPage.connect(target);
  /*
   * Clear test-only windows before each run because openDeskWindow reuses existing panel
   * windows rather than creating new targets.
   */
  const stale = (await listPages(PORT)).filter((row) =>
    row.url.includes('panel=add') || row.url.includes('panel=detail'));
  for (const row of stale) await closeTarget(row);
}

async function run() {
  console.log('SoduWork 用户端到端旅程 · Electron ' + PORT + ' · ' + HUB);
  await boot();
  const journeyContext = {
    journey, navigate, assert, requirementTitle, findTaskOnServer, cleanupNamedTask,
    get main() { return main; },
    set step(value) { journeyStep = value; },
    get requirementId() { return requirementId; }, set requirementId(value) { requirementId = value; },
    get requirementTaskId() { return requirementTaskId; }, set requirementTaskId(value) { requirementTaskId = value; },
  };

  await journey('UJ-01', '打开客户端即可工作', async () => {
    const state = await main.run(() => {
      const visible = (node) => !!node && getComputedStyle(node).display !== 'none' &&
        node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
      const errorBox = document.querySelector('#__errBox');
      return {
        title: document.title,
        blankHidden: !visible(document.querySelector('#deskBlank')),
        shellVisible: visible(document.querySelector('.workspace-shell')),
        hub: document.querySelector('#wsHubState') &&
          document.querySelector('#wsHubState').textContent.trim(),
        nav: Array.from(document.querySelectorAll('.ws-nav-item')).map((node) => {
          const label = node.querySelector(':scope > span');
          return (label ? label.textContent : node.textContent).trim();
        }),
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        errorVisible: visible(errorBox) && !!errorBox.textContent.trim(),
      };
    });
    const expected = ['新对话', '自动化', '插件', '资料库', '通知', '需求池'];
    assert(state.title.startsWith('SoduWork'), '窗口品牌不正确', state);
    assert(state.blankHidden && state.shellVisible, '主界面仍停在加载底板', state);
    assert(state.hub.includes('已连接'), '用户看不到明确的服务连接状态', state);
    assert(JSON.stringify(state.nav.slice(0, expected.length)) === JSON.stringify(expected),
      '常用菜单顺序或命名不符合产品约定', state.nav);
    assert(!state.horizontalOverflow, '主窗口出现了横向溢出', state);
    assert(!state.errorVisible, '客户端错误框可见', state);
  });

  await journey('UJ-02', '临时对话不会强迫用户创建任务', async () => {
    const before = await main.run(async () => (await SoduWorkAPI.getTasks()).length);
    await navigate('create');
    const state = await main.waitFor(() => {
      const panel = document.querySelector('#composePanel');
      const input = document.querySelector('#cpInput');
      if (!panel || !input || getComputedStyle(panel).display === 'none') return false;
      const card = Array.from(document.querySelectorAll('.cp-card')).some((node) =>
        getComputedStyle(node).display !== 'none');
      return {
        hero: document.querySelector('.cp-hero') && document.querySelector('.cp-hero').textContent.trim(),
        placeholder: input.getAttribute('placeholder') || '',
        taskCardVisible: card,
      };
    }, null, 3000);
    const after = await main.run(async () => (await SoduWorkAPI.getTasks()).length);
    assert(state.hero === '想让 SoduWork 做什么？', '新建入口没有回到自然对话起手式', state);
    assert(state.placeholder.includes('告诉 SoduWork') && state.placeholder.includes('完成'),
      '输入框没有给用户自然表达的提示', state);
    assert(!state.taskCardVisible, '用户尚未要求建任务却出现了任务卡', state);
    assert(before === after, '仅打开对话就产生了任务', { before, after });
  });

  await journey('UJ-03', '会话可以按需沉淀为一条任务', async () => {
    const before = await main.run(async () => (await SoduWorkAPI.getTasks()).length);
    await navigate('create');
    const sent = await main.run((description) => {
      const input = document.querySelector('#cpInput');
      const send = document.querySelector('#cpGo');
      if (!input || !send) return false;
      input.value = '/任务 ' + description;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      send.click();
      return true;
    }, '整理本周客户反馈，形成一项可以跟踪、可以验收的改进任务。');
    assert(sent, '新建入口无法发送 /任务 工作动作');

    const proposal = await main.waitFor(() => {
      const layer = document.querySelector('#workEntryLayer.show');
      const host = document.querySelector('#wesTaskDraft');
      const title = host && host.querySelector('#cpTitle');
      const note = host && host.querySelector('#cpNote');
      const create = host && host.querySelector('#cpCreate');
      if (!layer || !title || !note || !create || create.disabled) return false;
      const surface = layer.closest('[data-plugin-surface="work-entry"]');
      const prompt = surface && surface.previousElementSibling;
      return {
        inline: !!(surface && surface.classList.contains('pui-surface-inline')),
        heading: layer.querySelector('#wesTitle') && layer.querySelector('#wesTitle').textContent.trim(),
        prompt: prompt && prompt.classList.contains('pui-turn-prompt') ? prompt.textContent.trim() : '',
        editable: !title.disabled && !note.disabled,
      };
    }, null, 70000, 200);
    assert(proposal.inline, '任务表单没有作为插件 UI 出现在对话区域', proposal);
    assert(proposal.heading === '创建任务' && proposal.editable,
      '会话沉淀任务没有进入可编辑确认态', proposal);
    assert(proposal.prompt.includes('/任务'), '用户原始输入没有留在任务表单上方', proposal);

    const filled = await main.run((payload) => {
      const host = document.querySelector('#wesTaskDraft');
      if (!host) return { ok: false, reason: 'missing-host' };
      const who = host.querySelector('[data-selbtn="who"]');
      if (!who) return { ok: false, reason: 'missing-who' };
      who.click();
      const me = host.querySelector('[data-selv="who|me"]');
      if (!me) return { ok: false, reason: 'missing-me' };
      me.click();
      const add = () => host.querySelector('#cpCkAdd');
      while (host.querySelectorAll('.cp-ck-t').length < 2 && add()) add().click();
      const set = (selector, value) => {
        const field = host.querySelector(selector);
        if (!field) return false;
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const checks = host.querySelectorAll('.cp-ck-t');
      const ok = set('#cpTitle', payload.title) &&
        set('#cpNote', payload.note) && checks.length >= 2;
      if (checks[0]) set('.cp-ck-t[data-ck="0"]', payload.checks[0]);
      if (checks[1]) set('.cp-ck-t[data-ck="1"]', payload.checks[1]);
      return {
        ok,
        title: host.querySelector('#cpTitle') && host.querySelector('#cpTitle').value,
        note: host.querySelector('#cpNote') && host.querySelector('#cpNote').value,
        checks: Array.from(host.querySelectorAll('.cp-ck-t')).map((node) => node.value),
        who: host.querySelector('[data-selbtn="who"]') &&
          host.querySelector('[data-selbtn="who"]').textContent.replace(/\s+/g, ' ').trim(),
      };
    }, {
      title: conversationTaskTitle,
      note: '汇总本周客户反馈，明确负责人，并保留从会话到任务的来源。',
      checks: ['至少归纳三类客户问题', '形成可复核的处理结论'],
    });
    assert(filled.ok && filled.title === conversationTaskTitle,
      '会话任务确认表单无法完整编辑', filled);
    assert(filled.checks.includes('至少归纳三类客户问题') &&
      filled.checks.includes('形成可复核的处理结论'), '验收标准没有进入任务确认表单', filled);
    assert(filled.who.includes('我自己'), '验收任务没有明确留给当前用户', filled);

    await main.run(() => {
      const button = document.querySelector('#wesTaskDraft #cpCreate');
      button.click();
      button.click();
      return true;
    });
    const created = await findTaskOnServer(conversationTaskTitle);
    conversationTaskId = created.id;
    await main.waitFor((id) => {
      const state = window.NativeChat && NativeChat.sessionInfo();
      return state && state.collaboration && state.taskIds.includes(id) &&
        document.querySelector('#nchatCollab [data-task-id="' + id + '"]');
    }, conversationTaskId, 20000, 160);
    const truth = await main.run(async (wanted) => {
      const rows = await SoduWorkAPI.getTasks();
      const matches = rows.filter((item) => item.title === wanted);
      return { count: rows.length, matches: matches.length, task: matches[0] || null };
    }, conversationTaskTitle);
    assert(truth.count === before + 1 && truth.matches === 1,
      '会话确认后没有且仅生成一条任务', { before, truth });
    assert(truth.task.status === 'todo' && truth.task.note.includes('至少归纳三类客户问题') &&
      truth.task.note.includes('形成可复核的处理结论'), '任务没有保存状态、说明或验收标准', truth.task);
    await cleanupConversationTask();
  });

  await journey('UJ-04', '从需求池创建、打开并开始任务', async () => {
    await navigate('history');
    await main.waitFor(() => {
      const panel = document.querySelector('#historyBoard');
      return panel && panel.classList.contains('show') && document.querySelector('#hbAdd');
    }, null, 3000);

    const clickedAt = Date.now();
    await main.run(() => {
      document.querySelector('#hbAdd').click();
      return true;
    });
    assert(Date.now() - clickedAt < 2000, '新建任务入口打开超过 2 秒');
    const addPage = main;
    try {
      await addPage.waitFor(() => {
        return document.querySelector('#workEntryLayer.show #wesTaskDraft #cpTitle');
      }, null, 8000);
      const formState = await addPage.run((payload) => {
        const set = (selector, value) => {
          const input = document.querySelector(selector);
          if (!input) return false;
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        const who = document.querySelector('#wesTaskDraft [data-selbtn="who"]');
        if (who) { who.click(); document.querySelector('#wesTaskDraft [data-selv="who|me"]')?.click(); }
        const ok = set('#cpTitle', payload.title) &&
          set('#cpNote', '验证对话内提交后任务不丢、详情可打开、状态可流转。');
        return {
          ok,
          titleVisible: document.querySelector('#cpTitle').getBoundingClientRect().height > 0,
          submitLabel: document.querySelector('#cpCreate').textContent.trim(),
        };
      }, { title: taskTitle });
      assert(formState.ok && formState.titleVisible, '任务表单字段不可正常填写', formState);
      assert(formState.submitLabel.length > 0, '任务表单没有明确提交动作', formState);
      /*
       * Click once and await idempotent asynchronous persistence and window closure before
       * disconnecting CDP.
       */
      await addPage.run(() => {
        const button = document.querySelector('#wesTaskDraft #cpCreate');
        if (!button) return false;
        button.click();
        return true;
      });
      /*
       * Keep the page connected through execution matching, persistence, and attachment
       * preparation until the app closes it; avoid fixed short delays.
       */
      await findTaskOnServer(taskTitle);
    } finally {
      // The composer shares the workspace; do not close the user's chat.
      addTarget = null;
    }
    const task = await findTaskOnServer(taskTitle);
    taskId = task.id;
    await main.waitFor((id) => {
      const state = window.NativeChat?.sessionInfo?.();
      return state?.taskIds?.includes(id) && !document.querySelector('#workEntryLayer.show');
    }, taskId, 8000);
    assert(task.matches === 1, '连续点击提交生成了重复任务', task);
    assert(task.status === 'todo', '新任务的初始状态不正确', task);

    await navigate('history');
    await openRequirementJourney(taskId, taskTitle);
    const detail = main;
    try {
      const detailState = await detail.waitFor((title) => {
        const heading = document.querySelector('#dTitle');
        const flow = document.querySelector('.tfd-shell');
        if (!heading || heading.textContent.trim() !== title || !flow) return false;
        return {
          title: heading.textContent.trim(),
          phases: document.querySelectorAll('.tfd-loop-list li').length,
          flowEmpty: flow.classList.contains('tfd-empty'),
          status: document.querySelector('[data-chip="st"]') &&
            document.querySelector('[data-chip="st"]').textContent.trim(),
        };
      }, taskTitle, 7000);
      assert(detailState.phases === 0, '普通人工任务不应伪造 AI 自动执行阶段', detailState);
      assert(!detailState.flowEmpty, '任务全链路加载失败', detailState);
      assert(detailState.status === '待办', '任务详情状态不正确', detailState);

      await detail.run(() => {
        document.querySelector('[data-chip="st"]').click();
        document.querySelector('#pickSt [data-st="doing"]').click();
        return true;
      });
      const doing = await main.waitFor(async (id) => {
        const rows = await SoduWorkAPI.getTasks();
        const task = rows.find((item) => item.id === id);
        return task && task.status === 'doing' ? {
          status: task.status,
          actualStart: task.actualStart || 0,
        } : false;
      }, taskId, 6000, 180);
      assert(doing.actualStart > 0, '任务开始后没有记录实际开始时间', doing);
      await navigate('history');
      await main.waitFor((id) => !!document.querySelector(
        '.rq-lane[data-rq-lane="delivering"] .rq-card[data-hbid="' + id + '"]'), taskId, 4000);
      const detailErrors = detail.takeRuntimeErrors();
      assert(detailErrors.length === 0, '任务详情产生页面异常', detailErrors);
    } finally {
      await detail.run(() => { if (typeof closeDetail === 'function') closeDetail(); return true; }).catch(() => {});
    }
  });

  await journey('UJ-05', '人与 AI 转派入口只提供当前环境真实可用对象', async () => {
    await navigate('history');
    await openRequirementJourney(taskId, taskTitle);
    const detail = main;
    try {
      await detail.waitFor((title) => {
        const heading = document.querySelector('#dTitle');
        return heading && heading.textContent.trim() === title &&
          document.querySelector('#detailFwd');
      }, taskTitle, 6000);
      await detail.run(() => {
        document.querySelector('#detailFwd').click();
        return true;
      });
      const ai = await detail.waitFor(async (id) => {
        const pop = document.querySelector('#fwdPop');
        const list = document.querySelector('#fwdList');
        const rows = Array.from(document.querySelectorAll('.fwd-item[data-fwd-choice="direct"]'));
        const options = await SoduWorkAPI.taskExecutionOptions({ taskId: id });
        const substrates = (options && options.substrates || []).filter((item) => item && item.key);
        const workflowRequired = !!(options && options.recommendation &&
          options.recommendation.workflowRequired);
        if (!pop || !list || getComputedStyle(pop).display === 'none' ||
            list.querySelector('.fwd-loading') ||
            (!workflowRequired && rows.length < substrates.length)) {
          return false;
        }
        return {
          tabs: Array.from(document.querySelectorAll('.fwd-tab')).map((node) => node.textContent.trim()),
          workflowRequired,
          availableIds: substrates.filter((item) => item.available !== false)
            .map((item) => item.key).sort(),
          unavailableIds: substrates.filter((item) => item.available === false)
            .map((item) => item.key).sort(),
          shownIds: rows.filter((node) => !node.disabled)
            .map((node) => node.dataset.aid).sort(),
          disabledIds: rows.filter((node) => node.disabled)
            .map((node) => node.dataset.aid).sort(),
          listText: list.textContent.trim(),
        };
      }, taskId, 12000);
      assert(ai.tabs.some((label) => label.includes('交给 AI')) &&
        ai.tabs.some((label) => label.includes('转给同事')),
      '转派入口没有把 AI 与同事放在同一个用户动作中', ai);
      if (ai.workflowRequired) {
        assert(ai.shownIds.length === 0,
          '必须走企业工作流的任务仍展示了可绕过流程的直接 Agent', ai);
      } else {
        assert(JSON.stringify(ai.shownIds) === JSON.stringify(ai.availableIds),
          '当前设备可用 Agent 没有被准确列为可派活对象', ai);
        assert(ai.unavailableIds.every((id) => ai.disabledIds.includes(id)),
          '能力不满足或离线的 Agent 仍可被点击派活', ai);
      }

      await detail.run(() => {
        document.querySelector('.fwd-tab[data-fwdtab="mate"]').click();
        return true;
      });
      const mates = await detail.waitFor(async () => {
        const list = document.querySelector('#fwdList');
        const rows = Array.from(document.querySelectorAll('.fwd-item[data-fwd-choice="mate"]'));
        if (!list) return false;
        const roster = await SoduWorkAPI.listTeammates();
        const expected = roster.mates || [];
        const availableExpected = expected.filter((item) => item.canReceive === true ||
          (item.canReceive === undefined && item.hasBox));
        if (rows.length < availableExpected.length) return false;
        return {
          availableIds: expected.filter((item) => item.canReceive === true ||
            (item.canReceive === undefined && item.hasBox))
            .map((item) => item.id).sort(),
          unavailableIds: expected.filter((item) => item.canReceive === false ||
            (item.canReceive === undefined && !item.hasBox))
            .map((item) => item.id).sort(),
          enabledIds: rows.filter((node) => !node.disabled)
            .map((node) => node.dataset.aid).sort(),
          disabledIds: rows.filter((node) => node.disabled)
            .map((node) => node.dataset.aid).sort(),
          emptyReason: rows.length ? '' : list.textContent.trim(),
        };
      }, null, 12000);
      assert(JSON.stringify(mates.enabledIds) === JSON.stringify(mates.availableIds),
        '已安装 SoduWork 的同事没有被准确列为可转派对象', mates);
      await detail.run(() => {
        const all = document.querySelector('[data-fwd-mate-filter="all"]');
        if (all) all.click();
        return true;
      });
      const allMates = await detail.waitFor(async () => {
        const rows = Array.from(document.querySelectorAll('.fwd-item[data-fwd-choice="mate"]'));
        const roster = await SoduWorkAPI.listTeammates();
        const expected = roster.mates || [];
        if (rows.length < expected.length) return false;
        return {
          unavailableIds: expected.filter((item) => item.canReceive === false ||
            (item.canReceive === undefined && !item.hasBox))
            .map((item) => item.id).sort(),
          disabledIds: rows.filter((node) => node.disabled)
            .map((node) => node.dataset.aid).sort(),
        };
      }, null, 6000);
      assert(allMates.unavailableIds.every((id) => allMates.disabledIds.includes(id)),
        '切换全部成员后不可接收的同事没有保持禁用', allMates);
      const task = await detail.run(async (id) => {
        const rows = await SoduWorkAPI.getTasks();
        const matches = rows.filter((item) => item.id === id);
        return { matches: matches.length, status: matches[0] && matches[0].status };
      }, taskId);
      assert(task.matches === 1 && task.status === 'doing',
        '只查看转派对象就意外改写了任务', task);
      const detailErrors = detail.takeRuntimeErrors();
      assert(detailErrors.length === 0, '转派入口产生页面异常', detailErrors);
    } finally {
      await detail.run(() => {
        const button = document.querySelector('#detailFwd');
        if (button && document.querySelector('#fwdPop')?.style.display !== 'none') button.click();
        return true;
      }).catch(() => {});
    }
  });

  await briefsJourney(journeyContext);

  await journey('UJ-09', '重开主工作窗后任务和执行阶段不丢失', async () => {
    const before = await findTaskOnServer(taskTitle);
    assert(before.id === taskId && before.status === 'doing' && before.actualStart > 0,
      '故障恢复前的任务基线不完整', before);
    const windows = await reopenWorkspace('history');
    assert(windows.previousId !== windows.currentId, '主工作窗没有真正重建', windows);
    await navigate('history');
    await main.waitFor((id) => {
      const card = document.querySelector('.rq-lane[data-rq-lane="delivering"] .rq-card[data-hbid="' + id + '"]');
      return card && card.querySelector('.rq-card-title').textContent.trim();
    }, taskId, 5000);
    const after = await findTaskOnServer(taskTitle);
    assert(after.matches === 1, '重开窗口后产生了重复任务或重复派活记录', after);
    assert(after.id === before.id && after.status === before.status &&
      after.actualStart === before.actualStart,
    '重开窗口后任务身份、状态或开始时间发生倒退', { before, after });

    await openRequirementJourney(taskId, taskTitle);
    const detail = main;
    try {
      const restored = await detail.waitFor((title) => {
        const heading = document.querySelector('#dTitle');
        const flow = document.querySelector('.tfd-shell');
        const chip = document.querySelector('[data-chip="st"]');
        if (!heading || heading.textContent.trim() !== title || !flow || !chip) return false;
        if (flow.classList.contains('is-loading') || flow.textContent.includes('正在加载')) return false;
        return {
          title: heading.textContent.trim(),
          status: chip.textContent.trim(),
          flowEmpty: flow.classList.contains('tfd-empty'),
        };
      }, taskTitle, 7000);
      assert(restored.status === '进行中' && !restored.flowEmpty,
        '恢复后的任务详情没有回到真实阶段', restored);
      const detailErrors = detail.takeRuntimeErrors();
      assert(detailErrors.length === 0, '恢复后的任务详情产生页面异常', detailErrors);
    } finally {
      await detail.run(() => { if (typeof closeDetail === 'function') closeDetail(); return true; }).catch(() => {});
    }
  });

  await requirementsJourney(journeyContext);

  await catalogJourney(journeyContext);

  await journey('DATA', '测试任务按客户端优先顺序清理', async () => {
    await cleanupTask();
  });

  await journey('UJ-06', 'AI 办公区展示真实执行入口和状态', async () => {
    await main.run(() => WorkspaceHost.open('aidesk', {}));
    const office = await main.waitFor(() => {
      const panel = document.querySelector('#aiDeskPanel');
      if (!panel || !panel.classList.contains('show')) return false;
      return {
        text: panel.textContent.split(String.fromCharCode(10)).join(' ').replace(/ +/g, ' ').trim(),
        loading: !!panel.querySelector('.loading, .skeleton'),
      };
    }, null, 5000);
    assert(!office.loading, 'AI 办公区一直停在加载态', office);
    assert(office.text.includes('AI') &&
      ['任务', '工作', '干活', '里程碑'].some((word) => office.text.includes(word)),
      'AI 办公区没有说明用户正在看什么', office.text.slice(0, 240));

  });

  await journey('UJ-07', '待确认入口回到需求池和原对话，不再打开旧门禁页', async () => {
    await navigate('history');
    await main.waitFor(() => document.querySelector('#hbApprovalInbox'));
    await main.run(() => document.querySelector('#hbApprovalInbox').click());
    const approval = await main.waitFor(() => {
      const panel = document.querySelector('#taskApprovalInbox');
      if (!panel?.matches(':popover-open') || panel.textContent.includes('正在读取')) return false;
      return {
        title: panel.querySelector('header b')?.textContent,
        unavailable: !!panel.querySelector('[role="alert"]'),
        rowsHaveTasks: [...panel.querySelectorAll('[data-confirmation-task]')].every(row => !!row.dataset.confirmationTask),
        legacy: !!document.getElementById('apPanel'),
      };
    }, null, 6000);
    assert(!approval.unavailable && !approval.legacy && approval.rowsHaveTasks, '待确认列表没有正确连接任务会话', approval);
    assert(approval.title === '待我确认', '待确认入口文案错误', approval);
    await main.run(() => document.querySelector('[data-confirmation-close]').click());
    await main.waitFor(() => !document.querySelector('#taskApprovalInbox')?.matches(':popover-open'));
  });
}

try {
  await run();
} catch (error) {
  failed += 1;
  console.error('  FAIL  BOOT 产品旅程无法开始');
  console.error('        ' + String(error && error.message || error));
} finally {
  try { await closeTarget(detailTarget); } catch (error) {
    failed += 1;
    console.error('  FAIL  清理任务详情窗：' + error.message);
  }
  try { await closeTarget(addTarget); } catch (error) {
    failed += 1;
    console.error('  FAIL  清理任务创建窗：' + error.message);
  }
  try { await cleanupConversationTask(); } catch (error) {
    failed += 1;
    console.error('  FAIL  清理会话沉淀任务：' + error.message);
  }
  try { await cleanupTask(); } catch (error) {
    failed += 1;
    console.error('  FAIL  清理临时任务：' + error.message);
  }
  try { await cleanupRequirement(); } catch (error) {
    failed += 1;
    console.error('  FAIL  清理需求池测试数据：' + error.message);
  }
  if (main) main.close();
}

console.log('');
console.log('用户旅程结果：' + passed + ' 通过，' + failed + ' 失败；总耗时 ' +
  (Date.now() - startedAt) + 'ms');
process.exitCode = failed ? 1 : 0;
