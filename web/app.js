(() => {
  'use strict';
  const { STATES, valid, validPayload, overall, focusMessage, elapsed, groupSessions, ageLabel } = window.LumaModel;
  const $ = id => document.getElementById(id);
  let state = { sessions: [] };
  let selected = null;
  let readError = false;
  let cardParts = [];
  let previousHistorySelection = null;
  const current = () => state.sessions.find(s => s.id === selected);
  const text = (id, value) => { $(id).textContent = value; };
  const element = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const shortProject = project => project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || project;
  const dot = () => { const node = element('span', 'state-dot'); node.setAttribute('aria-hidden', 'true'); return node; };

  function card(session) {
    const status = overall(session);
    const button = element('button', 'session');
    button.type = 'button';
    button.dataset.session = session.id;
    button.dataset.state = status;
    button.setAttribute('aria-pressed', String(session.id === selected));
    const top = element('span', 'session-top');
    const label = element('span', 'session-state');
    label.append(dot(), document.createTextNode(STATES[status].label));
    const age = element('span', 'session-age', ageLabel(session.updatedAt));
    top.append(label, age);
    const title = element('span', 'session-title', session.title);
    const message = element('span', 'session-message', focusMessage(session));
    message.title = focusMessage(session);
    const meta = element('span', 'session-meta');
    const project = element('span', 'session-project', shortProject(session.project));
    project.title = session.project;
    const duration = element('span', 'session-duration');
    meta.append(project, duration);
    button.append(top, title, message, meta);
    button.addEventListener('click', () => {
      button.focus({ preventScroll: true });
      selected = session.id;
      render();
    });
    cardParts.push({ session, age, duration });
    return button;
  }

  function render() {
    const focusedSession = document.activeElement?.dataset?.session;
    const agentsScroll = $('agents').scrollTop;
    const eventsScroll = $('events').scrollTop;
    const groups = groupSessions(state.sessions);
    document.body.classList.toggle('multiple-sessions', groups.visible.length > 1);
    document.body.dataset.status = readError ? 'error' : overall(groups.visible[0]);
    cardParts = [];
    $('sessions').replaceChildren(...groups.visible.map(card));
    $('history-sessions').replaceChildren(...groups.history.map(card));
    $('empty').hidden = state.sessions.length > 0;
    $('history').hidden = !groups.history.length;
    const historySelection = groups.history.some(s => s.id === selected) ? selected : null;
    if (historySelection && historySelection !== previousHistorySelection) $('history').open = true;
    previousHistorySelection = historySelection;
    text('history-label', '完了した作業（' + groups.history.length + '）');
    const attention = groups.visible.filter(s => ['error', 'waiting'].includes(overall(s))).length;
    text('work-summary', attention ? '要対応 ' + attention + '件' : groups.visible.length > 1 ? groups.visible.length + '件' : '');

    const session = current();
    const agents = [...(session?.agents || [])].sort((a, b) => {
      const rank = { error: 0, waiting: 1, running: 2, idle: 3, done: 4 };
      return rank[valid(a.status)] - rank[valid(b.status)];
    });
    $('agents-section').hidden = !agents.length;
    $('agents').replaceChildren();
    text('agent-summary', groups.visible.length > 1 || historySelection ? session?.title || '' : '');
    for (const agent of agents) {
      const row = element('article', 'agent'); row.dataset.state = valid(agent.status);
      const body = element('div', 'agent-body');
      body.append(element('h3', '', agent.name));
      const report = agent.message || agent.task;
      if (report) body.append(element('p', '', report));
      if (agent.task && agent.message && agent.task !== agent.message) {
        const task = element('p', 'agent-task', agent.task);
        task.title = '担当している作業';
        body.append(task);
      }
      row.append(dot(), body, element('span', 'agent-status', STATES[valid(agent.status)].label));
      $('agents').append(row);
    }
    const events = [...(session?.events || [])].reverse().slice(0, 30);
    $('activity').hidden = !events.length;
    $('events').replaceChildren();
    for (const event of events) {
      const li = element('li'); li.dataset.state = valid(event.status);
      const at = element('time', '', new Date(event.at).toLocaleTimeString('ja-JP', { hour12: false }));
      at.dateTime = event.at;
      const message = element('span', 'event-message');
      const agent = agents.find(a => a.id === event.agentId);
      message.append(element('span', 'event-state', STATES[valid(event.status)].label));
      message.append(document.createTextNode((agent ? agent.name + ' · ' : '') + event.message));
      li.append(at, message); $('events').append(li);
    }
    $('agents').scrollTop = agentsScroll;
    $('events').scrollTop = eventsScroll;
    if (focusedSession) {
      for (const button of document.querySelectorAll('.session')) {
        if (button.dataset.session === focusedSession) button.focus({ preventScroll: true });
      }
    }
    const announcement = readError ? '状態ファイルを読み込めません' :
      groups.visible.map(s => s.title + '、' + STATES[overall(s)].label).join('。');
    if ($('announcement').textContent !== announcement) text('announcement', announcement);
    updateClock();
  }

  function updateClock() {
    for (const { session, age, duration } of cardParts) {
      age.textContent = ageLabel(session.updatedAt);
      duration.textContent = (overall(session) === 'done' ? '所要 ' : '経過 ') +
        elapsed(session.startedAt, overall(session) === 'done' ? session.updatedAt : new Date());
    }
  }

  window.luma = {
    receive(payload) {
      if (!validPayload(payload)) { this.connectionError('状態ファイルの形式を確認してください'); return; }
      const previousIDs = new Set(state.sessions.map(s => s.id));
      const previous = current();
      state = payload;
      const newest = state.sessions[state.sessions.length - 1];
      if (!state.sessions.some(s => s.id === selected)) selected = groupSessions(state.sessions).visible[0]?.id || null;
      else if (newest && !previousIDs.has(newest.id) && (!previous || overall(previous) === 'done')) selected = newest.id;
      readError = false;
      $('connection-error').hidden = true;
      render();
    },
    connectionError(message) {
      readError = true;
      text('connection-error', message); $('connection-error').hidden = false; render();
    },
    preferences(prefs) {
      $('pin').setAttribute('aria-pressed', String(prefs.pinned));
      $('pin').title = prefs.pinned ? '最前面への固定を解除' : '最前面に固定';
      $('pin').setAttribute('aria-label', $('pin').title);
      $('compact').setAttribute('aria-pressed', String(prefs.compact));
      text('compact-label', prefs.compact ? '拡大' : '縮小');
      $('compact').title = prefs.compact ? '通常の大きさに戻す' : '小さく表示';
      $('compact').setAttribute('aria-label', $('compact').title);
      document.body.classList.toggle('compact', prefs.compact);
    }
  };
  for (const action of ['pin', 'compact']) {
    $(action).addEventListener('click', () => window.webkit?.messageHandlers?.luma?.postMessage(action));
  }
  setInterval(updateClock, 1000);
  render();
})();
