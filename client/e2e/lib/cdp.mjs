const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function endpoint(port, path) {
  return 'http://127.0.0.1:' + Number(port || 9222) + path;
}

export async function listPages(port = 9222, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 5000));
  try {
    const response = await fetch(endpoint(port, '/json/list'), { signal: controller.signal });
    if (!response.ok) throw new Error('CDP ' + port + ' 返回 HTTP ' + response.status);
    const rows = await response.json();
    return rows.filter((row) => row && row.type === 'page');
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('CDP ' + port + ' 在 ' + timeoutMs + 'ms 内没有响应');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForPage(port, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await listPages(port);
    const page = last.find(predicate);
    if (page) return page;
    await delay(120);
  }
  throw new Error('等待窗口超时；当前页面：' + last.map((row) => row.url).join(' | '));
}

export async function waitForPageGone(port, id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await listPages(port);
    if (!rows.some((row) => row.id === id)) return true;
    await delay(120);
  }
  return false;
}

export class CdpPage {
  constructor(target) {
    this.target = target;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.runtimeErrors = [];
  }

  static async connect(target) {
    const page = new CdpPage(target);
    await page.open();
    return page;
  }

  async open() {
    if (this.ws) return this;
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接页面调试通道超时')), 5000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('页面调试通道连接失败'));
      }, { once: true });
    });
    this.ws.addEventListener('message', (event) => this.onMessage(event));
    this.ws.addEventListener('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('页面已关闭'));
      this.pending.clear();
    });
    await this.call('Runtime.enable');
    await this.call('Log.enable');
    return this;
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params && message.params.exceptionDetails;
      const value = detail && detail.exception;
      this.runtimeErrors.push((value && (value.description || value.value)) ||
        (detail && detail.text) || '页面运行异常');
    }
    if (message.method === 'Log.entryAdded') {
      const entry = message.params && message.params.entry;
    if (entry && entry.level === 'error') this.runtimeErrors.push((entry.text || '页面错误日志') +
      (entry.url ? ' [' + entry.url + ']' : ''));
    }
  }

  call(method, params = {}, timeoutMs = 10000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('页面调试通道未连接'));
    }
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' 超时'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async evaluate(expression, timeoutMs = 12000) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails;
      const value = detail.exception || {};
      throw new Error(value.description || value.value || detail.text || '页面求值失败');
    }
    return response.result && response.result.value;
  }

  run(fn, argument, timeoutMs = 12000) {
    const source = '(' + fn.toString() + ')(' + JSON.stringify(argument) + ')';
    return this.evaluate(source, timeoutMs);
  }

  async waitFor(fn, argument, timeoutMs = 8000, intervalMs = 120) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.run(fn, argument, Math.min(5000, timeoutMs));
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await delay(intervalMs);
    }
    throw new Error('页面条件等待超时：' + fn.toString().slice(0,220) + '；最后结果：' + JSON.stringify(last));
  }

  takeRuntimeErrors() {
    const rows = this.runtimeErrors.slice();
    this.runtimeErrors.length = 0;
    return rows;
  }

  close() {
    if (!this.ws) return;
    try { this.ws.close(); } catch (_error) {}
    this.ws = null;
  }
}

export { delay };
