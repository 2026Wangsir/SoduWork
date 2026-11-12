'use strict';
// Real production session, SDK and HTTP streaming. Only model/auth discovery
// and the model endpoint are fixtures; user profiles and business data are unused.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { pathToFileURL } = require('node:url');
async function create(root, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const sdk = await import(pathToFileURL(path.resolve(__dirname, '../../node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  signal?.throwIfAborted();
  const config = require('../../main/pi-session/model-config');
  const sessions = require('../../main/pi-session/session');
  const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  const loaded = path.join(root, 'extension-loads.txt'), executed = path.join(root, 'executions.txt');
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  fs.writeFileSync(path.join(agentDir, 'extensions/search.ts'), `import fs from 'node:fs';
export default async function(pi) {
  await new Promise(resolve => setTimeout(resolve, ${options.loadDelay || 0}));
  fs.appendFileSync(${JSON.stringify(loaded)}, 'loaded\\n');
  pi.registerTool({name:'web_search',label:'Search fixture',description:'Search isolated fixture data',
    parameters:{type:'object',properties:{query:{type:'string'}},required:['query']},
    async execute(id,args) { fs.appendFileSync(${JSON.stringify(executed)}, args.query+'\\n');
      return {content:[{type:'text',text:'Search results: fixture source verified'}],details:{}}; }});
}`);
  const requests = []; let reply = () => ({ text: 'Fixture complete.' });
  const sockets = new Set();
  let closed = false;
  const server = http.createServer((request, response) => {
    request.setEncoding('utf8'); // HTTP chunks may split a multi-byte Chinese character.
    let raw = ''; request.on('data', data => { raw += data; });
    request.on('end', async () => {
      try {
        const body = JSON.parse(raw); requests.push(body);
        const result = await reply(body, requests.length);
        if (response.destroyed) return;
        if (typeof result.respond === 'function') { await result.respond(response, body); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (delta, finish_reason, usage) => response.write('data: ' + JSON.stringify({
          id: 'resumed-pi-fixture', object: 'chat.completion.chunk', model: 'fixture-model',
          choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
        }) + '\n\n');
        send(result.tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + requests.length,
          type: 'function', function: { name: result.tool, arguments: JSON.stringify(result.args || {}) } }] }
          : { role: 'assistant', content: result.text || '' }, null);
        send({}, result.tool ? 'tool_calls' : 'stop', { prompt_tokens: 20,
          completion_tokens: result.text === '' ? 0 : 8, total_tokens: result.text === '' ? 20 : 28 });
        response.end('data: [DONE]\n\n');
      } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closed) socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let handle, closing, restore = () => {};
  const onAbort = () => { void close().catch(() => {}); };
  async function close() {
    if (closing) return closing;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    closing = (async () => {
      try { handle?.cancel(); handle?.close(); }
      finally {
        restore();
        // Windows can still have replacement connections queued after abort.
        // Keep the closed guard active while their connection events drain.
        if (process.platform === 'win32') await new Promise(resolve => setTimeout(resolve, 100));
        // Stop accepting before destroying SSE/keep-alive sockets.
        const stopped = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await stopped;
      }
    })();
    return closing;
  }
  try {
  signal?.throwIfAborted();
  const model = { id: 'fixture-model', label: 'Local regression model', contextWindow: options.contextWindow || 200000,
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', key: 'isolated-local-fixture',
    proxyExpiresAt: Date.now() + 3600000 };
  // Keep local fault-injection traffic off any machine-wide HTTP proxy.
  config.noProxyFor(model.baseUrl);
  const modelsPath = config.writeModels(agentDir, model);
  const previousPrepare = config.prepare, previousCreate = sdk.ModelRuntime.create, previousKey = process.env.SODUWORK_PROXY_KEY;
  const prepareFixture = async () => ({ ok: true, provider: 'soduwork', agentDir, model });
  const createFixture = () => previousCreate.call(sdk.ModelRuntime, { modelsPath,
    authPath: path.join(agentDir, 'auth.json'), modelsStorePath: path.join(agentDir, 'models.db') });
  config.prepare = prepareFixture; sdk.ModelRuntime.create = createFixture;
  process.env.SODUWORK_PROXY_KEY = 'isolated-local-fixture';
  restore = () => {
    // A timed-out initializer must not restore over a later fixture's hooks.
    if (config.prepare === prepareFixture) config.prepare = previousPrepare;
    if (sdk.ModelRuntime.create === createFixture) sdk.ModelRuntime.create = previousCreate;
    if (previousKey === undefined) delete process.env.SODUWORK_PROXY_KEY; else process.env.SODUWORK_PROXY_KEY = previousKey;
  };
  const archive = sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions'));
  archive.appendMessage({ role: 'user', content: options.historyImage ? [
    {type:'text',text:'Create an isolated report using this screenshot'},
    {type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxqkAAAAASUVORK5CYII='},
  ] : 'Create an isolated report', timestamp: 1000 });
  archive.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Previous report is preserved.' }],
    api: 'openai-completions', provider: 'soduwork', model: model.id, stopReason: 'stop', timestamp: 1001,
    usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 28,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const resumePath = archive.getSessionFile(), archivePrefix = fs.readFileSync(resumePath, 'utf8');
  signal?.addEventListener('abort', onAbort, { once: true });
  return { sdk, cwd, agentDir, requests, loaded, executed, resumePath, archivePrefix,
    reply(value) { reply = value; },
    get handle() { return handle; },
    async open(overrides = {}) {
      if (closed) throw Error('Fixture is closed');
      signal?.throwIfAborted();
      try {
      const result = await sessions.open({ app: { isPackaged: false, getPath: () => root }, identity: {},
        cwd, resumePath, noExtensions: true, skillDirs: [], ...overrides });
      if (!result.ok) throw Error(result.reason);
      handle = result.session;
      // Timeout may have closed the listener while sessions.open was pending.
      if (closed || signal?.aborted) {
        handle.cancel(); handle.close();
        signal?.throwIfAborted(); throw Error('Fixture is closed');
      }
      return handle;
      } catch (error) {
        // The caller already owns this fixture and may intentionally retry a
        // failed runtime startup. Only cancellation retires its HTTP server;
        // wrapper factories close the fixture if their initial open fails.
        if (closed || signal?.aborted) await close();
        throw error;
      }
    },
    close,
  };
  } catch (error) { await close(); throw error; }
}
module.exports = { create };
