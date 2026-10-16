/* Shared display logic; independent of the native host and DOM. */
(function (root) {
  'use strict';
  const STATES = {
    idle: { label: '待機中' },
    running: { label: '作業中' },
    waiting: { label: '操作待ち' },
    error: { label: '問題あり' },
    done: { label: '完了' }
  };
  const valid = status => Object.prototype.hasOwnProperty.call(STATES, status) ? status : 'error';
  function validPayload(payload) {
    const string = value => typeof value === 'string';
    const timestamp = value => string(value) && Number.isFinite(Date.parse(value));
    return payload && payload.schemaVersion === 1 && Array.isArray(payload.sessions) &&
      payload.sessions.every(s => s && string(s.id) && string(s.title) && string(s.project) &&
        string(s.message) && timestamp(s.startedAt) && timestamp(s.updatedAt) &&
        Object.prototype.hasOwnProperty.call(STATES, s.status) &&
        Array.isArray(s.agents) && Array.isArray(s.events) &&
        s.agents.every(a => a && string(a.id) && string(a.name) && string(a.task) && string(a.message) &&
          Object.prototype.hasOwnProperty.call(STATES, a.status)) &&
        s.events.every(e => e && timestamp(e.at) && string(e.message) &&
          Object.prototype.hasOwnProperty.call(STATES, e.status)));
  }
  function overall(session) {
    if (!session) return 'idle';
    const statuses = [session.status, ...(session.agents || []).map(a => a.status)].map(valid);
    for (const status of ['error', 'waiting', 'running']) {
      if (statuses.includes(status)) return status;
    }
    return valid(session.status);
  }
  function focusMessage(session) {
    if (!session) return 'スキルの起動を待っています';
    const status = overall(session);
    if (status !== session.status) {
      const agent = (session.agents || []).find(a => a.status === status);
      if (agent) return `${agent.name}: ${agent.message || agent.task || STATES[status].label}`;
    }
    return session.message || STATES[status].label;
  }
  function elapsed(start, end) {
    const seconds = Math.max(0, Math.floor((new Date(end) - new Date(start)) / 1000)) || 0;
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(n => String(n).padStart(2, '0')).join(':');
  }
  function orderSessions(sessions) {
    const priority = { error: 0, waiting: 1, running: 2, idle: 3, done: 4 };
    return [...sessions].sort((a, b) => priority[overall(a)] - priority[overall(b)] ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  function groupSessions(sessions) {
    const ordered = orderSessions(sessions);
    const active = ordered.filter(s => overall(s) !== 'done');
    const completed = ordered.filter(s => overall(s) === 'done');
    // Keep the most recent result visible when all work has finished.
    return active.length ? { visible: active, history: completed } :
      { visible: completed.slice(0, 1), history: completed.slice(1) };
  }
  function ageLabel(at, now = Date.now()) {
    const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
    if (seconds < 60) return `更新 ${seconds}秒前`;
    if (seconds < 3600) return `更新 ${Math.floor(seconds / 60)}分前`;
    if (seconds < 86400) return `更新 ${Math.floor(seconds / 3600)}時間前`;
    return `更新 ${Math.floor(seconds / 86400)}日前`;
  }
  const model = { STATES, valid, validPayload, overall, focusMessage, elapsed, orderSessions, groupSessions, ageLabel };
  root.LumaModel = model;
  if (typeof module !== 'undefined') module.exports = model;
})(globalThis);
