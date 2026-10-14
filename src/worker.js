import { DurableObject } from 'cloudflare:workers';
import { ApiError, execute, HOUR } from './session.js';
export { default } from './api.js';

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
  async legacy() {
    const now = Date.now();
    return this.ctx.storage.transaction(async tx => {
      const minute = Math.floor(now / 60000), day = Math.floor(now / (24 * HOUR));
      const state = await tx.get('legacy') || { day, total: 0, minute, count: 0 };
      if (state.day !== day) { state.day = day; state.total = 0; }
      if (state.minute !== minute) { state.minute = minute; state.count = 0; }
      if (state.count >= 60 || state.total >= 5000) return false;
      state.count++; state.total++;
      await tx.put('legacy', state);
      await this.ctx.storage.setAlarm((day + 1) * 24 * HOUR);
      return true;
    });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}
