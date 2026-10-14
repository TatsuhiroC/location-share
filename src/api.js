import { ApiError, digest, metadata, ID_RE, HOUR } from './session.js';

import { SECURITY } from './security.js';
import { authenticate, clientPrefix, requestId, signCapability } from './capabilities.js';

function secure(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

async function readJson(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED');
  if (Number(request.headers.get('Content-Length')) > 4096) throw new ApiError(413, 'TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_REQUEST');
  let timer;
  try {
    return await Promise.race([
      (async () => {
        let size = 0; const chunks = [];
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) { void reader.cancel().catch(() => {}); throw new ApiError(413, 'TOO_LARGE'); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw new ApiError(400, 'INVALID_REQUEST'); }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new ApiError(408, 'REQUEST_TIMEOUT')); void reader.cancel().catch(() => {}); }, 5000);
      })
    ]);
  } finally { clearTimeout(timer); }
}

function bearer(request) {
  return /^Bearer ((?:s)?[a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
}

async function limit(env, name, key) {
  if (!env[name]) throw new ApiError(503, 'SERVICE_UNAVAILABLE');
  if (!(await env[name].limit({ key })).success) throw new ApiError(429, 'RATE_LIMITED');
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (env.PUBLIC_ORIGIN && url.origin !== env.PUBLIC_ORIGIN) throw new ApiError(403, 'ORIGIN_DENIED');
      if (!url.pathname.startsWith('/api/')) return secure(await env.ASSETS.fetch(request));
      if (url.search) throw new ApiError(400, 'INVALID_REQUEST');
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new ApiError(403, 'ORIGIN_DENIED');
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'ORIGIN_DENIED');
      const client = await digest(clientPrefix(request.headers.get('CF-Connecting-IP')));
      await limit(env, 'REQUEST_LIMITER', client);
      if (url.pathname === '/api/health' && request.method === 'GET') return secure(json({ ok: true, version: '0.4.0' }));
      const token = bearer(request);
      if (url.pathname === '/api/requests' && request.method === 'POST') {
        await limit(env, 'CREATE_LIMITER', client);
        const data = metadata(await readJson(request));
        const now = Date.now(), expiresAt = now + HOUR, id = requestId(expiresAt);
        const submitToken = await signCapability(id, 'submit', env.CAPABILITY_KEY);
        const viewToken = await signCapability(id, 'view', env.CAPABILITY_KEY);
        // Anonymous creation remains bounded; invalid input does not consume admission quota.
        if (!await env.ADMISSION.get(env.ADMISSION.idFromName('global')).admit(client)) throw new ApiError(429, 'RATE_LIMITED');
        const record = {
          initiator: data.initiator, createdAt: now, expiresAt,
          submitHash: await digest(submitToken), viewHash: await digest(viewToken), position: null
        };
        await env.SESSIONS.get(env.SESSIONS.idFromName(id)).initialize(record);
        return secure(json({ id, submitToken, viewToken, expiresAt: record.expiresAt }, 201));
      }
      const match = /^\/api\/requests\/([a-f0-9]{32})(?:\/(info|location))?$/.exec(url.pathname);
      if (!match || !ID_RE.test(match[1])) throw new ApiError(404, 'NOT_FOUND');
      let action;
      if (request.method === 'GET' && match[2] === 'info') action = 'info';
      else if (request.method === 'POST' && match[2] === 'location') action = 'submit';
      else if (request.method === 'GET' && !match[2]) action = 'read';
      else if (request.method === 'DELETE' && !match[2]) action = 'delete';
      else throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      if (!token) throw new ApiError(401, 'UNAUTHORIZED');
      await authenticate(match[1], action === 'info' || action === 'submit' ? 'submit' : 'view', token, env);
      const budget = action === 'delete' ? 'delete' : action === 'submit' || action === 'info' ? 'submit' : 'view';
      await limit(env, 'CAPABILITY_LIMITER', `${match[1]}:${budget}`);
      if (action === 'submit') await limit(env, 'WRITE_LIMITER', client);
      else if (action !== 'delete') await limit(env, 'READ_LIMITER', client);
      const body = action === 'submit' ? await readJson(request) : null;
      const result = await env.SESSIONS.get(env.SESSIONS.idFromName(match[1])).perform(action, token, body);
      return secure(json(result.error ? { error: result.error.code } : result.value, result.error?.status || 200, result.error?.status === 429 ? { 'Retry-After': '60' } : {}));
    } catch (error) {
      if (error instanceof ApiError) return secure(json({ error: error.code }, error.status, error.status === 429 ? { 'Retry-After': '60' } : {}));
      return secure(json({ error: 'SERVICE_UNAVAILABLE' }, 503));
    }
  }
};
