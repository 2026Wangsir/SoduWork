const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../core/i18n.js'), 'utf8');

test('device and account history controls retain all four locale translations', () => {
  const c = client();
  const expected = {
    'zh-CN': ['加载更多', '重新加载', '本机历史暂时无法读取', '部分会话暂时无法读取', '正在加载…'],
    'en-US': ['Load more', 'Reload', 'Local history is temporarily unavailable', 'Some conversations are temporarily unavailable', 'Loading…'],
    'ja-JP': ['さらに読み込む', '再読み込み', 'ローカル履歴を一時的に読み込めません', '一部の会話を一時的に読み込めません', '読み込み中…'],
    'ko-KR': ['더 불러오기', '새로고침', '현재 로컬 기록을 불러올 수 없습니다', '현재 일부 대화를 불러올 수 없습니다', '불러오는 중…'],
  };
  const keys = ['more', 'retry', 'localError', 'accountError', 'loading'];
  for (const [locale, values] of Object.entries(expected)) {
    c.api.setLocale(locale);
    assert.deepEqual(keys.map(key => c.api.t('workspace.history.' + key)), values);
  }
});
test('settings placeholders and screenshot notices follow every supported locale', () => {
  const c = client();
  const phrases = [
    'GitLab 登录名（GitHub 可留空）',
    '截图已保存。',
    '截图已复制，可在输入框粘贴。',
    '截图已复制到剪贴板。',
  ];
  const expected = {
    'zh-CN': phrases,
    'en-US': [
      'GitLab username (optional for GitHub)',
      'Screenshot saved.',
      'Screenshot copied. Paste it into the input.',
      'Screenshot copied to the clipboard.',
    ],
    'ja-JP': [
      'GitLab ログイン名（GitHub は空欄可）',
      'スクリーンショットを保存しました。',
      'スクリーンショットをコピーしました。入力欄に貼り付けられます。',
      'スクリーンショットをクリップボードにコピーしました。',
    ],
    'ko-KR': [
      'GitLab 로그인 이름(GitHub은 비워도 됨)',
      '스크린샷을 저장했습니다.',
      '스크린샷을 복사했습니다. 입력창에 붙여넣을 수 있습니다.',
      '스크린샷을 클립보드에 복사했습니다.',
    ],
  };
  for (const [locale, values] of Object.entries(expected)) {
    c.api.setLocale(locale);
    assert.deepEqual(phrases.map(phrase => c.api.translateText(phrase)), values, locale);
  }
});

test('requirement parsing warnings, tag controls, and built-in model names follow every supported locale', () => {
  const c = client();
  const phrases = [
    '本地模型不能用于后台解析；原文已保留，请选择托管模型或手动填写',
    '输入标签后按回车',
    '添加标签',
    '字节跳动 · 火山引擎方舟',
    '阿里云百炼（通义）',
    '智谱 GLM',
    '月之暗面 Kimi',
  ];
  const expected = {
    'en-US': [
      'Local models cannot be used for server-side parsing. The original text is preserved; choose a hosted model or fill it in manually.',
      'Press Enter after entering a tag', 'Add tag', 'Volcano Ark (Volcengine)',
      'Alibaba Cloud Model Studio (Bailian)', 'Z.ai GLM', 'Moonshot AI (Kimi)',
    ],
    'ja-JP': [
      'ローカルモデルはサーバー側の解析に使用できません。元のテキストは保持されています。ホスト型モデルを選択するか、手動で入力してください。',
      'タグを入力して Enter キーを押してください', 'タグを追加', 'Volcano Ark (Volcengine)',
      'Alibaba Cloud Model Studio (Bailian)', 'Z.ai GLM', 'Moonshot AI (Kimi)',
    ],
    'ko-KR': [
      '로컬 모델은 서버 측 파싱에 사용할 수 없습니다. 원문은 보존되어 있으므로 호스팅 모델을 선택하거나 직접 입력하세요.',
      '태그를 입력한 후 Enter를 누르세요', '태그 추가', 'Volcano Ark (Volcengine)',
      'Alibaba Cloud Model Studio (Bailian)', 'Z.ai GLM', 'Moonshot AI (Kimi)',
    ],
  };
  for (const [locale, values] of Object.entries(expected)) {
    c.api.setLocale(locale);
    assert.deepEqual(phrases.map(phrase => c.api.translateText(phrase)), values, locale);
  }
  c.api.setLocale('zh-CN');
  assert.deepEqual(phrases.map(phrase => c.api.translateText(phrase)), phrases);
});

test('requirement creation card controls follow locale changes without translating user content', () => {
  const c = client();
  const phrases = ['加入需求池', '检查需求详情', '需求内容', '背景与说明', '完成标准', '基本信息',
    '负责人', '优先级', '期望完成', '类型', '可见范围', '仅相关人', '标签', '创建需求',
    '继续对话'];
  const expected = {
    'en-US': ['Add to Issues', 'Review issue details', 'Issue content', 'Context and description',
      'Acceptance criteria', 'Basic information', 'Owner', 'Priority', 'Expected completion', 'Type',
      'Visibility', 'Related people', 'Tags', 'Create issue', 'Continue chatting'],
    'ja-JP': ['課題プールに追加', '課題の詳細を確認', '課題の内容', '背景と説明', '受け入れ基準',
      '基本情報', '担当者', '優先度', '完了予定', '種類', '公開範囲', '関係者のみ', 'タグ',
      '課題を作成', '会話を続ける'],
    'ko-KR': ['이슈 풀에 추가', '이슈 세부 정보 검토', '이슈 내용', '배경 및 설명', '완료 기준',
      '기본 정보', '담당자', '우선순위', '완료 예정', '유형', '공개 범위', '관련자만', '태그',
      '이슈 생성', '대화 계속하기'],
  };
  for (const [locale, values] of Object.entries(expected)) {
    c.api.setLocale(locale);
    assert.deepEqual(phrases.map(phrase => c.api.translateText(phrase)), values, locale);
  }
  c.api.setLocale('zh-CN');
  assert.deepEqual(phrases.map(phrase => c.api.translateText(phrase)), phrases);
});
test('company visibility copy distinguishes related people in all supported locales', () => {
  const c = client();
  const phrases = ['同公司可见', '同公司成员可查看需求内容；执行会话和日志仍按原有权限访问。',
    '仅相关人可查看需求内容；执行会话和日志仍按原有权限访问。', '仓库成员可见',
    '仓库成员可查看需求内容；执行会话和日志仍按原有权限访问。'];
  for (const locale of ['zh-CN','en-US','ja-JP','ko-KR']) {
    c.api.setLocale(locale);
    const translated = phrases.map(text => c.api.translateText(text));
    assert.notEqual(translated[1],translated[2]);
    for (const [index,text] of translated.entries()) {
      if (locale === 'zh-CN') assert.equal(text,phrases[index]);
      else assert.notEqual(text,phrases[index]);
    }
  }
});
test('personal action scope guidance follows every supported locale', () => {
  const c = client();
  const phrases = ['“需要我处理”仅显示当前轮到你操作的需求。执行中或已提交验收的需求仍保留在“与我相关”。',
    '查看与我相关', '执行已安排，可在“与我相关”查看进展', '已提交验收，等待验收人处理'];
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    c.api.setLocale(locale);
    for (const phrase of phrases) {
      const translated = c.api.translateText(phrase);
      if (locale === 'zh-CN') assert.equal(translated, phrase);
      else assert.notEqual(translated, phrase, locale + ': ' + phrase);
    }
  }
});

test('scope and approval tooltips explain visibility in all four locales', () => {
  const c = client();
  const phrases = ['全部可见','我提出、负责或执行的需求，以及待我确认或我作为仓库成员参与的需求。',
    '当前账号有权查看的全部需求，不限于与我相关的需求。','查看当前需要我确认的需求、交付验收、合并、环境验收或发布事项。',
    '查看已归档或已取消的需求；它们不再显示在当前需求池中。','返回未归档且未取消的当前需求。'];
  for (const locale of ['zh-CN','en-US','ja-JP','ko-KR']) {
    c.api.setLocale(locale);
    for (const phrase of phrases) {
      const translated = c.api.translateText(phrase);
      if (locale === 'zh-CN') assert.equal(translated,phrase);
      else assert.notEqual(translated,phrase,locale+': '+phrase);
    }
  }
});

test('collection inbox guidance names the same clarification flag in every locale', () => {
  const c = client(),phrase = '待整理的需求；“待补充”表示仍需完善背景或完成标准';
  for (const locale of ['zh-CN','en-US','ja-JP','ko-KR']) {
    c.api.setLocale(locale);
    const translated = c.api.translateText(phrase);
    assert.ok(translated.includes(c.api.translateText('待补充')),locale);
    if (locale === 'zh-CN') assert.equal(translated,phrase);
    else assert.notEqual(translated,phrase,locale);
  }
});

test('business project association and conflict recovery copy follow all four locales',()=>{
  const c=client(),phrases=['关联项目','不关联项目','当前关联项目','当前关联项目（不可用）',
    '项目由已关联仓库确定，本次不迁移仓库','项目列表暂时无法加载，当前关联已保留。','项目列表响应不完整，请重试',
    '已加载最新需求，未保存的修改已保留。请核对后再保存。','需求已开始执行，未保存内容已保留。'];
  for(const locale of ['zh-CN','en-US','ja-JP','ko-KR']){
    c.api.setLocale(locale);
    for(const phrase of phrases){
      const translated=c.api.translateText(phrase);
      if(locale==='zh-CN')assert.equal(translated,phrase);else assert.notEqual(translated,phrase,locale+': '+phrase);
    }
  }
});

test('renderer catalog packages preserve frozen snapshots and match canonical package order', () => {
  const context = vm.createContext({}), expected = {};
  const directory = path.join(__dirname, '../core/locales');
  const files = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  for (const file of files.filter(name => name !== 'locale-registry.js')) {
    const before = context.SoduWorkLocaleMessages, snapshot = JSON.stringify(before);
    const raw = require(path.join(directory, file));
    const packages = file.startsWith('builtin-') ? raw : { [file.slice(0, 5)]: raw };
    for (const [locale, messages] of Object.entries(packages)) {
      Object.assign(expected[locale] ||= Object.create(null), messages);
    }
    vm.runInContext(fs.readFileSync(path.join(directory, file), 'utf8'), context, { filename: file });
    assert.equal(JSON.stringify(before), snapshot, file + ' must not change earlier snapshots');
    assert.ok(Object.isFrozen(context.SoduWorkLocaleMessages), file);
    for (const messages of Object.values(context.SoduWorkLocaleMessages)) assert.ok(Object.isFrozen(messages), file);
    assert.deepEqual(JSON.parse(JSON.stringify(context.SoduWorkLocaleMessages)), JSON.parse(JSON.stringify(expected)), file);
  }
});

test('renderer catalog composition retains prototype-like keys and search supplement respects existing translations', () => {
  const original = Object.freeze(JSON.parse('{"__proto__":"Own proto","constructor":"Own constructor","重试":"Existing retry"}'));
  const catalogs = Object.freeze({ 'en-US': original });
  const context = vm.createContext({ SoduWorkLocaleMessages: catalogs });
  const directory = path.join(__dirname, '../core/locales');
  for (const file of ['en-US-trace-pages.js', 'global-search.js']) {
    vm.runInContext(fs.readFileSync(path.join(directory, file), 'utf8'), context, { filename: file });
    const messages = context.SoduWorkLocaleMessages['en-US'];
    assert.equal(Object.getPrototypeOf(messages), null);
    assert.ok(Object.hasOwn(messages, '__proto__'));
    assert.equal(messages.__proto__, 'Own proto');
    assert.equal(messages.constructor, 'Own constructor');
    assert.equal(messages['重试'], 'Existing retry');
    assert.ok(Object.isFrozen(messages));
    assert.ok(Object.isFrozen(context.SoduWorkLocaleMessages));
  }
  assert.equal(context.SoduWorkLocaleMessages['en-US']['打开全局搜索'], 'Open global search');
  assert.equal(catalogs['en-US'], original);
  assert.equal(original['打开全局搜索'], undefined);
});

test('localized slash actions resolve to the same work contract and preserve request text', () => {
  const window = { TaskPriority: { labels: {} }, addEventListener() {} };
  const context = vm.createContext({ window, document: { addEventListener() {} }, Intl, setTimeout, clearTimeout });
  const read = name => fs.readFileSync(path.join(__dirname, '../components/panels', name), 'utf8');
  vm.runInContext(read('plugin-ui-host.js'), context);
  context.PluginUIHost = window.PluginUIHost;
  for (const file of ['work-entry-sheet.js', 'work-automation-sheet.js']) vm.runInContext(read(file), context);
  for (const [en, zh, actionId] of [
    ['issue', '需求', 'work.requirement.create'], ['request', '创建需求', 'work.requirement.create'], ['task', '任务', 'work.requirement.create'],
    ['automation', '自动化', 'work.automation.create'],
  ]) for (const command of [en, zh]) {
    const result = window.PluginUIHost.commandFromText('/' + command + ' 保存 this request');
    assert.equal(result?.actionId, actionId, command);
    assert.equal(result.text, '保存 this request');
  }
});
function client(saved = {}, blocked = false, options = {}) {
  const storage = new Map(Object.entries(saved)), listeners = new Map(), sent = [];
  const context = vm.createContext({
    Intl, Map, Set, Object,
    localStorage: { getItem: key => { if (blocked) throw Error('blocked'); return storage.get(key) || null; }, setItem: (key, value) => { if (blocked) throw Error('blocked'); storage.set(key, value); } },
    document: { readyState: 'loading', documentElement: { dataset: {} }, querySelectorAll: () => [] },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    addEventListener: (name, cb) => { listeners.set(name, cb); },
    dispatchEvent: event => { listeners.get(event.type)?.(event); },
    soduWorkAPI: { setLocale: locale => sent.push(locale), onLocaleChange: cb => { listeners.set('ipc-locale', cb); } },
  });
  const initialConfig = options.initialLocale ? `{locale:${JSON.stringify(options.initialLocale)}}` : '{}';
  vm.runInContext(`window = globalThis; let cfg = ${initialConfig}; let saves = 0; const saveCfg = () => { saves++; };`, context);
  for (const file of JSON.parse(fs.readFileSync(path.join(__dirname, '../core/locales/manifest.json'), 'utf8'))) {
    // A legacy renderer can start while the registry script is unavailable;
    // locale packs must still be selectable instead of collapsing to Chinese.
    if ((options.withoutRegistry || options.registry) && file === 'locale-registry.js') continue;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../core/locales', file), 'utf8'), context);
  }
  if (options.registry) context.SoduWorkLocaleRegistry = options.registry;
  vm.runInContext(script, context);
  return { api: context.SoduWorkI18n, context, storage, listeners, sent, read: code => vm.runInContext(code, context) };
}

test('keyed tooltips follow locale changes without replacing child content or user attributes', () => {
  const c = client();
  const makeElement = user => {
    const attrs = { 'data-i18n-title': 'builtin.skill.office.description', title: 'Original description',
      ...(user ? { 'data-user-attributes': 'title' } : {}) };
    return { textContent: 'Keep controls', closest: () => false,
      getAttribute: name => attrs[name] || null, setAttribute: (name, value) => { attrs[name] = value; } };
  };
  const system = makeElement(false), custom = makeElement(true);
  c.context.document.querySelectorAll = () => [system, custom];
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN', 'en-US']) {
    c.api.setLocale(locale);
    assert.equal(system.getAttribute('title'), c.api.t('builtin.skill.office.description'));
    assert.equal(system.textContent, 'Keep controls');
    assert.equal(custom.getAttribute('title'), 'Original description');
  }
});

test('delivery download receipts and bounded HTTP errors follow every supported locale', () => {
  const c = client();
  const source = ['正在准备交付文件…', '文件已保存到所选位置',
    '正在准备下载…', '正在打开材料…', '按验收意见继续修改',
    '本轮执行已结束，可提交验收', '查看并提交',
    '本轮执行已暂停，需要你在原对话中处理后继续。',
    '等待钉钉授权超时，请重新连接并完成网页上的全部授权步骤',
    '钉钉授权未完成，请检查连接后重试',
    '源文件已丢失，请从原执行电脑或服务器备份恢复附件后重试',
    '图片附件为空，请重新选择图片后发送',
    '图片附件受加密保护，当前执行底座无法读取，请使用已获授权的可读图片',
    '无法确定附件的图片类型，请重新选择图片后发送',
    '交付文件访问权限已变化，请重新打开需求后重试',
    '交付压缩包读取失败（HTTP 502），请刷新需求后重试'];
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    c.api.setLocale(locale);
    for (const text of source) {
      const translated = c.api.translateText(text);
      if (locale === 'zh-CN') assert.equal(translated, text);
      else assert.notEqual(translated, text, locale + ': ' + text);
      if (text.includes('502')) assert.match(translated, /HTTP 502/);
    }
  }
});

test('conversation lifecycle status and retry copy follow renderer locales and preserve error details', () => {
  const c = client();
  const phrases = [
    '账号或服务已切换，请重新打开会话',
    '无法核对账号会话状态，请稍后重试',
    '这条会话还在执行，完成或停止后再操作',
    '账号会话状态未保存，请重试',
    '该会话将从当前账号的会话列表中删除，其他设备也会同步；需求和成果文件不会删除。',
    '删除未完成',
    '删除没有完成。账号会话已归档，请在归档会话中重试。',
    '本地会话尚未同步成功，本次操作未完成，请联网后重试',
    '无法确认账号会话状态，请稍后重试',
    '账号会话来源不匹配，请刷新后重试',
    '本地会话同步尚未确认，本次操作未完成，请稍后重试',
    '无法读取账号会话状态，本次操作未完成，请联网后重试',
    '请先登录 SoduWork 后操作会话',
    '会话操作无效',
    '这条会话正在更新，请稍后重试',
    '账号会话操作未确认，请刷新后重试',
    '会话状态已更新，本次操作未全部完成，请刷新后重试',
  ];
  for (const id of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    c.api.setLocale(id);
    const catalog = id === 'zh-CN' ? null : require('../core/locales/' + (id === 'en-US' ? 'en-US-native' : id) + '.js');
    for (const source of phrases) {
      assert.equal(c.api.translateText(source), catalog ? catalog[source] : source, id + ': ' + source);
    }
    for (const source of ['删除没有完成：{reason}', '本地会话尚未同步，请重试后再操作：{reason}']) {
      const reason = 'EBUSY: D:/work/保存.jsonl';
      const text = source.replace('{reason}', reason);
      assert.equal(c.api.translateText(text), catalog ? catalog[source].replace('{reason}', reason) : text, id);
    }
  }
});

test('new client profiles default to English while explicit locale choices remain intact', () => {
  const fresh = client({}, false, { initialLocale: null });
  assert.equal(fresh.api.getLocale(), 'en-US');
  assert.equal(fresh.context.document.documentElement.lang, 'en-US');
  const saved = client({}, false, { initialLocale: 'zh-CN' });
  assert.equal(saved.api.getLocale(), 'zh-CN');
  assert.deepEqual(saved.api.options().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
});

test('ja-JP and ko-KR translate gap pages, localized templates and Issue terms', () => {
  const c = client();
  const contextScope = '最近一次上报的上下文用量，含缓存；不含待发送内容';
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    c.api.setLocale(locale);
    assert.notEqual(c.api.translateText(contextScope), contextScope);
    assert.notEqual(c.api.translateText('暂未获取用量'), '暂未获取用量');
  }
  c.api.setLocale('ja-JP');
  assert.equal(c.api.translateText('文件已保存'), 'ファイルを保存しました');
  assert.equal(c.api.translateText('打开需求失败：网络超时'), '課題を開けませんでした：网络超时');
  assert.equal('claude' + c.api.translateText(' · 第 2 段') + c.api.translateText(' · 排队 3'), 'claude · 第 2 セグメント · 待機 3');
  assert.equal(c.api.translateText('每周一 09:00'), '毎週月曜日 09:00');
  assert.equal(c.api.translateText('· 已归档 · 5 条'), '· アーカイブ済み · 5 件');
  assert.equal(c.api.translateText('专业方法'), '専門手法');
  c.api.setLocale('ko-KR');
  assert.equal(c.api.translateText('文件已保存'), '파일을 저장했습니다');
  assert.equal(c.api.translateText('插件 12 · 连接器 4 · 技能 8'), '플러그인 12 · 커넥터 4 · 스킬 8');
  assert.equal(c.api.translateText('已建立自动化：' + c.api.translateText('每周一 09:00') + '按「周报生成」的方法自动执行，可在「定时任务」里调整'),
    '매주 월요일 09:00에 “周报生成” 방법으로 자동 실행이 생성되었습니다. 예약 작업에서 조정할 수 있습니다');
  c.api.setLocale('zh-CN');
  assert.equal(c.api.translateText('文件已保存'), '文件已保存');
});
test('gantt item counts and routine rhythm labels translate in all locales without term leakage', () => {
  const c = client();
  c.api.setLocale('zh-CN');
  assert.equal(c.api.translateText('任务 42 项'), '任务 42 项');
  c.api.setLocale('en-US');
  assert.equal(c.api.translateText('任务 42 项'), '42 items');
  assert.equal(c.api.translateText('42 项'), '42 items');
  assert.equal(c.api.translateText('↻ 写周报 · 每天'), '↻ 写周报 · Daily');
  assert.equal(c.api.translateText('写周报 · 计划'), '写周报 · Planned');
  assert.equal(c.api.translateText('写周报 · 实际'), '写周报 · Actual');
  c.api.setLocale('ja-JP');
  assert.equal(c.api.translateText('任务 42 项'), '課題 42 件');
  assert.equal(c.api.translateText('↻ 写周报 · 每周'), '↻ 写周报 · 毎週');
  assert.equal(c.api.translateText('写周报 · 例行'), '写周报 · 定例');
  c.api.setLocale('ko-KR');
  assert.equal(c.api.translateText('任务 42 项'), '이슈 42개');
  assert.equal(c.api.translateText('↻ 写周报 · 每月'), '↻ 写周报 · 매월');
  assert.equal(c.api.translateText('写周报 · 实际'), '写周报 · 실제');
  c.api.setLocale('zh-CN');
});
test('cloud environment UI translates complete messages while preserving command and server data', () => {
  const c = client(); c.api.setLocale('en-US');
  assert.equal(c.api.translateText('云端环境'), 'Cloud environments');
  assert.equal(c.api.translateText('执行中 2 / 8'), 'Running: 2 / 8');
  assert.equal(c.api.translateText('复制接入指令'), 'Copy setup command');
  assert.equal(c.api.translateText('需要执行机管理权限，请联系管理员接入团队服务器'),
    'Runner management permission is required. Ask an administrator to connect a team server.');
  assert.equal(c.api.translateText('团队共享服务器由管理员配置。你可以使用已接入且有权限的服务器。'),
    'Administrators configure shared team servers. You can use connected servers that you have permission to access.');
  const command = 'npm install -g @earendil-works/pi-coding-agent';
  assert.equal(c.api.translateText(command), command);
  assert.equal(c.api.translateText('研发服务器-保存-trial'), '研发服务器-保存-trial');
  c.api.setLocale('zh-CN');
  assert.equal(c.api.translateText('云端环境'), '云端环境');
});
test('complete dynamic templates retain data and safely escape HTML parameters', () => {
  const c = client(); c.api.setLocale('en-US');
  assert.equal(c.api.translateText('当前模型不接受图片输入，请切换支持图片的模型或启用视觉适配'),
    'This model rejected image input. Switch to an image-capable model or enable vision fallback.');
  assert.equal(c.api.translateText('本月已用 12 / 300 Tokens'), 'Used this month: 12 / 300 tokens');
  assert.equal(c.api.translateText('在此目录创建会话：D:/保存 & 删除'), 'Start a chat in: D:/保存 & 删除');
  assert.equal(c.api.translateText('在此目录创建会话：D:/保存  &  删除'), 'Start a chat in: D:/保存  &  删除');
  assert.equal(c.api.translateText('constructor'), 'constructor');
  const guard = require('../main/agent-runtime/protocol-guard');
  const notice = guard.reason({ code: guard.DEGENERATE_OUTPUT_CODE });
  assert.equal(c.api.translateText(notice), 'The model kept repeating the same action. SoduWork stopped the repetitive output and preserved your progress and tool results.');
  assert.equal(c.api.translateText(notice, 'zh-CN'), notice);
  const html = c.api.html('models.noResults', '', { query: '<img src=x onerror=alert(1)>保存' });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('保存'));
});
test('language updates the lexical cfg and calls its persistence function', () => {
  const c = client();
  c.api.setLocale('en-US');
  assert.equal(c.read('cfg.locale'), 'en-US');
  assert.equal(c.read('saves'), 1);
  assert.equal(c.storage.get('soduwork_work_cfg_v5_locale'), 'en-US');
  assert.equal(c.storage.get('soduwork_work_cfg_v5_locale_explicit'), '1');
  assert.equal(c.api.t('settings'), 'Settings');
  assert.equal(c.context.document.documentElement.lang, 'en-US');
});
test('reload restores the selected language and migrates a mirror-only setting', () => {
  const c = client({ soduwork_work_cfg_v5_locale: 'en-US' });
  assert.equal(c.api.getLocale(), 'en-US');
  assert.equal(c.read('cfg.locale'), 'en-US');
  assert.equal(c.read('saves'), 0);
});
test('storage and IPC changes synchronize windows without rebroadcast loops', () => {
  const c = client();
  const initial = c.sent.length;
  c.listeners.get('storage')({ key: 'soduwork_work_cfg_v5_locale', newValue: 'en-US' });
  assert.equal(c.api.getLocale(), 'en-US');
  c.listeners.get('ipc-locale')('zh-CN');
  assert.equal(c.api.getLocale(), 'zh-CN');
  assert.equal(c.sent.length, initial);
  assert.equal(c.read('saves'), 0);
});
test('switching works when local storage is unavailable', () => {
  const c = client({}, true);
  c.api.setLocale('en-US');
  assert.equal(c.api.t('settings'), 'Settings');
  assert.equal(c.sent.at(-1), 'en-US');
});
test('accepted remote configuration updates the reload mirror without saving back to Hub', () => {
  const c = client();
  c.api.setLocale('en-US', { persist: false });
  assert.equal(c.storage.get('soduwork_work_cfg_v5_locale'), 'en-US');
  assert.equal(c.storage.get('soduwork_work_cfg_v5_locale_explicit'), undefined);
  assert.equal(c.read('saves'), 0);
  assert.equal(c.sent.at(-1), 'en-US');
  c.listeners.get('ipc-locale')('zh-CN');
  assert.equal(c.storage.get('soduwork_work_cfg_v5_locale'), 'zh-CN');
  assert.equal(c.sent.at(-1), 'en-US');
});
test('native window titles follow locale while retaining the full user task title', () => {
  const c = client();
  c.api.setLocale('zh-CN');
  c.api.setWindowTitle('控制台', '保存 · （有会话）');
  assert.equal(c.context.document.title, 'SoduWork · 控制台 · 保存 · （有会话）');
  c.api.setLocale('en-US');
  assert.equal(c.context.document.title, 'SoduWork · Console · 保存 · （有会话）');
  c.api.setLocale('zh-CN');
  assert.equal(c.context.document.title, 'SoduWork · 控制台 · 保存 · （有会话）');
});
test('only complete UI messages translate and whitespace is retained', () => {
  const c = client();
  c.api.setLocale('en-US');
  assert.equal(c.api.translateText('  保存  '), '  Save  ');
  assert.equal(c.api.translateText('这是一个新的任务'), '这是一个新的任务');
  assert.equal(c.api.translateText('保存：我的项目'), '保存：我的项目');
  c.api.setLocale('zh-CN');
  assert.equal(c.api.translateText('保存'), '保存');
  assert.equal(c.api.normalize('xx-YY'), 'en-US');
  assert.equal(c.api.normalize('en-GB'), 'en-US');
});

test('additional locale packs switch without translating user content', () => {
  const c = client();
  assert.deepEqual(c.api.options().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
  c.api.setLocale('ja-JP');
  assert.equal(c.api.getLocale(), 'ja-JP');
  assert.equal(c.api.translateText('设置'), '設定');
  assert.equal(c.api.translateText('模型清单'), 'モデル一覧');
  assert.equal(c.api.translateText('项目-保存'), '项目-保存');
  assert.equal(c.api.normalize('ja'), 'ja-JP');
  c.api.setLocale('ko');
  assert.equal(c.api.getLocale(), 'ko-KR');
  assert.equal(c.api.translateText('设置'), '설정');
  assert.equal(c.api.translateText('模型清单'), '모델 목록');
  c.api.setLocale('zh-CN');
});

test('additional locales remain selectable when a legacy renderer misses the registry script', () => {
  const c = client({}, false, { withoutRegistry: true });
  assert.deepEqual(c.api.options().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
  c.api.setLocale('ja-JP');
  assert.equal(c.api.getLocale(), 'ja-JP');
  assert.equal(c.api.translateText('设置'), '設定');
  c.api.setLocale('ko-KR');
  assert.equal(c.api.getLocale(), 'ko-KR');
  assert.equal(c.api.translateText('设置'), '설정');
  c.api.setLocale('zh-CN');
});

test('a cached two-language registry cannot hide newer shipped locale packs', () => {
  const legacy = client({}, false, { registry: {
    defaultLocale: 'zh-CN',
    locales: {
      'zh-CN': { label: '简体中文', fallback: null },
      'en-US': { label: 'English', fallback: 'zh-CN' },
    },
  } });
  assert.deepEqual(legacy.api.options().map(item => item.value), ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
  legacy.api.setLocale('ja-JP');
  assert.equal(legacy.api.translateText('设置'), '設定');
});

test('settings exposes language choices through one native select', () => {
  const html = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '../components/settings/settings.js'), 'utf8');
  assert.match(html, /<select id="localeSelect"/);
  assert.match(html, /data-i18n="languageJa"/);
  assert.match(html, /data-i18n="languageKo"/);
  assert.doesNotMatch(html, /id="localeSeg"/);
  assert.match(settings, /_syncLocaleSelect/);
  assert.match(settings, /localeSelect\.addEventListener\('change'/);
});

test('server message descriptors switch locale without translating interpolated business data', () => {
  const { api } = client();
  const params = { sender: '保存', title: 'New chat {sender} 日本語' };
  const expected = {
    'en-US': '保存 assigned the issue “New chat {sender} 日本語” to you',
    'ja-JP': '保存 が課題「New chat {sender} 日本語」をあなたに割り当てました',
    'ko-KR': '保存님이 요구 사항 “New chat {sender} 日本語”을(를) 배정했습니다',
    'zh-CN': '保存 将需求「New chat {sender} 日本語」交给你',
  };
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN', 'en-US']) {
    api.setLocale(locale);
    assert.equal(api.t('notification.task_assignment', 'legacy fallback', params), expected[locale]);
    assert.notEqual(api.t('agent.auth.required', 'untranslated'), 'untranslated');
  }
});

test('publication notices translate in every shipped locale while retaining exact plugin names and versions', () => {
  const { api } = client(), params = { name: '保存 {version}', version: '2.0.0-beta' };
  for (const locale of ['en-US', 'ja-JP', 'ko-KR', 'zh-CN']) {
    api.setLocale(locale);
    for (const key of ['notification.plugin_unpublished', 'notification.plugin_version_revoked']) {
      const text = api.t(key, 'missing', params);
      assert.notEqual(text, 'missing');
      assert.ok(text.includes(params.name), locale + ' preserves business text');
      if (key.endsWith('revoked')) assert.ok(text.includes(params.version));
    }
    if (locale !== 'zh-CN') assert.notEqual(api.translateText('发布状态更新'), '发布状态更新');
  }
});


test('collaboration card actions, permissions and summaries use shipped locale entries', () => {
  const c = client();
  const samples = [
    '停止协作', '恢复协作', '收起协作卡，执行不会停止', '核对执行状态',
    '成果承载区尚未就绪，请重新打开对话', '完成流程，保留结果', '需要你的许可',
    '操作内容未完整提供。请拒绝本次操作，并让 Agent 提供明确、简短的操作。',
    '不允许', '仅允许本次', '较早协作「Workflow A」待处理', '2 / 4 步完成', '已校验成果 · 6 项',
  ];
  for (const [locale, stop, summary] of [
    ['en-US', 'Stop collaboration', 'Verified outputs · 6'],
    ['ja-JP', '共同作業を停止', '検証済みの成果 · 6 件'],
    ['ko-KR', '공동 작업 중지', '검증된 결과 · 6개'],
  ]) {
    c.api.setLocale(locale);
    for (const source of samples) assert.notEqual(c.api.translateText(source), source, `${locale}: ${source}`);
    assert.equal(c.api.translateText('停止协作'), stop);
    assert.equal(c.api.translateText('已校验成果 · 6 项'), summary);
    assert.ok(c.api.translateText('较早协作「Workflow A」待处理').includes('Workflow A'));
    if (locale === 'en-US') for (const source of samples) assert.doesNotMatch(c.api.translateText(source), /[\u3400-\u9fff]/);
  }
  c.api.setLocale('zh-CN');
  for (const source of samples) assert.equal(c.api.translateText(source), source);
});
