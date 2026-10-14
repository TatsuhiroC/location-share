export const HOUR = 60 * 60 * 1000;
export const TOKEN_RE = /^[a-f0-9]{64}$/;
export const ID_RE = /^[a-f0-9]{32}$/;

export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function randomHex(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}

export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}

export function equal(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function metadata(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_REQUEST');
  const value = body.initiator ?? '';
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_REQUEST');
  const initiator = value.trim();
  if (initiator.length > 60 || /[\u0000-\u001f\u007f]/u.test(initiator)) throw new ApiError(400, 'INVALID_REQUEST');
  return { initiator };
}

export function validatePosition(body, now) {
  if (!body || body.consent !== true || !ID_RE.test(body.submissionId || '')) throw new ApiError(400, 'INVALID_LOCATION');
  const numeric = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  if (!numeric(body.latitude, -90, 90) || !numeric(body.longitude, -180, 180) || !numeric(body.accuracy, 0, 100000) || !numeric(body.timestamp, now - 5 * 60 * 1000, now + 60 * 1000)) {
    throw new ApiError(400, 'INVALID_LOCATION');
  }
  return {
    latitude: body.latitude, longitude: body.longitude, accuracy: body.accuracy,
    timestamp: body.timestamp, receivedAt: now, submissionId: body.submissionId
  };
}

// Runs against Durable Object storage. Transactions serialize competing submissions/deletion.
export async function execute(storage, action, token, body, now = Date.now()) {
  return storage.transaction(async tx => {
    const record = await tx.get('record');
    if (!record) return { error: { status: 404, code: 'NOT_FOUND' } };
    if (now >= record.expiresAt) {
      await tx.delete('record');
      return { error: { status: 410, code: 'EXPIRED' } };
    }
    if (!TOKEN_RE.test(token || '')) throw new ApiError(401, 'UNAUTHORIZED');
    const role = action === 'info' || action === 'submit' ? 'submitHash' : 'viewHash';
    if (!equal(await digest(token), record[role])) throw new ApiError(401, 'UNAUTHORIZED');
    // Only authenticated requests can consume this record's budget. Deletion stays available.
    if (action !== 'delete') {
      const minute = Math.floor(now / 60000);
      const rates = record.rates || {};
      const rate = rates[action]?.minute === minute ? rates[action] : { minute, count: 0 };
      if (rate.count >= (action === 'submit' ? 8 : 30)) throw new ApiError(429, 'RATE_LIMITED');
      rate.count++; rates[action] = rate; record.rates = rates;
    }
    const common = { initiator: record.initiator ?? record.recipient ?? '', createdAt: record.createdAt, expiresAt: record.expiresAt, status: record.position ? 'received' : 'waiting' };
    if (action === 'info') { await tx.put('record', record); return { value: common }; }
    if (action === 'read') {
      const position = record.position ? { ...record.position } : null;
      if (position) delete position.submissionId;
      await tx.put('record', record);
      return { value: { ...common, position } };
    }
    if (action === 'delete') { await tx.delete('record'); return { value: { deleted: true } }; }
    if (action !== 'submit') throw new ApiError(400, 'INVALID_REQUEST');
    const position = validatePosition(body, now);
    if (record.position) {
      const old = record.position;
      if (old.submissionId !== position.submissionId || ['latitude', 'longitude', 'accuracy', 'timestamp'].some(key => old[key] !== position[key])) throw new ApiError(409, 'ALREADY_RECEIVED');
      await tx.put('record', record);
      return { value: { received: true, receivedAt: old.receivedAt } };
    }
    record.position = position;
    await tx.put('record', record);
    return { value: { received: true, receivedAt: position.receivedAt } };
  }).then(result => {
    if (result.error) throw new ApiError(result.error.status, result.error.code);
    return result.value;
  });
}
