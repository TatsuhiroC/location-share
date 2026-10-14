import test from 'node:test';
import assert from 'node:assert/strict';
import api from '../src/api.js';
import { authenticate, clientPrefix, requestId, signCapability } from '../src/capabilities.js';
import { HOUR } from '../src/session.js';

const secret = 'e'.repeat(64), now = Date.now();
function environment(extra = {}) {
  const calls = { sessions: 0, admission: 0, initialized: 0 };
  const limiter = { limit: async () => ({ success: true }) };
  const env = {
    CAPABILITY_KEY: secret, PUBLIC_ORIGIN: 'https://location.example',
    REQUEST_LIMITER: limiter, CREATE_LIMITER: limiter, READ_LIMITER: limiter, WRITE_LIMITER: limiter, CAPABILITY_LIMITER: limiter,
    LEGACY_LIMITER: limiter, LEGACY_CAPABILITIES_UNTIL: '',
    SESSIONS: { idFromName: id => id, get: () => { calls.sessions++; return { initialize: async () => { calls.initialized++; }, perform: async () => ({ value: { status: 'waiting' } }) }; } },
    ADMISSION: { idFromName: id => id, get: () => { calls.admission++; return { admit: async () => true, legacy: async () => true }; } },
    ...extra
  };
  return { env, calls };
}
const request = (id, token, method = 'GET') => new Request(`https://location.example/api/requests/${id}`, { method, headers: { Authorization: `Bearer ${token}` } });

test('forged, role-swapped and altered-ID capabilities are blocked before database lookup', async () => {
  const id = requestId(now + HOUR);
  const submit = await signCapability(id, 'submit', secret), view = await signCapability(id, 'view', secret);
  for (const [address, token] of [[id, 's' + 'f'.repeat(64)], [id, submit], [id.slice(0, -1) + (id.endsWith('a') ? 'b' : 'a'), view]]) {
    const { env, calls } = environment();
    assert.equal((await api.fetch(request(address, token), env)).status, 401);
    assert.equal(calls.sessions, 0); assert.equal(calls.admission, 0);
  }
});

test('signed expired links are rejected at the edge without waking database objects', async () => {
  const id = requestId(now - 5000), token = await signCapability(id, 'view', secret);
  const { env, calls } = environment();
  assert.equal((await api.fetch(request(id, token), env)).status, 410);
  assert.equal(calls.sessions, 0);
});

test('new valid capabilities pass the edge check with roles separated', async () => {
  const id = requestId(now + HOUR);
  const view = await signCapability(id, 'view', secret), submit = await signCapability(id, 'submit', secret);
  assert.notEqual(view, submit);
  await authenticate(id, 'view', view, { CAPABILITY_KEY: secret }, now);
  const { env, calls } = environment();
  assert.equal((await api.fetch(request(id, view), env)).status, 200);
  assert.equal(calls.sessions, 1);
});

test('legacy compatibility expires automatically and cannot bypass its global allowance', async () => {
  const id = 'a'.repeat(32), token = 'b'.repeat(64);
  const expired = environment({ LEGACY_CAPABILITIES_UNTIL: new Date(now - 1000).toISOString() });
  assert.equal((await api.fetch(request(id, token), expired.env)).status, 401);
  assert.equal(expired.calls.sessions, 0);
  const denied = environment({ LEGACY_CAPABILITIES_UNTIL: new Date(now + HOUR).toISOString(), ADMISSION: { idFromName: id => id, get: () => ({ legacy: async () => false }) } });
  const response = await api.fetch(request(id, token), denied.env);
  assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(denied.calls.sessions, 0);
  const allowed = environment({ LEGACY_CAPABILITIES_UNTIL: new Date(now + HOUR).toISOString() });
  assert.equal((await api.fetch(request(id, token), allowed.env)).status, 200);
  assert.equal(allowed.calls.sessions, 1);
});

test('without a production signing key creation fails without charging quota or writing a record', async () => {
  const { env, calls } = environment({ CAPABILITY_KEY: '' });
  const response = await api.fetch(new Request('https://location.example/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env);
  assert.equal(response.status, 503); assert.equal(calls.sessions, 0); assert.equal(calls.admission, 0);
});

test('IPv6 aliases and rotating host addresses share one /64 quota; distinct prefixes stay separate', () => {
  assert.equal(clientPrefix('2001:db8:abcd:12::1'), clientPrefix('2001:0db8:abcd:0012:ffff:1:2:3'));
  assert.notEqual(clientPrefix('2001:db8:abcd:12::1'), clientPrefix('2001:db8:abcd:13::1'));
  assert.equal(clientPrefix('::ffff:192.0.2.4'), clientPrefix('192.0.2.4'));
  assert.equal(clientPrefix('::ffff:c000:204'), clientPrefix('192.0.2.4'));
  assert.equal(clientPrefix('::1'), '0:0:0:0::/64');
});

test('a stalled JSON body times out without creating state or occupying creation quota', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  const { env, calls } = environment();
  const response = await api.fetch(new Request('https://location.example/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' }), env);
  assert.equal(response.status, 408); assert.equal(calls.sessions, 0); assert.equal(calls.admission, 0); assert.equal(cancelled, true);
});

test('a capability request budget blocks distributed reuse before storage, while deletion remains available', async () => {
  const id = requestId(now + HOUR), token = await signCapability(id, 'view', secret);
  const { env, calls } = environment({ CAPABILITY_LIMITER: { limit: async ({ key }) => ({ success: key.endsWith(':delete') }) } });
  assert.equal((await api.fetch(request(id, token), env)).status, 429);
  assert.equal(calls.sessions, 0);
  assert.equal((await api.fetch(request(id, token, 'DELETE'), env)).status, 200);
  assert.equal(calls.sessions, 1);
  env.CAPABILITY_LIMITER.limit = async () => ({ success: false });
  assert.equal((await api.fetch(request(id, token, 'DELETE'), env)).status, 429);
  assert.equal(calls.sessions, 1);
});

test('forged signed links never fall back to the legacy compatibility database path', async () => {
  const id = requestId(now + HOUR);
  const { env, calls } = environment({ LEGACY_CAPABILITIES_UNTIL: new Date(now + HOUR).toISOString() });
  assert.equal((await api.fetch(request(id, 's' + 'f'.repeat(64)), env)).status, 401);
  assert.equal(calls.sessions, 0); assert.equal(calls.admission, 0);
});
