(function (global) {
  'use strict';
  const labels = {
    'zh-CN': ['朗读', '暂停', '继续', '停止', '正在准备语音…', '正在朗读', '已暂停', '本机语音不可用，请检查系统语音设置。', '没有此语言的本地音色，请在系统语音设置中安装对应语音包。', '朗读失败，请检查声音输出后重试。', '没有可朗读的正文。', '语速', '此处包含表格。'],
    'en-US': ['Read aloud', 'Pause', 'Resume', 'Stop', 'Preparing speech…', 'Reading aloud', 'Paused', 'Local speech is unavailable. Check system speech settings.', 'No local voice for this language. Install its voice pack in system speech settings.', 'Speech failed. Check audio output and try again.', 'No readable text.', 'Speed', 'A table appears here.'],
    'ja-JP': ['読み上げ', '一時停止', '再開', '停止', '音声を準備中…', '読み上げ中', '一時停止中', 'ローカル音声を利用できません。システムの音声設定を確認してください。', 'この言語の音声がありません。システム設定で音声パックを追加してください。', '読み上げに失敗しました。音声出力を確認して再試行してください。', '読み上げる本文がありません。', '速度', 'ここに表があります。'],
    'ko-KR': ['읽어주기', '일시 정지', '계속', '중지', '음성 준비 중…', '읽는 중', '일시 정지됨', '로컬 음성을 사용할 수 없습니다. 시스템 음성 설정을 확인하세요.', '이 언어의 로컬 음성이 없습니다. 시스템 설정에서 음성 팩을 설치하세요.', '읽기에 실패했습니다. 오디오 출력을 확인하고 다시 시도하세요.', '읽을 본문이 없습니다.', '속도', '여기에 표가 있습니다.'],
  };
  const locale = () => global.SoduWorkI18n?.getLocale() || 'zh-CN';
  const t = index => (labels[locale()] || labels['en-US'])[index];
  const core = global.SoduWorkReadAloudCore;
  const icons = {
    read: 'M11 5 6 9H3v6h3l5 4V5Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14',
    pause: 'M8 5v14 M16 5v14', play: 'm8 5 11 7-11 7V5Z', stop: 'M6 6h12v12H6Z',
    speed: 'M4 18a9 9 0 1 1 16 0 M12 13l5-5 M8 18h8',
  };
  function paintIcon(button, name, label) {
    button.title = label; button.setAttribute('aria-label', label);
    if (button.dataset.icon === name) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', icons[name]); svg.append(path); button.replaceChildren(svg); button.dataset.icon = name;
  }
  let active = '', activeText = '', request = 0, snapshot = { state: 'idle' }, message = '', speed = 1;
  const isActive = wrap => wrap.dataset.readAloud === active && wrap.dataset.speechText === activeText;
  try {
    const saved = JSON.parse(localStorage.getItem('soduwork.readAloud.preferences') || '{}');
    if ([0.75, 1, 1.25, 1.5].includes(saved.speed)) speed = saved.speed;
  } catch (_) { /* Preferences are optional. */ }
  function sync() {
    document.querySelectorAll('[data-read-aloud]').forEach(wrap => {
      const selected = isActive(wrap);
      const state = selected ? snapshot.state : 'idle';
      const text = t(state === 'playing' ? 1 : state === 'paused' ? 2 : 0);
      const button = wrap.querySelector('[data-speech-play]');
      paintIcon(button, state === 'playing' ? 'pause' : state === 'paused' ? 'play' : 'read', text);
      const stopButton = wrap.querySelector('[data-speech-stop]');
      paintIcon(stopButton, 'stop', t(3));
      paintIcon(wrap.querySelector('[data-speech-menu="rate"]'), 'speed', t(11) + ' · ' + speed + '×');
      wrap.querySelector('[data-speech-options="rate"]').setAttribute('aria-label', t(11));
      button.disabled = state === 'loading';
      const controls = wrap.querySelector('[data-speech-controls]');
      controls.hidden = !selected;
      wrap.dataset.active = String(selected);
      const status = wrap.querySelector('[role="status"]');
      const statusText = selected ? message || (state === 'loading' ? t(4) : state === 'playing' ? t(5) : state === 'paused' ? t(6) : '') : '';
      if (status.textContent !== statusText) status.textContent = statusText;
      status.classList.toggle('is-quiet', !message);
      wrap.querySelectorAll('[data-speech-rate]').forEach(item => item.setAttribute('aria-checked', String(Number(item.dataset.speechRate) === speed)));
    });
  }
  const player = core.create({ synth: global.speechSynthesis, Utterance: global.SpeechSynthesisUtterance,
    changed(value) {
      snapshot = value;
      if (value.error) message = t(value.error === 'unavailable' ? 7 : 9);
      sync();
    } });
  function stop() { request++; active = ''; activeText = ''; message = ''; closeMenus(); player.stop(); }
  async function voices() {
    const synth = global.speechSynthesis;
    if (!synth) return [];
    if (synth.getVoices().length) return synth.getVoices();
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timeout); synth.removeEventListener('voiceschanged', finish); resolve(synth.getVoices()); };
      const timeout = setTimeout(finish, 1500);
      synth.addEventListener('voiceschanged', finish, { once: true });
    });
  }
  async function start(wrap) {
    stop(); active = wrap.dataset.readAloud; activeText = wrap.dataset.speechText;
    const token = request;
    snapshot = { state: 'loading' }; sync();
    try {
      if (!global.speechSynthesis || !global.SpeechSynthesisUtterance) throw Error('unavailable');
      const text = core.plainText(wrap.dataset.speechText, global.marked.lexer, t(12));
      if (!text) { message = t(10); snapshot = { state: 'idle' }; sync(); return; }
      const language = core.language(text, locale());
      const available = (await voices()).filter(voice => voice.localService);
      if (token !== request) return;
      const voice = available.find(v => v.lang.replace('_', '-') === language) ||
        available.find(v => v.lang.split(/[-_]/)[0] === language.split('-')[0]);
      if (!voice) { message = t(8); snapshot = { state: 'idle' }; sync(); return; }
      if (global.soduWorkAPI?.readAloud) await global.soduWorkAPI.readAloud.claim();
      if (token !== request || ![...document.querySelectorAll('[data-read-aloud]')].some(isActive)) return;
      player.start(text, voice, speed);
    } catch (error) {
      if (token !== request) return;
      message = t(error.message === 'unavailable' ? 7 : 9); snapshot = { state: 'error' }; sync();
    }
  }
  document.addEventListener('click', event => {
    const wrap = event.target.closest('[data-read-aloud]');
    if (!wrap) { closeMenus(); return; }
    const menu = event.target.closest('[data-speech-menu]');
    if (menu) {
      const panel = wrap.querySelector('[data-speech-options="' + menu.dataset.speechMenu + '"]');
      const open = panel.hidden; closeMenus(); panel.hidden = !open;
      menu.setAttribute('aria-expanded', String(open));
      if (open) panel.querySelector('[aria-checked="true"]')?.focus();
      return;
    }
    const rate = event.target.closest('[data-speech-rate]');
    if (rate) {
      speed = Number(rate.dataset.speechRate); player.setRate(speed);
      try { localStorage.setItem('soduwork.readAloud.preferences', JSON.stringify({ speed })); } catch (_) { /* Read-only profile. */ }
      closeMenus(); sync();
      wrap.querySelector('[data-speech-menu="rate"]').focus();
      return;
    }
    if (event.target.closest('[data-speech-stop]')) { stop(); return; }
    if (!event.target.closest('[data-speech-play]')) return;
    closeMenus();
    if (isActive(wrap) && ['playing', 'paused'].includes(player.state())) player.toggle();
    else start(wrap);
  });
  function closeMenus() {
    document.querySelectorAll('[data-speech-options]').forEach(menu => { menu.hidden = true; });
    document.querySelectorAll('[data-speech-menu]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const wrap = event.target?.closest?.('[data-read-aloud]');
    const open = wrap?.querySelector('[data-speech-options]:not([hidden])');
    if (!open) return;
    event.preventDefault(); event.stopPropagation(); closeMenus();
    wrap.querySelector('[data-speech-menu="' + open.dataset.speechOptions + '"]').focus();
  });
  global.addEventListener('pagehide', stop);
  global.addEventListener('soduwork-data-scope-changed', stop);
  global.addEventListener('soduwork-device-auth', event => { if (event.detail?.state !== 'active') stop(); });
  global.addEventListener('soduwork-locale-change', stop);
  global.soduWorkAPI?.readAloud?.onStop(stop);
  new MutationObserver(() => {
    if (active && ![...document.querySelectorAll('[data-read-aloud]')].some(isActive)) stop();
    else if (active) sync();
  }).observe(document.body, { subtree: true, childList: true });
  function button(text, scope, index, esc) {
    const key = String(scope) + ':' + String(index);
    const iconButton = (attribute, name, title, extra = '') => '<button type="button" class="ntext-copy" ' + attribute + ' data-icon="' + name + '" title="' + esc(title) + '" aria-label="' + esc(title) + '" ' + extra + '><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + icons[name] + '"></path></svg></button>';
    return '<span class="nread-aloud" translate="no" data-read-aloud="' + esc(key) + '" data-speech-text="' + esc(text) + '">' +
      iconButton('data-speech-play', 'read', t(0)) +
      '<span data-speech-controls hidden>' + iconButton('data-speech-stop', 'stop', t(3)) +
      '<span class="nread-menu">' + iconButton('data-speech-menu="rate"', 'speed', t(11), 'aria-haspopup="menu" aria-expanded="false"') +
      '<span data-speech-options="rate" role="menu" aria-label="' + esc(t(11)) + '" hidden>' + [0.75, 1, 1.25, 1.5].map(rate => '<button type="button" role="menuitemradio" aria-checked="' + (rate === speed) + '" data-speech-rate="' + rate + '">' + rate + '×</button>').join('') + '</span></span>' +
      '</span>' +
      '<span class="nread-status is-quiet" role="status"></span></span>';
  }
  global.SoduWorkReadAloud = { button, stop };
})(window);
