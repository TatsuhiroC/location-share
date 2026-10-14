import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, digest, metadata, validatePosition, HOUR } from '../src/session.js';

class MemoryStorage {
  constructor(record) { this.values = new Map([['record', record]]); this.queue = Promise.resolve(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  transaction(fn) {
    const action = this.queue.then(async () => {
      const snapshot = structuredClone(this.values);
      try { return await fn(this); } catch (error) { this.values = snapshot; throw error; }
    });
    this.queue = action.catch(() => {});
    return action;
  }
}

const submit = 'a'.repeat(64), view = 'b'.repeat(64), now = Date.now();
const position = (submissionId = 'c'.repeat(32)) => ({ consent: true, submissionId, latitude: 31.2304, longitude: 121.4737, accuracy: 15, timestamp: now });
async function fixture() {
  return new MemoryStorage({ initiator: '小陈', createdAt: now, expiresAt: now + HOUR, submitHash: await digest(submit), viewHash: await digest(view), position: null });
}

test('submit and view capabilities cannot be interchanged; metadata never includes coordinates', async () => {
  const storage = await fixture();
  await execute(storage, 'submit', submit, position(), now);
  await assert.rejects(execute(storage, 'read', submit, null, now), { status: 401 });
  await assert.rejects(execute(storage, 'info', view, null, now), { status: 401 });
  await assert.rejects(execute(storage, 'delete', submit, null, now), { status: 401 });
  const info = await execute(storage, 'info', submit, null, now);
  assert.equal(info.status, 'received'); assert.equal(info.position, undefined);
  const result = await execute(storage, 'read', view, null, now);
  assert.equal(result.position.latitude, 31.2304); assert.equal(result.position.submissionId, undefined);
});

test('one snapshot only: parallel submissions cannot overwrite each other', async () => {
  const storage = await fixture();
  const results = await Promise.allSettled([
    execute(storage, 'submit', submit, position(), now),
    execute(storage, 'submit', submit, { ...position('d'.repeat(32)), latitude: 40 }, now)
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await execute(storage, 'read', view, null, now)).position.latitude, 31.2304);
});

test('an identical retry is idempotent; changing content with the same nonce fails', async () => {
  const storage = await fixture();
  const first = await execute(storage, 'submit', submit, position(), now);
  assert.deepEqual(await execute(storage, 'submit', submit, position(), now + 100), first);
  await assert.rejects(execute(storage, 'submit', submit, { ...position(), latitude: 30 }, now), { status: 409 });
});

test('expired records are actually removed even when the cleanup alarm is delayed', async () => {
  const storage = await fixture();
  await execute(storage, 'submit', submit, position(), now);
  await assert.rejects(execute(storage, 'read', view, null, now + HOUR), { status: 410 });
  assert.equal(await storage.get('record'), undefined);
});

test('deletion removes metadata and location and revokes both capabilities', async () => {
  const storage = await fixture();
  await execute(storage, 'submit', submit, position(), now);
  await execute(storage, 'delete', view, null, now);
  assert.equal(await storage.get('record'), undefined);
  await assert.rejects(execute(storage, 'read', view, null, now), { status: 404 });
  await assert.rejects(execute(storage, 'submit', submit, position(), now), { status: 404 });
});

test('bad coordinates, stale samples and missing consent are rejected without saving', async () => {
  for (const change of [{ latitude: 91 }, { longitude: -181 }, { accuracy: -1 }, { timestamp: now - 300001 }, { timestamp: now + 60001 }, { consent: false }, { accuracy: '15' }]) {
    const storage = await fixture();
    await assert.rejects(execute(storage, 'submit', submit, { ...position(), ...change }, now), { status: 400 });
    assert.equal((await storage.get('record')).position, null);
  }
  assert.throws(() => validatePosition({ ...position(), latitude: NaN }, now), { status: 400 });
});

test('only an optional bounded initiator is required; expiry is not client-selected', () => {
  assert.deepEqual(metadata({}), { initiator: '' });
  assert.deepEqual(metadata({ initiator: ' 小陈 ', hours: 999 }), { initiator: '小陈' });
  for (const body of [null, [], { initiator: 1 }, { initiator: 'a'.repeat(61) }, { initiator: 'a\nb' }]) {
    assert.throws(() => metadata(body), { status: 400 });
  }
});

test('existing requests remain readable after simplifying metadata', async () => {
  const storage = await fixture();
  const record = await storage.get('record');
  delete record.initiator; record.recipient = '旧发起人'; record.purpose = '旧用途';
  await storage.put('record', record);
  const info = await execute(storage, 'read', view, null, now);
  assert.equal(info.initiator, '旧发起人'); assert.equal(info.purpose, undefined);
});

test('authentication failures do not charge a record quota; delete works after read quota exhausted', async () => {
  const storage = await fixture();
  for (let i = 0; i < 35; i++) await assert.rejects(execute(storage, 'read', submit, null, now), { status: 401 });
  for (let i = 0; i < 30; i++) await execute(storage, 'read', view, null, now);
  await assert.rejects(execute(storage, 'read', view, null, now), { status: 429 });
  await execute(storage, 'delete', view, null, now);
  assert.equal(await storage.get('record'), undefined);
});

test('authenticated invalid submissions consume the record budget and cannot bypass it by failing validation', async () => {
  const storage = await fixture();
  for (let i = 0; i < 8; i++) await assert.rejects(execute(storage, 'submit', submit, { ...position(), latitude: 91 }, now), { status: 400 });
  await assert.rejects(execute(storage, 'submit', submit, position(), now), { status: 429 });
  assert.equal((await storage.get('record')).position, null);
  await execute(storage, 'delete', view, null, now);
  assert.equal(await storage.get('record'), undefined);
});

test('spoofing with bidirectional formatting controls is rejected in initiator names', () => {
  for (const control of ['\u202e', '\u2066', '\u0085']) assert.throws(() => metadata({ initiator: '某人' + control + 'abc' }), { status: 400 });
  assert.equal(metadata({ initiator: '陈 / محمد' }).initiator, '陈 / محمد');
});
