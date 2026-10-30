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
test('completed work only appears in history, including when everything is done', () => {
  const done = [session('old', 'done', '2026-10-16T10:00:00Z'), session('latest', 'done', '2026-10-16T12:00:00Z')];
  assert.deepEqual(groupSessions(done).visible, []);
  assert.deepEqual(groupSessions(done).history.map(s => s.id), ['latest', 'old']);
  const mixed = groupSessions([...done, session('work', 'running', '2026-10-16T11:00:00Z')]);
  assert.deepEqual(mixed.visible.map(s => s.id), ['work']);
  assert.equal(mixed.history.length, 2);
  assert.deepEqual(groupSessions([]), { visible: [], history: [] });
});
test('history never hides unfinished or blocked work even when the main status is done', () => {
  const sessions = [session('done', 'done', '2026-10-16T12:00:00Z'),
    session('agent', 'done', '2026-10-16T11:00:00Z', [{ status: 'waiting' }]),
    { ...session('task', 'done', '2026-10-16T10:00:00Z'), tasks: [{ status: 'error' }] },
    { ...session('pending', 'done', '2026-10-16T09:00:00Z'), tasks: [{ status: 'pending' }] },
    session('idle', 'idle', '2026-10-16T08:00:00Z')];
  assert.deepEqual(groupSessions(sessions).visible.map(s => s.id), ['task', 'agent', 'pending', 'idle']);
  assert.deepEqual(groupSessions(sessions).history.map(s => s.id), ['done']);
});
test('freshness labels show days and never imply a future update', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(ageLabel('2026-10-16T11:59:20Z', now), '更新 40秒前');
  assert.equal(ageLabel('2026-10-14T12:00:00Z', now), '更新 2日前');
  assert.equal(ageLabel('2026-10-16T12:01:00Z', now), '更新 0秒前');
});

const { globalStatus, taskRows, TASK_STATES } = require('../web/model.js');
const at = '2026-10-29T12:00:00Z';
const task = (id, status = 'pending', extra = {}) => ({ id, title: id, status, parentId: null, dependsOn: [], agentId: null, message: '', updatedAt: at, ...extra });
const snapshot = (tasks) => ({ schemaVersion: 1, sessions: [{
  id: 'build', title: 'Build', project: '/local/project', status: 'running', message: 'Working',
  startedAt: at, updatedAt: at, agents: [], events: [], ...(tasks === undefined ? {} : { tasks })
}] });
test('legacy sessions and task plans share the existing snapshot contract', () => {
  assert.equal(validPayload(snapshot()), true);
  assert.equal(validPayload(snapshot([])), true);
  assert.equal(validPayload(snapshot([task('inspect', 'done'), task('build', 'running', { dependsOn: ['inspect'] })])), true);
  assert.equal(TASK_STATES.pending.label, '未着手');
  assert.notEqual(TASK_STATES.pending.label, TASK_STATES.waiting.label);
});
test('task references, cycles, unknown states and malformed fields fail before display', () => {
  const cases = [
    [task('a'), task('a')],
    [task('a', 'unknown')],
    [task('a', 'pending', { parentId: 'missing' })],
    [task('a', 'pending', { parentId: 'a' })],
    [task('a', 'pending', { parentId: 'b' }), task('b', 'pending', { parentId: 'a' })],
    [task('a', 'pending', { dependsOn: ['b'] }), task('b', 'pending', { dependsOn: ['a'] })],
    [task('a', 'pending', { dependsOn: ['missing'] })],
    [task('a', 'pending', { dependsOn: ['b', 'b'] }), task('b')],
    [task('a', 'pending', { agentId: 'missing' })],
    [task('a', 'pending', { updatedAt: 'invalid' })],
    [task('a', 'pending', { message: null })],
    Array.from({ length: 201 }, (_, index) => task(`task-${index}`))
  ];
  for (const tasks of cases) assert.equal(validPayload(snapshot(tasks)), false);
  const agents = snapshot([task('a', 'running', { agentId: 'ui' })]);
  agents.sessions[0].agents = [{ id: 'ui', name: 'UI', task: 'Build', status: 'running', message: 'Drawing' }];
  assert.equal(validPayload(agents), true);
  assert.equal(validPayload({ schemaVersion: 1, sessions: [null, null] }), false);
  assert.equal(validPayload(null), false);
});
test('global traffic light includes every session and task even if a healthy tab is selected', () => {
  const healthy = { status: 'running', agents: [], tasks: [task('a', 'running')] };
  const other = { status: 'running', agents: [], tasks: [task('b', 'waiting')] };
  assert.equal(globalStatus([healthy, other]).color, 'yellow');
  assert.equal(globalStatus([healthy, other]).counts.waiting, 1);
  other.tasks[0].status = 'error';
  assert.equal(globalStatus([healthy, other]).color, 'red');
  assert.equal(globalStatus([healthy, other]).counts.error, 1);
  assert.equal(globalStatus([healthy]).color, 'green');
  assert.equal(globalStatus([healthy]).label, '作業中');
  assert.equal(globalStatus([{ status: 'done', tasks: [task('a', 'done')] }]).label, 'すべて完了');
  assert.equal(globalStatus([]).label, '待機中');
  assert.equal(globalStatus([], true).color, 'red');
});
test('pending tasks prevent a finished session from concealing unfinished work', () => {
  const plan = { status: 'done', agents: [], tasks: [task('a', 'pending')] };
  assert.equal(overall(plan), 'running');
  assert.equal(focusMessage(plan), 'a: 未着手');
  plan.tasks[0].status = 'skipped';
  assert.equal(overall(plan), 'done');
});
test('task hierarchy keeps sibling order when their progress changes', () => {
  const tasks = [task('root'), task('branch-b', 'pending', { parentId: 'root' }), task('branch-a', 'done', { parentId: 'root' }), task('next')];
  assert.deepEqual(taskRows(tasks).map(row => [row.task.id, row.depth]), [['root', 0], ['branch-b', 1], ['branch-a', 1], ['next', 0]]);
  tasks[1].status = 'error'; tasks[2].status = 'running';
  assert.deepEqual(taskRows(tasks).map(row => row.task.id), ['root', 'branch-b', 'branch-a', 'next']);
});
