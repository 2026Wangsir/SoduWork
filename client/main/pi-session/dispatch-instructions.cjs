'use strict';

// Accept only the user's dedicated dispatch fields, never a generated prompt.
function submitted(requested) {
  if (requested.followUp === true || requested.reworkSession === true) return null;
  if (!Object.hasOwn(requested, 'dispatchInstructions')) return null;
  const value = requested.dispatchInstructions;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.note !== 'string' || value.note.length > 2000 ||
      !['default', 'manual', 'auto'].includes(value.submissionMode)) {
    throw Error('派发说明格式无效，补充内容不能超过 2000 字符');
  }
  return {note: value.note, submissionMode: value.submissionMode};
}
module.exports = {submitted};
