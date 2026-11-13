/**
 * Mã chạy BÊN TRONG tiến trình của mỗi plugin (ADR-0010). Là chuỗi JavaScript thuần (ESM, không
 * import gì ngoài module có sẵn của Node) để ghi ra một file `runner.mjs` rồi chạy bằng
 * `node --permission …` — nhờ vậy không phụ thuộc bundler và không cần cho plugin đọc mã nguồn NSA.
 *
 * Việc của nó:
 * 1. Khoá đường ra mạng: mọi socket / dns / http bị chặn; `fetch` toàn cục được thay bằng hàm
 *    đi qua tiến trình chủ (kiểm tên miền đã cấp quyền).
 * 2. Nhận lệnh từ tiến trình chủ qua kênh IPC: gọi tool, chạy việc nền, gọi hàm màn hình.
 * 3. Cho plugin một `ctx` có kiểu (xem `@nsa/plugin-sdk`).
 *
 * LƯU Ý khi sửa: không dùng dấu backtick và không dùng chuỗi `${` bên trong (đây là template literal).
 */
export const RUNNER_SOURCE = String.raw`
'use strict';
const get = (name) => process.getBuiltinModule(name);
const { pathToFileURL } = get('node:url');
const { Buffer } = get('node:buffer');

// ------------------------------------------------------------ 1. Khoá đường ra mạng
function denied(what) {
  const error = new Error(
    'NSA: plugin không được ' + what + ' trực tiếp. Dùng fetch() — đã được NSA kiểm: chỉ tới tên miền người dùng đã cấp quyền.',
  );
  error.code = 'ERR_NSA_DENIED';
  return error;
}
function lock(object, name, what) {
  try {
    object[name] = function () {
      throw denied(what);
    };
  } catch (_) {
    /* bỏ qua thuộc tính không ghi được */
  }
}
(function lockNetwork() {
  const net = get('node:net');
  const tls = get('node:tls');
  const dgram = get('node:dgram');
  const dns = get('node:dns');
  const http = get('node:http');
  const https = get('node:https');
  const http2 = get('node:http2');
  try {
    net.Socket.prototype.connect = function () {
      throw denied('mở kết nối mạng');
    };
  } catch (_) {}
  for (const n of ['connect', 'createConnection']) {
    lock(net, n, 'mở kết nối mạng');
    lock(tls, n, 'mở kết nối mạng');
  }
  lock(net, 'createServer', 'mở cổng mạng');
  lock(tls, 'createServer', 'mở cổng mạng');
  lock(dgram, 'createSocket', 'mở socket UDP');
  for (const n of ['request', 'get']) {
    lock(http, n, 'gọi HTTP');
    lock(https, n, 'gọi HTTP');
  }
  lock(http, 'createServer', 'mở cổng mạng');
  lock(https, 'createServer', 'mở cổng mạng');
  lock(http2, 'connect', 'mở kết nối mạng');
  lock(http2, 'createServer', 'mở cổng mạng');
  lock(http2, 'createSecureServer', 'mở cổng mạng');
  for (const n of Object.keys(dns)) {
    if (typeof dns[n] === 'function' && n !== 'getServers' && n !== 'setServers') lock(dns, n, 'tra DNS');
  }
  for (const n of Object.keys(dns.promises)) lock(dns.promises, n, 'tra DNS');
  lock(process, 'binding', 'dùng process.binding');
  lock(process, '_linkedBinding', 'dùng liên kết native');
  for (const n of ['WebSocket', 'EventSource']) {
    try {
      Object.defineProperty(globalThis, n, {
        configurable: true,
        get() {
          throw denied('mở kết nối mạng');
        },
      });
    } catch (_) {}
  }
  // ESM: đồng bộ lại các export có tên của module có sẵn (import { connect } from 'node:net').
  try {
    get('node:module').syncBuiltinESMExports();
  } catch (_) {}
})();

// ------------------------------------------------------------ 2. IPC với tiến trình chủ
let seq = 0;
const pending = new Map();
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = 'c' + ++seq;
    pending.set(id, { resolve, reject });
    process.send({ t: 'req', id, method, params });
  });
}
function reply(id, ok, valueOrError) {
  process.send(ok ? { t: 'res', id, ok: true, value: valueOrError } : { t: 'res', id, ok: false, error: valueOrError });
}

// fetch: toàn bộ đi qua tiến trình chủ.
async function brokerFetch(input, init) {
  const asRequest = typeof Request !== 'undefined' && input instanceof Request;
  const url = String(asRequest ? input.url : input instanceof URL ? input.href : input);
  const method = (init && init.method) || (asRequest ? input.method : 'GET');
  const headers = {};
  const source = (init && init.headers) || (asRequest ? input.headers : undefined);
  if (source) new Headers(source).forEach((value, key) => { headers[key] = value; });
  let body;
  const raw = init && init.body !== undefined ? init.body : undefined;
  if (typeof raw === 'string') body = Buffer.from(raw).toString('base64');
  else if (raw instanceof URLSearchParams) {
    body = Buffer.from(raw.toString()).toString('base64');
    if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  } else if (raw instanceof ArrayBuffer) body = Buffer.from(raw).toString('base64');
  else if (ArrayBuffer.isView(raw)) body = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64');
  else if (raw !== undefined && raw !== null) throw new TypeError('fetch trong plugin chỉ hỗ trợ body dạng chuỗi, URLSearchParams hoặc nhị phân.');
  const result = await request('fetch', { url, method, headers, body });
  const noBody = [101, 204, 205, 304].includes(result.status);
  return new Response(noBody ? null : Buffer.from(result.body, 'base64'), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}
globalThis.fetch = brokerFetch;

let definition = {};
let init = null;
let ctx = null;

function makeContext() {
  const memory = init.grants.memory
    ? {
        search: (query, options) =>
          request('memory.search', { query, limit: options && options.limit, subBranch: options && options.subBranch }),
        read: (id) => request('memory.read', { id }),
        list: (options) => request('memory.list', options || {}),
        propose: (input) => request('memory.propose', input),
      }
    : null;
  const model = init.grants.model
    ? { complete: (prompt, options) => request('model.complete', { prompt, options: options || {} }) }
    : null;
  return {
    pluginId: init.pluginId,
    version: init.version,
    dataDir: init.dataDir,
    folder(id) {
      const path = init.grants.folders[id];
      if (!path) throw new Error('Thư mục "' + id + '" chưa được người dùng cấp quyền.');
      return path;
    },
    config: {
      async get(key, fallback) {
        const value = await request('config.get', { key });
        return value === undefined || value === null ? fallback : value;
      },
      set: (key, value) => request('config.set', { key, value }),
      all: () => request('config.all', {}),
    },
    memory,
    model,
    secrets: { has: (id) => request('secret.has', { id: String(id) }) },
    gate: (action) => request('gate', action),
    log: (message, level) => process.send({ t: 'log', level: level || 'info', message: String(message) }),
    notify: (notification) => request('notify', notification),
    fetch: brokerFetch,
    emit: (event, data) => process.send({ t: 'emit', event: String(event), data }),
  };
}

async function handle(message) {
  const { id, method, params } = message;
  try {
    switch (method) {
      case 'init': {
        init = params;
        ctx = makeContext();
        const entry = pathToFileURL(process.env.NSA_PLUGIN_ENTRY).href;
        const mod = await import(entry);
        definition = (mod && mod.default) || mod || {};
        if (typeof definition.activate === 'function') await definition.activate(ctx);
        reply(id, true, {
          tools: Object.keys(definition.tools || {}),
          jobs: Object.keys(definition.jobs || {}),
          ui: Object.keys(definition.ui || {}),
        });
        return;
      }
      case 'call.tool': {
        const fn = definition.tools && definition.tools[params.name];
        if (typeof fn !== 'function') throw new Error('Plugin không có tool "' + params.name + '".');
        const value = await fn(params.args || {}, Object.assign({}, ctx, { caller: params.caller }));
        reply(id, true, value === undefined ? null : value);
        return;
      }
      case 'call.job': {
        const fn = definition.jobs && definition.jobs[params.name];
        if (typeof fn !== 'function') throw new Error('Plugin không có việc nền "' + params.name + '".');
        await fn(ctx);
        reply(id, true, null);
        return;
      }
      case 'call.ui': {
        const fn = definition.ui && definition.ui[params.name];
        if (typeof fn !== 'function') throw new Error('Plugin không có hàm màn hình "' + params.name + '".');
        const value = await fn(params.params, ctx);
        reply(id, true, value === undefined ? null : value);
        return;
      }
      case 'ping':
        reply(id, true, 'pong');
        return;
      case 'shutdown': {
        try {
          if (typeof definition.deactivate === 'function') {
            await Promise.race([definition.deactivate(), new Promise((r) => setTimeout(r, 2500))]);
          }
        } catch (_) {}
        reply(id, true, null);
        setTimeout(() => process.exit(0), 20);
        return;
      }
      default:
        throw new Error('Lệnh không hiểu: ' + method);
    }
  } catch (error) {
    reply(id, false, error && error.message ? String(error.message) : String(error));
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.t === 'res') {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else waiter.reject(new Error(message.error));
  } else if (message.t === 'req') {
    void handle(message);
  }
});
process.on('uncaughtException', (error) => {
  try {
    process.send({ t: 'log', level: 'error', message: 'uncaughtException: ' + (error && error.stack ? error.stack : error) });
  } catch (_) {}
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  try {
    process.send({ t: 'log', level: 'error', message: 'unhandledRejection: ' + (error && error.stack ? error.stack : error) });
  } catch (_) {}
  process.exit(1);
});
process.on('disconnect', () => process.exit(0));
process.send({ t: 'hello' });
`;
