/* Shared Agent brand identity.
   The runtime mark answers "which foundation is this?"; status remains a separate UI signal. */
(function (global) {
  'use strict';

  const MONOGRAMS = Object.freeze({
    pi: 'PI',
    'codex-harness': 'CX',
    opencode: 'OC',
    claude: 'CL',
    codex: 'CX',
    qwen: 'QW',
    kimi: 'KM',
    dsh: 'DS',
    harness2: 'H2',
  });
  const CUSTOM_PATHS = Object.freeze([
    'M7.4 5.8 12 3l4.6 2.8v5.5c0 3.7-1.9 6.6-4.6 8.7-2.7-2.1-4.6-5-4.6-8.7V5.8Z',
    'M9.3 10.1h5.4M9.3 13.5h3.5',
  ]);

  const LABELS = Object.freeze({
    pi: 'Pi',
    'codex-harness': 'Codex Harness',
    opencode: 'OpenCode',
    claude: 'Claude Code',
    codex: 'Codex',
    qwen: 'Qwen Code',
    kimi: 'Kimi Code',
    dsh: 'DeepSeek Harness',
    harness2: 'Google Harness²',
    custom: '自定义 Agent',
  });

  function _text(value) {
    return String(value == null ? '' : value).normalize('NFKC').trim().toLowerCase();
  }

  function canonical(value) {
    if (value && typeof value === 'object') {
      const fields = ['adapterId', 'runtimeId', 'cli', 'key', 'displayName', 'name', 'agent'];
      for (const field of fields) {
        const id = canonical(value[field]);
        if (id !== 'custom') return id;
      }
      return 'custom';
    }
    const text = _text(value).replace(/[ _]+/g, '-');
    if (!text) return 'custom';
    if (/(^|[-:./])harness[-:./]*2($|[-:./])/.test(text)) return 'harness2';
    if (/codex[-:./]*harness|harness[-:./]*codex/.test(text)) return 'codex-harness';
    if (/deepseek|(^|[-:./])dsh($|[-:./])/.test(text)) return 'dsh';
    if (/open[-:./]*code/.test(text)) return 'opencode';
    if (/claude/.test(text)) return 'claude';
    if (/qwen/.test(text)) return 'qwen';
    if (/kimi|moonshot/.test(text)) return 'kimi';
    if (/(^|[-:./])codex($|[-:./])|chatgpt/.test(text)) return 'codex';
    if (/(^|[-:./])pi($|[-:./])|pi[-:./]*coding[-:./]*agent/.test(text)) return 'pi';
    return 'custom';
  }

  function _attr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function className(value, extra) {
    const id = canonical(value);
    return ['agent-brand', 'agent-brand-' + id, String(extra || '').trim()].filter(Boolean).join(' ');
  }

  function glyph(value) {
    const id = canonical(value);
    const mark = MONOGRAMS[id];
    if (mark) return '<span class="agent-monogram" aria-hidden="true">' + mark + '</span>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      CUSTOM_PATHS.map(d => '<path d="' + d + '"/>').join('') + '</svg>';
  }

  function html(value, options) {
    const opts = options || {};
    const id = canonical(value);
    return '<span class="' + _attr(className(id, opts.className)) + '" data-agent-brand="' + id + '"' +
      (opts.id ? ' id="' + _attr(opts.id) + '"' : '') +
      ' title="' + _attr(opts.title || LABELS[id]) + '" role="img" aria-label="' +
      _attr(LABELS[id]) + '">' + glyph(id) + '</span>';
  }

  // DOM-built surfaces share the same identity as HTML-built surfaces without
  // depending on an image registry or interpreting runtime metadata as markup.
  function element(value, options) {
    const opts = options || {}, document = opts.document || global.document;
    const id = canonical(value), root = document.createElement('span');
    for (const [name, text] of Object.entries({ class: className(id, opts.className),
      'data-agent-brand': id, title: opts.title || LABELS[id], role: 'img', 'aria-label': LABELS[id] })) {
      root.setAttribute(name, text);
    }
    if (opts.id) root.setAttribute('id', opts.id);
    if (MONOGRAMS[id]) {
      const mark = document.createElement('span');
      mark.setAttribute('class', 'agent-monogram'); mark.setAttribute('aria-hidden', 'true');
      mark.textContent = MONOGRAMS[id]; root.append(mark);
    } else {
      const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      for (const d of CUSTOM_PATHS) {
        const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path);
      }
      root.append(svg);
    }
    return root;
  }

  // Only runtime metadata can label an output. Never infer authorship from text
  // or the currently selected composer Agent (which may already have changed).
  function sourceKey(source) {
    return source && Object.hasOwn(MONOGRAMS, source.agentId)
      ? JSON.stringify([source.agentId, source.runId || '', source.nodeKey || '']) : '';
  }
  /* Turn-scoped transcripts share one identity across messages and tools. The caller
     supplies the complete turn's crew and resets its boundary with breakRun(). Legacy
     callers retain source/run heads; tool provenance and grouping always stay intact. */
  function transcript(options) {
    const opts = options || {};
    const hasCrew = typeof opts.crewHtml === 'function';
    let turnHead = false;
    let previous = '';       // tool-group head dedup key (existing behavior)
    let previousCrew = '';   // message-head chain dedup key: one crew head per run
    function header(parts, source, anchor, crewHtml) {
      const key = sourceKey(source);
      if (!key) return;
      const runId = crewHtml?.runId ?? source.runId;
      const shell = crewHtml
        ? '<div class="nchat-agent-source nchat-crew" data-chat-node="agent-source:' + _attr(anchor) +
          '" data-output-agent="' + _attr(source.agentId) +
          (runId ? '" data-crew-run="' + _attr(runId) : '') +
          (crewHtml.taskId ? '" data-crew-task="' + _attr(crewHtml.taskId) : '') +
          '" role="button" tabindex="0"' +
          (crewHtml.title ? ' title="' + _attr(crewHtml.title) + '" data-crew-title="' + _attr(crewHtml.title) +
            '" aria-haspopup="dialog"' : '') + '>' + crewHtml.html + '</div>'
        : '<div class="nchat-agent-source" data-chat-node="agent-source:' + _attr(anchor) +
          '" data-output-agent="' + _attr(source.agentId) +
          '" title="' + _attr(LABELS[source.agentId] || '') +
          '" aria-label="' + _attr(LABELS[source.agentId] || '') + '">' + html(source.agentId) + '</div>';
      // The response identity precedes its existing time/usage row.
      const at = /data-chat-node="(?:turn-metrics"|turn-summary:)/.test(parts.at(-1) || '') ? parts.length - 1 : parts.length;
      parts.splice(at, 0, shell);
    }
    function before(parts, source, anchor, asCrew) {
      const key = sourceKey(source);
      if (opts.turnScoped) {
        if (!key || turnHead) return;
        const crewHtml = hasCrew ? opts.crewHtml(source, anchor) : null;
        header(parts, source, anchor, crewHtml?.html ? crewHtml : null);
        turnHead = true;
        return;
      }
      if (asCrew && hasCrew) {
        // Chain dedup: with a runId, dedupe by run (one crew head per run's multi-segment
        // output, by design for multi-engine tasks); without a runId, plain chats reuse the
        // engine identity key (no repeated heads within one turn's multi-segment output).
        // Cross-turn repaints are broken by the renderer calling breakRun() on user messages
        // (see the turn-boundary comment below).
        const crewKey = source && source.runId ? 'crew:' + source.runId : key;
        if (crewKey === previousCrew) return;
        previousCrew = crewKey;
        const crewHtml = opts.crewHtml(source, anchor);
        if (crewHtml && crewHtml.html) { header(parts, source, anchor, crewHtml); return; }
        // When the chain is unavailable (e.g. icon-less custom engines), fall back to a single
        // bead: previousCrew keeps the crewKey — later messages with the same runId/engine
        // identity are stopped by the dedup above (one fallback head), and re-admitted one by
        // one after breakRun() resets the turn boundary.
        header(parts, source, anchor, null);
        return;
      }
      if (key === previous) return;
      previous = key;
      if (!key) return;
      header(parts, source, anchor, null);
    }
    // Turn boundary: user messages break run attribution — same-run messages of the next
    // turn repaint the crew head; the tool-group dedup key resets too, so the new turn's
    // first tool group is not swallowed by the previous turn's same-engine group.
    function breakRun() {
      turnHead = false;
      previousCrew = '';
      previous = '';
      return undefined;
    }
    function appendTools(append, parts, input, seen, anchor, ...rest) {
      let start = 0;
      while (start < input.length) {
        const key = sourceKey(input[start].sourceAgent);
        let end = start + 1;
        while (end < input.length && sourceKey(input[end].sourceAgent) === key) end++;
        const groupAnchor = key ? anchor + ':agent:' + input[start].id : anchor;
        before(parts, input[start].sourceAgent, groupAnchor);   // Legacy mode keeps individual tool-group marks.
        append(parts, input.slice(start, end), seen, groupAnchor, ...rest);
        start = end;
      }
    }
    return { before, appendTools, breakRun };
  }
  function version(agent) {
    const raw = String(agent && agent.version || '').trim();
    if (canonical(agent) !== 'dsh') return raw;
    // CLI banners may include the package name; keep diagnostic metadata unchanged.
    const match = raw.match(/^(?:@openma\/deepseek-harness-acp(?:\s+|@)|deepseek-harness-acp\s+|dsh\s+)?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/i);
    return match ? match[1] : raw;
  }
  const api = Object.freeze({ MONOGRAMS, LABELS, canonical, className, glyph, html, element, sourceKey, transcript, version });
  global.AgentBrand = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
