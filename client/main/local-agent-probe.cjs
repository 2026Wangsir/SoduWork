'use strict';

const catalog = require('./agent-runtime/runtime-catalog');
const runnerConfig = require('./agent-runtime/runner-config.cjs');

// Private probes use only the desktop's parent pipe. No Hub request, device
// model reference, or provider diagnostic is part of this control protocol.
async function run({ runner, agentId, model, assertCurrent = () => {}, timeoutMs = 300000,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (catalog.runtime(agentId)?.modelMode !== 'managed' || !model?.localOnly || model.modality !== 'chat') {
    throw Error('请选择受管型 Agent 和本机对话模型');
  }
  assertCurrent();
  const cfg = runnerConfig.create({ ...model, id: model.modelRef, wireModelId: model.name,
    maxOutputTokens: model.config?.maxOutputTokens }, agentId);
  const started = await runner.rpc('agent.probe', { key: agentId, llm: cfg.llm }, 15000);
  assertCurrent();
  if (!started?.ok || started.data?.private !== true || !/^[A-Za-z0-9-]{1,100}$/.test(started.data?.jobId || '')) {
    throw Error('本机执行机未接受私有模型测试，请更新或重启执行机');
  }
  const until = now() + timeoutMs;
  while (now() < until) {
    assertCurrent();
    const result = await runner.rpc('agent.job', { jobId: started.data.jobId }, 15000);
    assertCurrent();
    const job = result?.data;
    if (!result?.ok || !job || job.id !== started.data.jobId || job.key !== agentId || job.action !== 'probe') {
      throw Error('本机 Agent 测试回执不完整，请重试');
    }
    if (job.state === 'done') return { ok: job.ok === true, probeKind: 'agent-execution',
      detail: job.ok === true ? '本地模型与 Agent 实际执行测试通过' : '本地模型与 Agent 实际执行测试未通过，请检查模型和底座配置' };
    await sleep(500);
  }
  return { ok: false, probeKind: 'agent-execution', detail: '本机 Agent 测试等待超时，请稍后重新检查执行机状态' };
}

module.exports = { run };
