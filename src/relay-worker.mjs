const DEFAULT_CLIENT_TIMEOUT_MS = 65000;
const DEFAULT_AGENT_POLL_TIMEOUT_MS = 25000;
const DEFAULT_AGENT_STALE_MS = 45000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function json(data, status = 200, headers = {}) {
  return withCors(new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  }));
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET,POST,HEAD,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type,x-mobile-typer-token,authorization');
  headers.set('access-control-allow-private-network', 'true');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function envNumber(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function allowedDeviceIds(env) {
  const raw = String(env.DEVICE_IDS || env.DEVICE_ID || '').trim();
  if (!raw) return null;
  return new Set(raw.split(',').map(item => item.trim()).filter(Boolean));
}

function isDeviceAllowed(deviceId, env) {
  const allowed = allowedDeviceIds(env);
  return !allowed || allowed.has(deviceId);
}

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim();
  return /^[a-zA-Z0-9._-]{3,80}$/.test(deviceId) ? deviceId : '';
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += chunkSize) {
    binary += String.fromCharCode(...view.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function filteredHeaders(headers, options = {}) {
  const out = {};
  for (const [key, value] of headers) {
    const normalized = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (normalized.startsWith('cf-')) continue;
    if (!options.keepSetCookie && normalized === 'set-cookie') continue;
    out[normalized] = value;
  }
  return out;
}

function remoteMatch(pathname) {
  return pathname.match(/^\/remote\/([^/]+)(\/.*)?$/);
}

function agentMatch(pathname) {
  return pathname.match(/^\/agent\/([^/]+)\/(poll|respond)$/);
}

function objectForDevice(env, deviceId) {
  const id = env.RELAY_SESSION.idFromName(`device:${deviceId}`);
  return env.RELAY_SESSION.get(id);
}

function rewriteForDurableObject(request, env, deviceId) {
  return objectForDevice(env, deviceId).fetch(request);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ ok: true, service: 'codexpanel-wan', now: new Date().toISOString() });
    }

    const remote = remoteMatch(url.pathname);
    if (remote) {
      const deviceId = normalizeDeviceId(remote[1]);
      if (!deviceId) return json({ ok: false, code: 'BAD_DEVICE_ID', message: 'Bad device id.' }, 400);
      if (!isDeviceAllowed(deviceId, env)) return json({ ok: false, code: 'DEVICE_NOT_ALLOWED', message: 'Device is not allowed.' }, 403);
      return rewriteForDurableObject(request, env, deviceId);
    }

    const agent = agentMatch(url.pathname);
    if (agent) {
      const deviceId = normalizeDeviceId(agent[1]);
      if (!deviceId) return json({ ok: false, code: 'BAD_DEVICE_ID', message: 'Bad device id.' }, 400);
      if (!isDeviceAllowed(deviceId, env)) return json({ ok: false, code: 'DEVICE_NOT_ALLOWED', message: 'Device is not allowed.' }, 403);
      return rewriteForDurableObject(request, env, deviceId);
    }

    return json({
      ok: true,
      service: 'codexpanel-wan',
      message: 'Open /remote/<deviceId>/?token=<local-token> from your phone.',
    });
  },
};

export class CodexRelaySession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pendingRequests = [];
    this.waitingClients = new Map();
    this.waitingPollers = [];
    this.lastAgentSeenAt = 0;
  }

  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const remote = remoteMatch(url.pathname);
    if (remote) return this.handleRemoteRequest(request, remote[1], remote[2] || '/');

    const agent = agentMatch(url.pathname);
    if (agent && agent[2] === 'poll') return this.handleAgentPoll(request);
    if (agent && agent[2] === 'respond') return this.handleAgentResponse(request);

    return json({ ok: false, code: 'NOT_FOUND', message: 'Not found.' }, 404);
  }

  async handleRemoteRequest(request, deviceId, upstreamPath) {
    const agentStaleMs = envNumber(this.env, 'AGENT_STALE_MS', DEFAULT_AGENT_STALE_MS);
    if (!this.waitingPollers.length && Date.now() - this.lastAgentSeenAt > agentStaleMs) {
      return json({
        ok: false,
        code: 'AGENT_OFFLINE',
        message: '电脑端 Codex Agent 不在线，请先启动本机服务。',
      }, 503);
    }

    if (this.pendingRequests.length >= MAX_PENDING_REQUESTS) {
      return json({ ok: false, code: 'QUEUE_FULL', message: 'Remote request queue is full.' }, 503);
    }

    const url = new URL(request.url);
    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    const maxBodyBytes = envNumber(this.env, 'MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES);
    if (bodyBytes.byteLength > maxBodyBytes) {
      return json({ ok: false, code: 'BODY_TOO_LARGE', message: 'Request body is too large.' }, 413);
    }

    const requestId = crypto.randomUUID();
    const task = {
      type: 'request',
      requestId,
      deviceId,
      method: request.method,
      path: `${upstreamPath || '/'}${url.search || ''}`,
      headers: filteredHeaders(request.headers),
      bodyBase64: bodyBytes.byteLength ? bytesToBase64(bodyBytes) : '',
      createdAt: new Date().toISOString(),
    };

    const timeoutMs = envNumber(this.env, 'CLIENT_TIMEOUT_MS', DEFAULT_CLIENT_TIMEOUT_MS);
    const responsePromise = new Promise(resolve => {
      const timer = setTimeout(() => {
        this.waitingClients.delete(requestId);
        resolve(json({
          ok: false,
          code: 'AGENT_TIMEOUT',
          message: '电脑端 Codex 没有及时返回，请确认本机 Agent 在线。',
        }, 504));
      }, timeoutMs);

      this.waitingClients.set(requestId, {
        resolve: payload => {
          clearTimeout(timer);
          resolve(this.responseFromAgentPayload(payload));
        },
      });
    });

    this.enqueueTask(task);
    return responsePromise;
  }

  async handleAgentPoll(request) {
    this.lastAgentSeenAt = Date.now();

    if (this.pendingRequests.length) {
      return json(this.pendingRequests.shift());
    }

    const timeoutMs = envNumber(this.env, 'AGENT_POLL_TIMEOUT_MS', DEFAULT_AGENT_POLL_TIMEOUT_MS);
    return new Promise(resolve => {
      const poller = {
        resolve,
        timer: setTimeout(() => {
          this.waitingPollers = this.waitingPollers.filter(item => item !== poller);
          resolve(json({ type: 'idle', now: new Date().toISOString() }));
        }, timeoutMs),
      };
      this.waitingPollers.push(poller);
    });
  }

  async handleAgentResponse(request) {
    let payload = {};
    try {
      payload = await request.json();
    } catch {
      return json({ ok: false, code: 'BAD_RESPONSE', message: 'Bad agent response.' }, 400);
    }

    const requestId = String(payload.requestId || '');
    const waiter = this.waitingClients.get(requestId);
    if (!waiter) {
      return json({ ok: false, code: 'CLIENT_GONE', message: 'Client request is no longer waiting.' }, 410);
    }

    this.waitingClients.delete(requestId);
    waiter.resolve(payload);
    return json({ ok: true, requestId });
  }

  enqueueTask(task) {
    const poller = this.waitingPollers.shift();
    if (poller) {
      clearTimeout(poller.timer);
      poller.resolve(json(task));
      return;
    }
    this.pendingRequests.push(task);
  }

  responseFromAgentPayload(payload) {
    const status = Math.max(100, Math.min(599, Number(payload.status) || 502));
    const headers = new Headers(payload.headers || {});
    const bodyBase64 = String(payload.bodyBase64 || '');
    const body = bodyBase64 ? base64ToBytes(bodyBase64) : null;
    return withCors(new Response(body, { status, headers }));
  }
}
