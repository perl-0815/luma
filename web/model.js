/* Shared display logic; independent of the native host and DOM. */
(function (root) {
  'use strict';
  const STATES = {
    idle: { label: '待機中' }, running: { label: '作業中' },
    waiting: { label: '操作待ち' }, error: { label: '問題あり' }, done: { label: '完了' }
  };
  const TASK_STATES = {
    pending: { label: '未着手' }, running: STATES.running, waiting: STATES.waiting,
    error: STATES.error, done: STATES.done, skipped: { label: '取りやめ' }
  };
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const valid = status => has(STATES, status) ? status : 'error';
  const taskStatus = status => has(TASK_STATES, status) ? status : 'error';
  function validPayload(payload) {
    const string = value => typeof value === 'string';
    const timestamp = value => string(value) && Number.isFinite(Date.parse(value));
    const unique = values => new Set(values).size === values.length;
    function acyclic(tasks, links) {
      const byID = new Map(tasks.map(task => [task.id, task]));
      const visiting = new Set(), visited = new Set();
      function visit(id) {
        if (visiting.has(id)) return false;
        if (visited.has(id)) return true;
        visiting.add(id);
        for (const next of links(byID.get(id))) if (!visit(next)) return false;
        visiting.delete(id); visited.add(id); return true;
      }
      return tasks.every(task => visit(task.id));
    }
    function validTasks(session) {
      if (!has(session, 'tasks')) return true;
      const tasks = session.tasks;
      if (!Array.isArray(tasks) || tasks.length > 200 || !tasks.every(task => task && string(task.id) && task.id &&
        string(task.title) && task.title.trim() && has(TASK_STATES, task.status) &&
        (task.parentId === null || string(task.parentId)) && Array.isArray(task.dependsOn) &&
        task.dependsOn.every(string) && unique(task.dependsOn) &&
        (task.agentId === null || string(task.agentId)) && string(task.message) && timestamp(task.updatedAt))) return false;
      const ids = new Set(tasks.map(task => task.id));
      const agents = new Set(session.agents.map(agent => agent.id));
      return ids.size === tasks.length && tasks.every(task =>
        (task.parentId === null || ids.has(task.parentId)) && task.dependsOn.every(id => ids.has(id)) &&
        (task.agentId === null || agents.has(task.agentId))) &&
        acyclic(tasks, task => task.parentId === null ? [] : [task.parentId]) && acyclic(tasks, task => task.dependsOn);
    }
    return !!(payload && payload.schemaVersion === 1 && Array.isArray(payload.sessions) &&
      unique(payload.sessions.map(session => session?.id)) &&
      payload.sessions.every(s => s && string(s.id) && string(s.title) && string(s.project) &&
        string(s.message) && timestamp(s.startedAt) && timestamp(s.updatedAt) && has(STATES, s.status) &&
        Array.isArray(s.agents) && Array.isArray(s.events) && unique(s.agents.map(agent => agent?.id)) &&
        s.agents.every(a => a && string(a.id) && string(a.name) && string(a.task) && string(a.message) && has(STATES, a.status)) &&
        s.events.every(e => e && timestamp(e.at) && string(e.message) && has(STATES, e.status)) && validTasks(s)));
  }
  function overall(session) {
    if (!session) return 'idle';
    const statuses = [session.status, ...(session.agents || []).map(a => a.status)].map(valid);
    const tasks = session.tasks || [];
    for (const task of tasks) {
      const status = taskStatus(task.status);
      if (['running', 'waiting', 'error'].includes(status)) statuses.push(status);
    }
    for (const status of ['error', 'waiting', 'running']) if (statuses.includes(status)) return status;
    if (session.status === 'done' && tasks.some(task => !['done', 'skipped'].includes(task.status))) return 'running';
    return valid(session.status);
  }
  function globalStatus(sessions, readError = false) {
    const counts = { error: 0, waiting: 0, running: 0, done: 0, idle: 0 };
    for (const session of sessions) counts[overall(session)]++;
    if (readError) return { color: 'red', label: '読み取りエラー', detail: '最後の表示を保持', counts };
    if (counts.error) return { color: 'red', label: '問題あり', detail: `${counts.error}件の作業を確認`, counts };
    if (counts.waiting) return { color: 'yellow', label: '操作待ち', detail: `${counts.waiting}件の作業で対応が必要`, counts };
    if (counts.running) return { color: 'green', label: '作業中', detail: `${counts.running}件が進行中`, counts };
    if (sessions.length && counts.done === sessions.length) return { color: 'green', label: 'すべて完了', detail: `${counts.done}件の作業が完了`, counts };
    return { color: 'green', label: '待機中', detail: sessions.length ? '実行中の作業なし' : '作業の開始を待っています', counts };
  }
  function focusMessage(session) {
    if (!session) return '作業の開始を待っています';
    const status = overall(session);
    if (status !== session.status) {
      const agent = (session.agents || []).find(a => a.status === status);
      if (agent) return `${agent.name}: ${agent.message || agent.task || STATES[status].label}`;
      const task = (session.tasks || []).find(t => t.status === status || (status === 'running' && t.status === 'pending'));
      if (task) return `${task.title}: ${task.message || TASK_STATES[task.status].label}`;
    }
    return session.message || STATES[status].label;
  }
  function taskRows(tasks, parentId = null, depth = 0) {
    return tasks.filter(task => task.parentId === parentId).flatMap(task => [{ task, depth }, ...taskRows(tasks, task.id, depth + 1)]);
  }
  function elapsed(start, end) {
    const seconds = Math.max(0, Math.floor((new Date(end) - new Date(start)) / 1000)) || 0;
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  }
  function orderSessions(sessions) {
    const priority = { error: 0, waiting: 1, running: 2, idle: 3, done: 4 };
    return [...sessions].sort((a, b) => priority[overall(a)] - priority[overall(b)] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  function groupSessions(sessions) {
    const ordered = orderSessions(sessions);
    const active = ordered.filter(s => overall(s) !== 'done'), completed = ordered.filter(s => overall(s) === 'done');
    return { visible: active, history: completed };
  }
  function ageLabel(at, now = Date.now()) {
    const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
    if (seconds < 60) return `更新 ${seconds}秒前`;
    if (seconds < 3600) return `更新 ${Math.floor(seconds / 60)}分前`;
    if (seconds < 86400) return `更新 ${Math.floor(seconds / 3600)}時間前`;
    return `更新 ${Math.floor(seconds / 86400)}日前`;
  }
  const model = { STATES, TASK_STATES, valid, taskStatus, validPayload, overall, globalStatus, focusMessage, taskRows, elapsed, orderSessions, groupSessions, ageLabel };
  root.LumaModel = model;
  if (typeof module !== 'undefined') module.exports = model;
})(globalThis);
