import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEvents } from '../session-events.js';

test('replays missed events in order without including the acknowledged event', () => {
  const log = new SessionEvents();
  const cursor = log.append('s', { type: 'FUNCTION_CALL' }).streamCursor;
  log.append('s', { type: 'FUNCTION_RESPONSE' });
  log.append('s', { type: 'DONE' });
  assert.deepEqual(log.replay('s', cursor).map(e => e.type), ['FUNCTION_RESPONSE', 'DONE']);
  assert.deepEqual(log.replay('s', log.cursor('s')), []);
});
test('rejects expired, restarted, future and invalid cursors', () => {
  const log = new SessionEvents({ maxEvents: 1 });
  const cursor = log.cursor('s');
  log.append('s', { type: 'TOKEN_STREAM' });
  log.append('s', { type: 'DONE' });
  assert.equal(log.replay('s', cursor), null);
  assert.equal(new SessionEvents().replay('s', cursor), null);
  assert.equal(log.replay('s', { ...cursor, seq: 999 }), null);
  assert.equal(log.replay('s', { ...cursor, seq: -1 }), null);
});
test('bounds storage and isolates parent and sub-session replay', () => {
  const log = new SessionEvents({ maxBytes: 200, maxSessions: 2 });
  const cursor = log.cursor('parent');
  log.append('parent', { text: 'x'.repeat(1000) });
  assert.equal(log.replay('parent', cursor), null);
  const current = log.cursor('parent');
  log.append('child', { type: 'DONE' });
  assert.deepEqual(log.replay('parent', current), []);
  log.cursor('another');
  assert.equal(log.replay('child', current), null);
  assert.ok(log.sessions.size <= 2);
});
