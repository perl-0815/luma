const assert = require('node:assert/strict');
const { test } = require('node:test');
const { overall, focusMessage, elapsed, validPayload, orderSessions, groupSessions, ageLabel } = require('../web/model.js');
test('urgent agent statuses override main status, and errors outrank waiting', () => {
  const session = { status: 'running', agents: [{ name: 'review', status: 'waiting', message: '選択が必要' }] };
  assert.equal(overall(session), 'waiting');
  assert.equal(focusMessage(session), 'review: 選択が必要');
  session.agents.push({ status: 'error' });
  assert.equal(overall(session), 'error');
});
test('completion never conceals outstanding work', () => {
  assert.equal(overall({ status: 'done', agents: [{ status: 'running' }] }), 'running');
  assert.equal(overall({ status: 'done', agents: [{ status: 'done' }] }), 'done');
  assert.equal(overall({ status: 'running', agents: [{ status: 'done' }] }), 'running');
  assert.equal(overall(null), 'idle');
});
test('invalid states fail visibly and elapsed times are deterministic', () => {
  assert.equal(overall({ status: 'unknown' }), 'error');
  assert.equal(elapsed('2026-10-16T00:00:00Z', '2026-10-16T01:02:03Z'), '01:02:03');
});
test('structurally broken snapshots are rejected before rendering', () => {
  assert.equal(validPayload({ schemaVersion: 1, sessions: [] }), true);
  assert.equal(validPayload({ schemaVersion: 1, sessions: [null] }), false);
  assert.equal(validPayload({ schemaVersion: 1, sessions: [{ id: 'broken', agents: {} }] }), false);
  assert.equal(validPayload({ schemaVersion: 2, sessions: [] }), false);
});
const session = (id, status, updatedAt, agents = []) => ({ id, status, updatedAt, agents });
test('hub puts errors and user input before newer running work, including agent alerts', () => {
  const sessions = [
    session('run', 'running', '2026-10-16T12:00:00Z'),
    session('wait', 'waiting', '2026-10-16T11:00:00Z'),
    session('agent-error', 'running', '2026-10-16T10:00:00Z', [{ status: 'error' }])
  ];
  assert.deepEqual(orderSessions(sessions).map(s => s.id), ['agent-error', 'wait', 'run']);
  assert.equal(sessions[0].id, 'run');
});
test('completed work moves to history while a result remains visible when everything is done', () => {
  const done = [session('old', 'done', '2026-10-16T10:00:00Z'), session('latest', 'done', '2026-10-16T12:00:00Z')];
  assert.deepEqual(groupSessions(done).visible.map(s => s.id), ['latest']);
  assert.deepEqual(groupSessions(done).history.map(s => s.id), ['old']);
  const mixed = groupSessions([...done, session('work', 'running', '2026-10-16T11:00:00Z')]);
  assert.deepEqual(mixed.visible.map(s => s.id), ['work']);
  assert.equal(mixed.history.length, 2);
  assert.deepEqual(groupSessions([]), { visible: [], history: [] });
});
test('freshness labels show days and never imply a future update', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(ageLabel('2026-10-16T11:59:20Z', now), '更新 40秒前');
  assert.equal(ageLabel('2026-10-14T12:00:00Z', now), '更新 2日前');
  assert.equal(ageLabel('2026-10-16T12:01:00Z', now), '更新 0秒前');
});
