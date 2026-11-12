'use strict';

// Select delivery roots, never delete workspace history. Dependency collection
// still owns the complete file set required to use each selected root.
const path = require('node:path');
const processRoles = new Set(['process', 'evidence', 'verification', 'input', 'internal']);
const normalize = value => String(value || '').replace(/\\/g, '/').normalize('NFC');
function text(message) {
  if (typeof message?.text === 'string') return message.text;
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.map(part => part.text || '').join('\n') : '';
}
function turn(snapshot = {}) {
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const start = messages.findLastIndex(message => message.role === 'user');
  return { request: start < 0 ? '' : text(messages[start]),
    answer: start < 0 ? '' : text(messages.slice(start + 1).findLast(message => message.role === 'assistant')) };
}
function requestedExtension(request) {
  if (!/(?:生成|转换?|导出|另存|改成|改为|generate|convert|export|save\s+as)/i.test(request)) return '';
  const target = request.match(/(?:转(?:换)?(?:为|成)|改成|改为|导出为|另存为|\b(?:to|as)\s+)([^，。;\n]{1,40})/i)?.[1] || request;
  const formats = [
    ['.docx', /(?:\bword\b|\bdocx\b)/i], ['.pdf', /\bpdf\b/i],
    ['.md', /(?:\bmarkdown\b|\bmd\b)/i], ['.html', /(?:\bhtml\b|网页)/i],
    ['.xlsx', /(?:\bexcel\b|\bxlsx\b)/i], ['.pptx', /(?:\bpptx?\b|\bpowerpoint\b)/i],
  ].filter(([, pattern]) => pattern.test(target));
  if (formats.length !== 1) return '';
  const [extension, format] = formats[0];
  // Recognize only a complete positive conversion plus an exclusive target
  // clause. Extra instructions or negation must retain the existing manifest;
  // removing individual "keep only" phrases loses their surrounding meaning.
  const namedFormat = '(?:' + format.source + ')';
  const exclusive = new RegExp('^\\s*(?:(?:请)?(?:把(?:交付)?格式)?' +
    '(?:生成|转换?(?:为|成)?|导出(?:为)?|另存(?:为)?|改成|改为)\\s*' + namedFormat +
    '|(?:please\\s+)?(?:generate|convert(?:\\s+to)?|export(?:\\s+(?:to|as))?|save\\s+as)\\s+' + namedFormat + ')' +
    '\\s*(?:[，,。.;；\\n]|\\band\\b|并且|并)\\s*' +
    '(?:(?:请)?(?:只|仅|仅仅)\\s*保留\\s*(?:(?:最终|最后|最新)(?:的)?\\s*)?|' +
    '(?:please\\s+)?(?:keep\\s+only|only\\s+keep)\\s+(?:the\\s+)?(?:(?:final|latest)\\s+)?)' +
    namedFormat + '\\s*(?:文件|文档|格式|版本|file|document|format|version)?\\s*[。.!！]?\\s*$', 'i');
  if (/(?:同时|都要|两种|两份|保留|以及|和|both|keep|alongside|as well)/i.test(request) && !exclusive.test(request)) return '';
  return extension;
}
function requestsCaptures(request) {
  return /(?:交付|提供|生成|导出|保存|附上|需要|要).{0,20}(?:截图|效果图)|(?:deliver|provide|export|save|include).{0,30}(?:screenshot|screen capture)/i.test(request) &&
    !/(?:不要|不需要|无需).{0,12}(?:截图|效果图)|(?:do not|don't|without).{0,20}screenshot/i.test(request);
}
function mentioned(answer, cwd, item) {
  const relative = normalize(item.relative || item.name);
  const absolute = normalize(path.resolve(cwd, relative));
  // Only explicit local file links count; prose and verification transcripts do not.
  return Array.from(answer.matchAll(/\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)).some(match => {
    let target; try { target = normalize(decodeURIComponent(match[1])); } catch { return false; }
    return target === relative || target === './' + relative || target === absolute;
  });
}
function select(cwd, delivery, snapshot) {
  const { request, answer } = turn(snapshot);
  let items = (delivery.items || []).filter(item => item.primary !== false && item.role !== 'supporting' && !processRoles.has(item.role));
  const replaced = new Set(items.flatMap(item => Array.isArray(item.replaces) ? item.replaces.map(normalize) : []));
  items = items.filter(item => !replaced.has(normalize(item.relative || item.name)));
  const extension = requestedExtension(request);
  const converted = extension ? items.filter(item => item.changedInTurn &&
    path.extname(String(item.relative || item.name || item.path || '')).toLowerCase() === extension) : [];
  if (extension && converted.length) {
    // A conversion selects its new format. Explicit requests for both formats
    // bypass this rule, and source files remain available in the inventory.
    items = converted;
  } else if (delivery.source !== 'manifest') {
    const linked = items.filter(item => item.changedInTurn && mentioned(answer, cwd, item));
    if (linked.length) items = linked;
  }
  return { ...delivery, items };
}
module.exports = { select, turn, requestsCaptures, processRoles };
