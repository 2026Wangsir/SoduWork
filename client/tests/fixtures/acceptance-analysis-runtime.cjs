'use strict';
const { prepare } = require('../../main/pi-session/acceptance-turn');
const stream = require('../../main/pi-session/event-stream');
const { createTurnQueue } = require('../../main/pi-session/turn-queue');

// Only the provider and Hub are synthetic. Turn completion, stream normalization
// and durable native message construction use the production implementations.
async function create({ cwd, turnId = 'analysis-turn', text = '建议通过。逐项核验：交付物.md 包含要求的三项内容。',
  stopReason = 'stop', approvalId = 'approval-current', modelName = 'local:model-0123456789abcdef0123456789abcdef' } = {}) {
  const acc = stream.create(), queue = createTurnQueue(), journal = [], requests = [], events = [], providerMessages = [];
  const review = { task: { id: 'acceptance-task', title: 'Verify delivery', status: 'done',
    canReview: true, requirementVersion: 3 }, approvalId, artifactVersionId: 'artifact-current',
    requirementVersion: 3, canDecide: true, criteria: [{ id: 'criterion-1', label: 'Includes all three items' }],
    attachmentIds: [], attachments: [] };
  const piSession = { sessionId: 'acceptance-chat', agent: { state: { messages: [] } },
    sessionManager: { appendMessage: message => journal.push(structuredClone(message)) } };
  const ctx = { acc, turnQueue: queue, piSession, shared: { stream }, prep: { model: { api: 'openai-completions', id: modelName } },
    taskBinding: { taskIds: [], taskBindings: [] }, resources: { skills: [] }, goal: {}, run: {},
    listeners: new Set(), ref: 'acceptance-view', effectiveCwd: cwd,
    _snapshot: () => acc.snapshot(), _emit: event => events.push(event) };
  const handle = require('../../main/pi-session/session-handle').create(ctx);
  ctx.handle = handle;
  const turn = await prepare({ identity: { hub: 'http://127.0.0.1:1', clientId: 'fixture-device' },
    taskId: review.task.id, turnId, requested: { acceptanceMode: 'manual' }, runtime: { handle },
    request: async (_identity, route, body) => { requests.push({ route, body }); return review; } });
  const item = queue.add({ text: turn.displayText, options: { submissionId: turn.submissionId,
    beforeTurn: turn.beforeTurn, afterTurn: turn.afterTurn } });
  async function run(onStream) {
    return queue.run(queue.take(), async () => {
      const user = { role: 'user', content: turn.displayText,
        submissionId: turn.submissionId, timestamp: Date.now() };
      providerMessages.push(user);
      acc.push({ type: 'message_end', message: user });
      acc.push({ type: 'message_start', message: { role: 'assistant' } });
      for (const chunk of [text.slice(0, 9), text.slice(9)]) {
        acc.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk } });
        if (onStream) await onStream(acc.snapshot());
      }
      const answer = { role: 'assistant', stopReason,
        content: [{ type: 'text', text }], timestamp: Date.now() };
      providerMessages.push(answer);
      acc.push({ type: 'message_end', message: answer });
      acc.push({ type: 'agent_settled' });
      return { ok: true, snapshot: acc.snapshot() };
    });
  }
  return { run, acc, journal, requests, events, turn, item, review, handle,
    transcript: () => [...providerMessages, ...journal] };
}
module.exports = { create };
