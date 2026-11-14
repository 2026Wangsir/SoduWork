'use strict';
const { randomUUID } = require('crypto');
const media = require('./media-artifacts');
const { imageChoice } = require('./image-model');
const { fetchWithDeviceAuthRetry } = require('../device-auth-request');

/* A direct image turn uses the ordinary session transcript, tool events and
 * output index. It never calls the text model or invents token usage. */
async function generate({ handle, identity, choice, text, submissionId, signal, push, emit,
  fetchImpl = global.fetch }) {
  const selected = imageChoice(choice);
  if (!selected) return { ok: false, reason: '请选择可用的图片模型' };
  if (selected.name.startsWith('local:')) return require('./local-image-turn.cjs').generate({
    handle, selected, text, submissionId, signal, push, emit, fetchImpl,
  });
  const generationId = submissionId || randomUUID();
  const callId = 'image-' + generationId;
  const args = { prompt: text, model: selected.name, providerId: selected.providerId, generationId };
  const event = { toolCallId: callId, toolName: 'generate_image', args };
  const hub = String(identity.hub || '').replace(/\/+$/, '');
  let generated = false;
  push({ type: 'agent_start' });
  handle.appendTaskMessage('user', text, [], '', 'image-user:' + generationId);
  handle.appendTaskTool({ ...event, type: 'tool_execution_start' }, '');
  emit({ kind: 'image-generation' });
  try {
    const response = await fetchWithDeviceAuthRetry(identity,
      hub + '/api/v1/conversations/' + encodeURIComponent(handle.sessionId) + '/images', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(250000)]),
    }, fetchImpl);
    if (response.status === 404) throw Error('当前服务端尚不支持对话生图，请更新服务端后重试');
    let result;
    try { result = await response.json(); } catch (_) { throw Error('图片服务响应无法识别，请检查服务端状态'); }
    if (!response.ok || !result?.ok || result.artifact?.kind !== 'image') {
      // Backend owns the error vocabulary; do not display arbitrary provider payloads.
      throw Error(typeof result?.detail === 'string' ? result.detail.slice(0, 400) : '图片生成未完成，请检查图片模型配置');
    }
    generated = true;
    const file = await media.materialize(result.artifact, identity, handle.cwd, fetchImpl, signal);
    handle.appendTaskTool({ ...event, type: 'tool_execution_end', isError: false,
      result: { content: [{ type: 'text', text: JSON.stringify({ file: file.relative, model: selected.name }) }] } }, '');
    const link = file.relative.split('/').map(encodeURIComponent).join('/');
    handle.appendTaskMessage('assistant', '图片已生成。\n\n[查看图片](' + link + ')', [], '', 'image-result:' + generationId, selected.name);
    emit({ kind: 'settled', mediaArtifact: file });
    return { ok: true, artifact: file };
  } catch (error) {
    const cancelled = signal.aborted;
    const reason = generated ? '图片已在服务端生成，本地下载未完成；重新打开会话可恢复成果。' :
      cancelled ? '已停止等待图片生成。已提交的请求可能仍在模型服务处理，重新生成前请先检查成果。' :
        String(error?.message || '图片生成失败').slice(0, 400);
    handle.appendTaskTool({ ...event, type: 'tool_execution_end', isError: true,
      result: { content: [{ type: 'text', text: reason }] } }, '');
    handle.appendTaskMessage('assistant', reason, [], '', 'image-error:' + generationId, selected.name);
    return cancelled ? { ok: true, cancelled: true } : { ok: false, reason, retrySafe: false };
  } finally {
    push({ type: 'agent_settled' });
    emit({ kind: 'settled' });
  }
}
module.exports = { generate };
