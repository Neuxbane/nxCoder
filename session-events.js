import { randomUUID } from 'node:crypto';

// Bounded, in-memory replay. A missing cursor requires a history reload, never a rerun.
export class SessionEvents {
  constructor({ maxEvents = 1024, maxBytes = 1024 * 1024, maxSessions = 64 } = {}) {
    Object.assign(this, { maxEvents, maxBytes, maxSessions });
    this.sessions = new Map();
  }
  get(id) {
    let entry = this.sessions.get(id);
    if (!entry) entry = { epoch: randomUUID(), seq: 0, events: [], bytes: 0 };
    this.sessions.delete(id);
    this.sessions.set(id, entry);
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    return entry;
  }
  cursor(id) {
    const { epoch, seq } = this.get(id);
    return { epoch, seq };
  }
  append(id, message) {
    const entry = this.get(id);
    const event = { ...message, streamCursor: { epoch: entry.epoch, seq: ++entry.seq } };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    entry.events.push({ event, bytes });
    entry.bytes += bytes;
    while (entry.events.length > this.maxEvents || entry.bytes > this.maxBytes) {
      entry.bytes -= entry.events.shift().bytes;
    }
    return event;
  }
  replay(id, cursor) {
    const entry = this.get(id);
    if (!cursor || cursor.epoch !== entry.epoch || !Number.isInteger(cursor.seq) || cursor.seq < 0 || cursor.seq > entry.seq) return null;
    const oldest = entry.events[0]?.event.streamCursor.seq ?? entry.seq + 1;
    if (cursor.seq < oldest - 1) return null;
    return entry.events.filter(({ event }) => event.streamCursor.seq > cursor.seq).map(({ event }) => event);
  }
}
