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
  return new MemoryStorage({ recipient: '小陈', purpose: '公园碰面', createdAt: now, expiresAt: now + HOUR, submitHash: await digest(submit), viewHash: await digest(view), position: null });
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

test('metadata requires bounded names, a purpose, and an allowed expiry', () => {
  assert.deepEqual(metadata({ recipient: ' 小陈 ', purpose: ' 碰面 ', hours: 24 }), { recipient: '小陈', purpose: '碰面', hours: 24 });
  for (const change of [{ recipient: '' }, { recipient: 'a'.repeat(61) }, { purpose: 'a\nb' }, { hours: 25 }]) {
    assert.throws(() => metadata({ recipient: '小陈', purpose: '碰面', hours: 24, ...change }), { status: 400 });
  }
});
