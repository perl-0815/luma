(() => {
  'use strict';
  const { STATES, TASK_STATES, valid, taskStatus, validPayload, overall, globalStatus, focusMessage, elapsed, orderSessions, ageLabel } = window.LumaModel;
  const $ = id => document.getElementById(id);
  let state = { sessions: [] }, selected = null, readError = false;
  const selectedTasks = new Map();
  const current = () => state.sessions.find(session => session.id === selected);
  const text = (id, value) => { $(id).textContent = value; };
  const element = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const shortProject = project => project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || project;
  const dot = () => { const node = element('span', 'state-dot'); node.setAttribute('aria-hidden', 'true'); return node; };
  const taskFor = session => (session?.tasks || []).find(task => task.id === selectedTasks.get(session.id));
  const focusKey = node => node?.dataset?.focusKey;
  function selectedTab() {
    return [...$('sessions').children].find(node => node.dataset.session === selected);
  }

  function selectSession(id, focus = false) {
    selected = id;
    $('detail').scrollTop = 0;
    $('workspace').scrollTop = 0;
    render();
    if (focus) {
      const tab = selectedTab();
      tab?.focus({ preventScroll: true });
      tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  function selectTask(id) {
    selectedTasks.set(selected, id);
    $('detail').scrollTop = 0;
    if (window.matchMedia('(max-width: 620px)').matches) {
      $('workspace').classList.remove('explorer-open');
      $('explorer-toggle').setAttribute('aria-expanded', 'false');
      $('explorer-toggle').focus({ preventScroll: true });
      $('workspace').scrollTop = 0;
    }
    render();
  }
  function tab(session) {
    const status = overall(session), button = element('button', 'session-tab');
    button.type = 'button'; button.id = `session-${session.id}`;
    button.dataset.session = session.id; button.dataset.focusKey = `session:${session.id}`;
    button.dataset.state = status; button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(session.id === selected));
    button.setAttribute('aria-controls', 'workspace'); button.tabIndex = session.id === selected ? 0 : -1;
    button.setAttribute('aria-label', `${session.title}、${STATES[status].label}`);
    button.title = `${session.title} — ${STATES[status].label}`;
    button.append(dot(), element('span', 'tab-title', session.title));
    if (['error', 'waiting'].includes(status)) button.append(element('span', 'tab-status', STATES[status].label));
    button.addEventListener('click', () => selectSession(session.id, true));
    button.addEventListener('keydown', event => {
      const index = state.sessions.findIndex(item => item.id === session.id), count = state.sessions.length;
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % count;
      if (event.key === 'ArrowLeft') next = (index + count - 1) % count;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = count - 1;
      if (next !== undefined) { event.preventDefault(); selectSession(state.sessions[next].id, true); }
    });
    return button;
  }
  function appendTasks(parent, tasks, parentId, agents) {
    for (const task of tasks.filter(item => item.parentId === parentId)) {
      const li = element('li'); li.dataset.state = taskStatus(task.status);
      const button = element('button', 'task-button'); button.type = 'button';
      button.dataset.focusKey = `task:${task.id}`; button.dataset.state = taskStatus(task.status);
      button.setAttribute('aria-pressed', String(selectedTasks.get(selected) === task.id));
      const node = element('span', 'branch-node'); node.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'task-copy');
      copy.append(element('span', 'task-name', task.title), element('span', 'task-status', TASK_STATES[task.status].label));
      const agent = agents.find(item => item.id === task.agentId);
      if (agent) copy.append(element('span', 'task-assignee', agent.name));
      button.append(node, copy); button.addEventListener('click', () => selectTask(task.id)); li.append(button);
      if (tasks.some(item => item.parentId === task.id)) {
        const children = element('ul'); appendTasks(children, tasks, task.id, agents); li.append(children);
      }
      parent.append(li);
    }
  }
  function renderRelations(task, session) {
    $('task-relations').replaceChildren(); $('task-relations').hidden = !task;
    if (!task) return;
    const add = (label, ids) => {
      if (!ids.length) return;
      const row = element('div', 'relation-row'); row.append(element('span', '', label));
      for (const id of ids) {
        const related = session.tasks.find(item => item.id === id);
        const link = element('button', 'relation-link', related.title); link.type = 'button';
        link.dataset.focusKey = `relation:${id}`; link.addEventListener('click', () => selectTask(id)); row.append(link);
      }
      $('task-relations').append(row);
    };
    add('親タスク', task.parentId === null ? [] : [task.parentId]); add('前提タスク', task.dependsOn);
  }
  function render() {
    const focused = focusKey(document.activeElement);
    const scroll = ['sessions', 'explorer', 'detail', 'task-tree-container', 'workspace'].map(id => [id, $(id).scrollTop, $(id).scrollLeft]);
    const global = globalStatus(state.sessions, readError);
    $('global-indicator').dataset.color = global.color;
    text('global-label', global.label); text('global-detail', global.detail);
    $('sessions').replaceChildren(...state.sessions.map(tab));
    const session = current(), tasks = session?.tasks || [], task = taskFor(session), agents = session?.agents || [];
    $('workspace').setAttribute('aria-labelledby', session ? `session-${session.id}` : 'global-label');
    $('empty').hidden = !!session; $('session-content').hidden = !session; $('explorer').hidden = !session;
    const completed = tasks.filter(item => ['done', 'skipped'].includes(item.status)).length;
    const count = tasks.length ? `${completed} / ${tasks.length}` : '0件';
    text('task-count', count); text('compact-task-count', count);
    $('overview').setAttribute('aria-pressed', String(!task)); $('overview').dataset.state = overall(session);
    $('task-tree').replaceChildren(); appendTasks($('task-tree'), tasks, null, agents); $('no-tasks').hidden = tasks.length > 0;
    if (session) {
      text('project', shortProject(session.project)); $('project').title = session.project;
      text('session-name', session.title); $('session-name').hidden = !task; text('detail-title', task ? task.title : session.title);
      const status = task ? task.status : overall(session);
      $('detail-state').dataset.state = status;
      $('detail-state').replaceChildren(dot(), document.createTextNode((task ? TASK_STATES : STATES)[status].label));
      text('report', task ? task.message || (task.status === 'pending' ? 'これから取り組むタスクです' : TASK_STATES[task.status].label) : focusMessage(session));
      text('progress', tasks.length ? `タスク ${completed} / ${tasks.length} 終了` : ''); renderRelations(task, session);
      const shownAgents = task ? agents.filter(agent => agent.id === task.agentId) : agents;
      $('agents-section').hidden = !shownAgents.length; $('agents').replaceChildren();
      text('agent-summary', shownAgents.length > 1 ? `${shownAgents.length}名` : '');
      for (const agent of shownAgents) {
        const row = element('article', 'agent'); row.dataset.state = valid(agent.status);
        const body = element('div', 'agent-body'); body.append(element('h4', '', agent.name));
        const report = agent.message || agent.task; if (report) body.append(element('p', '', report));
        row.append(dot(), body, element('span', 'agent-status', STATES[valid(agent.status)].label)); $('agents').append(row);
      }
      const events = [...session.events].reverse().slice(0, 30);
      $('activity').hidden = !events.length || !!task; $('events').replaceChildren();
      for (const event of events) {
        const li = element('li'); li.dataset.state = valid(event.status);
        const at = element('time', '', new Date(event.at).toLocaleTimeString('ja-JP', { hour12: false })); at.dateTime = event.at;
        const message = element('span', 'event-message'), agent = agents.find(item => item.id === event.agentId);
        message.append(element('span', 'event-state', STATES[valid(event.status)].label));
        message.append(document.createTextNode((agent ? `${agent.name} · ` : '') + event.message)); li.append(at, message); $('events').append(li);
      }
    }
    for (const [id, top, left] of scroll) { $(id).scrollTop = top; $(id).scrollLeft = left; }
    if (focused) [...document.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === focused)?.focus({ preventScroll: true });
    const announcement = session ? `${session.title}、${STATES[overall(session)].label}${task ? `。${task.title}、${TASK_STATES[task.status].label}` : ''}` : '';
    if ($('announcement').textContent !== announcement) text('announcement', announcement); updateClock();
  }
  function updateClock() {
    const session = current(); if (!session) return;
    const task = taskFor(session); text('updated', ageLabel(task?.updatedAt || session.updatedAt));
    text('duration', (overall(session) === 'done' ? '所要 ' : '経過 ') + elapsed(session.startedAt, overall(session) === 'done' ? session.updatedAt : new Date()));
  }
  $('overview').addEventListener('click', () => selectTask(null));
  $('explorer-toggle').addEventListener('click', () => {
    const open = !$('workspace').classList.contains('explorer-open');
    $('workspace').classList.toggle('explorer-open', open); $('explorer-toggle').setAttribute('aria-expanded', String(open));
  });
  window.luma = {
    receive(payload) {
      if (!validPayload(payload)) { this.connectionError('状態ファイルの形式を確認してください'); return; }
      const previousSelection = selected, previous = current(), previousIDs = new Set(state.sessions.map(session => session.id));
      state = payload;
      if (!state.sessions.some(session => session.id === selected)) selected = orderSessions(state.sessions)[0]?.id || null;
      else {
        const newest = state.sessions[state.sessions.length - 1];
        if (newest && !previousIDs.has(newest.id) && (!previous || overall(previous) === 'done')) selected = newest.id;
      }
      for (const [id, taskID] of selectedTasks) if (!state.sessions.find(session => session.id === id)?.tasks?.some(task => task.id === taskID)) selectedTasks.delete(id);
      readError = false; $('connection-error').hidden = true; render();
      if (selected !== previousSelection) selectedTab()?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    connectionError(message) { readError = true; text('connection-error', message); $('connection-error').hidden = false; render(); },
    preferences(prefs) {
      $('pin').setAttribute('aria-pressed', String(prefs.pinned)); $('pin').title = prefs.pinned ? '最前面への固定を解除' : '最前面に固定'; $('pin').setAttribute('aria-label', $('pin').title);
      $('compact').setAttribute('aria-pressed', String(prefs.compact)); text('compact-label', prefs.compact ? '拡大' : '縮小');
      $('compact').title = prefs.compact ? '通常の大きさに戻す' : '小さく表示'; $('compact').setAttribute('aria-label', $('compact').title); document.body.classList.toggle('compact', prefs.compact);
    }
  };
  for (const action of ['pin', 'compact']) $(action).addEventListener('click', () => window.webkit?.messageHandlers?.luma?.postMessage(action));
  setInterval(updateClock, 1000); render();
})();
