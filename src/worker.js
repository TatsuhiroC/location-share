import { DurableObject } from 'cloudflare:workers';
import { ApiError, execute, randomHex, digest, metadata, ID_RE, HOUR } from './session.js';

const SECURITY = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org https://tiles.openfreemap.org; connect-src 'self' https://tiles.openfreemap.org; worker-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  'Strict-Transport-Security': 'max-age=31536000'
};

function secure(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function readJson(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED');
  if (Number(request.headers.get('Content-Length')) > 4096) throw new ApiError(413, 'TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_REQUEST');
  let size = 0;
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new ApiError(413, 'TOO_LARGE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_REQUEST'); }
}

function bearer(request) {
  return /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
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
      const client = await digest(request.headers.get('CF-Connecting-IP') || 'local');
      await limit(env, 'REQUEST_LIMITER', client);
      if (url.pathname === '/api/health' && request.method === 'GET') return secure(json({ ok: true, version: '0.3.2' }));
      const token = bearer(request);
      if (url.pathname === '/api/requests' && request.method === 'POST') {
        await limit(env, 'CREATE_LIMITER', client);
        const data = metadata(await readJson(request));
        // Anonymous creation remains bounded; invalid input does not consume admission quota.
        if (!await env.ADMISSION.get(env.ADMISSION.idFromName('global')).admit(client)) throw new ApiError(429, 'RATE_LIMITED');
        const id = randomHex(16), submitToken = randomHex(), viewToken = randomHex(), now = Date.now();
        const record = {
          initiator: data.initiator, createdAt: now, expiresAt: now + HOUR,
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
      if (action === 'submit') await limit(env, 'WRITE_LIMITER', client);
      else if (action !== 'delete') await limit(env, 'READ_LIMITER', client);
      const body = action === 'submit' ? await readJson(request) : null;
      const result = await env.SESSIONS.get(env.SESSIONS.idFromName(match[1])).perform(action, token, body);
      return secure(json(result.error ? { error: result.error.code } : result.value, result.error?.status || 200));
    } catch (error) {
      if (error instanceof ApiError) return secure(json({ error: error.code }, error.status));
      return secure(json({ error: 'SERVICE_UNAVAILABLE' }, 503));
    }
  }
};

export class LocationSession extends DurableObject {
  async initialize(record) {
    await this.ctx.storage.transaction(async tx => {
      if (await tx.get('record')) throw new Error('Already initialized');
      await tx.put('record', record);
      await this.ctx.storage.setAlarm(record.expiresAt);
    });
  }
  async perform(action, token, body) {
    try { return { value: await execute(this.ctx.storage, action, token, body) }; }
    catch (error) {
      if (error instanceof ApiError) return { error: { status: error.status, code: error.code } };
      throw error;
    }
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

export class Admission extends DurableObject {
  async admit(client) {
    const now = Date.now();
    return this.ctx.storage.transaction(async tx => {
      let state = await tx.get('limits');
      const day = Math.floor(now / (24 * HOUR));
      if (!state || state.day !== day || state.version !== 2) state = { version: 2, day, total: 0, clients: {} };
      for (const [key, entry] of Object.entries(state.clients)) if (now - entry.since >= 60000) delete state.clients[key];
      const entry = state.clients[client] || { since: now, count: 0 };
      if (state.total >= 300 || entry.count >= 5) return false;
      state.total++; entry.count++;
      state.clients[client] = entry;
      await tx.put('limits', state);
      await this.ctx.storage.setAlarm((day + 1) * 24 * HOUR);
      return true;
    });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
