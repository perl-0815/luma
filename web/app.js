(() => {
  'use strict';
  const { STATES, TASK_STATES, valid, taskStatus, validPayload, overall, globalStatus, focusMessage, elapsed, groupSessions, ageLabel } = window.LumaModel;
  const $ = id => document.getElementById(id);
  let state = { sessions: [] }, selected = null, readError = false, showCompleted = false;
  const selectedTasks = new Map();
  let graphLayout = null;
  let graphWidth = 0;
  const current = () => state.sessions.find(session => session.id === selected);
  const shownSessions = () => {
    const { visible, history } = groupSessions(state.sessions);
    return showCompleted ? [...visible, ...history] : visible;
  };
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
    render(id);
    if (focus) {
      const tab = selectedTab();
      tab?.focus({ preventScroll: true });
      tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  function selectTask(id, source = 'node') {
    const closedExplorer = source === 'explorer' && window.innerWidth < 1100;
    selectedTasks.set(selected, id);
    $('detail').scrollTop = 0;
    $('workspace').classList.remove('outline-open');
    if (window.matchMedia('(max-width: 780px)').matches && source !== 'keyboard') $('workspace').classList.add('inspector-open');
    render();
    if (source !== 'node') {
      const focusDestination = source === 'keyboard' || source === 'relation' || (closedExplorer && window.innerWidth > 780);
      if (!revealNode(id, focusDestination) && focusDestination) $('detail').focus({ preventScroll: true });
    }
    if (window.matchMedia('(max-width: 780px)').matches && source !== 'keyboard') $('inspector-close').focus({ preventScroll: true });
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
      const sessions = shownSessions(), index = sessions.findIndex(item => item.id === session.id), count = sessions.length;
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % count;
      if (event.key === 'ArrowLeft') next = (index + count - 1) % count;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = count - 1;
      if (next !== undefined) { event.preventDefault(); selectSession(sessions[next].id, true); }
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
      button.append(node, copy); button.addEventListener('click', () => selectTask(task.id, 'explorer')); li.append(button);
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
        link.dataset.focusKey = `relation:${id}`; link.addEventListener('click', () => selectTask(id, 'relation')); row.append(link);
      }
      $('task-relations').append(row);
    };
    add('親タスク', task.parentId === null ? [] : [task.parentId]); add('前提タスク', task.dependsOn);
  }
  function revealNode(id, focus = false) {
    const key = id === null ? 'node:overview' : `node:${id}`;
    const node = [...$('graph-nodes').children].find(item => item.dataset.focusKey === key);
    if (!node) return false;
    const viewport = $('graph-viewport');
    const left = node.offsetLeft + $('graph-stage').offsetLeft, top = node.offsetTop + $('graph-stage').offsetTop;
    if (left < viewport.scrollLeft + 20) viewport.scrollLeft = left - 20;
    else if (left + node.offsetWidth > viewport.scrollLeft + viewport.clientWidth - 20) viewport.scrollLeft = left + node.offsetWidth - viewport.clientWidth + 20;
    if (top < viewport.scrollTop + 20) viewport.scrollTop = top - 20;
    else if (top + node.offsetHeight > viewport.scrollTop + viewport.clientHeight - 20) viewport.scrollTop = top + node.offsetHeight - viewport.clientHeight + 20;
    if (focus) node.focus({ preventScroll: true });
    return true;
  }
  function resetGraphView(id) {
    const target = id ?? graphLayout?.nodes[0]?.id ?? null;
    const key = target === null ? 'node:overview' : `node:${target}`;
    const node = [...$('graph-nodes').children].find(item => item.dataset.focusKey === key);
    const viewport = $('graph-viewport');
    viewport.scrollLeft = node ? Math.max(0, node.offsetLeft + $('graph-stage').offsetLeft + node.offsetWidth / 2 - viewport.clientWidth / 2) : 0;
    viewport.scrollTop = node ? Math.max(0, node.offsetTop + $('graph-stage').offsetTop - 24) : 0;
  }
  function syncPanels() {
    const workspace = $('workspace'), width = window.innerWidth;
    const outline = width >= 1100 || workspace.classList.contains('outline-open');
    const inspector = width > 780 || workspace.classList.contains('inspector-open');
    const inspectorOverlay = width <= 780 && inspector;
    $('explorer-toggle').setAttribute('aria-expanded', String(outline));
    $('explorer-toggle').setAttribute('aria-label', outline ? 'エクスプローラーを閉じる' : 'エクスプローラーを表示');
    $('inspector-toggle').setAttribute('aria-expanded', String(inspector));
    $('inspector-toggle').setAttribute('aria-label', inspector ? 'インスペクターを閉じる' : 'インスペクターを表示');
    $('explorer').inert = !outline || inspectorOverlay;
    $('detail').inert = !inspector;
    $('graph-panel').inert = inspectorOverlay;
    $('graph-viewport').inert = (width < 1100 && workspace.classList.contains('outline-open')) || (width <= 780 && workspace.classList.contains('inspector-open'));
  }
  function closeInspector() {
    $('workspace').classList.remove('inspector-open'); syncPanels();
    const id = selectedTasks.get(selected) || null;
    revealNode(id, true);
    if (!$('graph-nodes').contains(document.activeElement)) $('inspector-toggle').focus({ preventScroll: true });
  }
  function moveNode(event, id) {
    const directions = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    const direction = directions[event.key];
    if (!direction || !graphLayout) return;
    event.preventDefault();
    const origin = graphLayout.nodes.find(node => node.id === id);
    if (!origin) return;
    const [dx, dy] = direction;
    const candidates = graphLayout.nodes.filter(node => node.id !== id && (node.x - origin.x) * dx + (node.y - origin.y) * dy > 0);
    const score = node => Math.abs((node.x - origin.x) * dx + (node.y - origin.y) * dy) + 2 * Math.abs((node.x - origin.x) * dy - (node.y - origin.y) * dx);
    candidates.sort((a, b) => score(a) - score(b));
    if (candidates[0]) selectTask(candidates[0].id, 'keyboard');
  }
  function renderGraph(session) {
    const focused = focusKey(document.activeElement);
    const viewport = $('graph-viewport'), top = viewport.scrollTop, left = viewport.scrollLeft;
    const tasks = session?.tasks || [], agents = session?.agents || [];
    const orientation = viewport.clientWidth >= 820 ? 'horizontal' : 'vertical';
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = (name, attrs = {}) => {
      const node = document.createElementNS(svgNS, name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      return node;
    };
    graphWidth = viewport.clientWidth;
    graphLayout = window.LumaGraph.layoutTasks(tasks, { orientation });
    if (session && !tasks.length) graphLayout = { nodes: [{ id: null, x: 40, y: 40, width: 220, height: 104 }], edges: [], width: 300, height: 184 };
    $('graph-stage').hidden = !session;
    $('graph-empty').hidden = !!session;
    $('graph-home').disabled = !session;
    $('graph-stage').style.width = `${graphLayout.width}px`;
    $('graph-stage').style.height = `${graphLayout.height}px`;
    $('graph-stage').dataset.orientation = orientation;
    $('graph-edges').setAttribute('width', graphLayout.width);
    $('graph-edges').setAttribute('height', graphLayout.height);
    $('graph-edges').replaceChildren();
    const defs = svg('defs'), marker = svg('marker', { id: 'dependency-arrow', markerWidth: '7', markerHeight: '7', refX: '6', refY: '3.5', orient: 'auto', markerUnits: 'userSpaceOnUse' });
    marker.append(svg('path', { d: 'M0 0 L7 3.5 L0 7 Z', fill: 'currentColor' })); defs.append(marker); $('graph-edges').append(defs);
    for (const edge of graphLayout.edges) {
      const from = tasks.find(task => task.id === edge.from);
      const path = svg('path', { d: edge.path, class: `edge ${edge.type}`, 'data-state': from?.status || 'pending', 'data-related': String([edge.from, edge.to].includes(selectedTasks.get(selected))) });
      if (edge.type === 'dependency') path.setAttribute('marker-end', 'url(#dependency-arrow)');
      $('graph-edges').append(path);
    }
    $('graph-nodes').replaceChildren();
    const chosen = selectedTasks.get(selected) || null;
    for (const [index, layout] of graphLayout.nodes.entries()) {
      const task = tasks.find(item => item.id === layout.id), status = task ? task.status : overall(session);
      const title = task ? task.title : session.title, label = (task ? TASK_STATES : STATES)[status].label;
      const button = element('button', 'graph-node'); button.type = 'button';
      button.dataset.focusKey = task ? `node:${task.id}` : 'node:overview'; button.dataset.state = status;
      button.setAttribute('aria-pressed', String((task ? task.id : null) === chosen));
      button.setAttribute('aria-label', `${title}、${label}`); button.title = `${title} — ${label}`;
      button.tabIndex = task ? (chosen ? (chosen === task.id ? 0 : -1) : (index === 0 ? 0 : -1)) : 0;
      Object.assign(button.style, { left: `${layout.x}px`, top: `${layout.y}px`, width: `${layout.width}px`, height: `${layout.height}px` });
      const meta = element('span', 'node-top'), mark = element('span', 'node-mark'); mark.setAttribute('aria-hidden', 'true');
      meta.append(mark, element('span', 'node-state', label)); button.append(meta, element('span', 'node-title', title));
      for (const side of ['input', 'output']) {
        const port = element('span', `node-port ${side}`); port.setAttribute('aria-hidden', 'true'); button.append(port);
      }
      const assignee = agents.find(agent => agent.id === task?.agentId);
      if (assignee) button.append(element('span', 'node-assignee', assignee.name));
      button.addEventListener('click', () => selectTask(task?.id || null));
      if (task) button.addEventListener('keydown', event => moveNode(event, task.id));
      $('graph-nodes').append(button);
    }
    text('graph-project', session ? shortProject(session.project) : '');
    text('graph-progress', tasks.length ? `${tasks.filter(task => ['done', 'skipped'].includes(task.status)).length} / ${tasks.length}` : '');
    viewport.scrollTop = top; viewport.scrollLeft = left;
    if (focused?.startsWith('node:')) [...$('graph-nodes').children].find(node => node.dataset.focusKey === focused)?.focus({ preventScroll: true });
  }
  function render(preferredSelection = selected) {
    const activeElement = document.activeElement, focused = focusKey(activeElement);
    const sessions = shownSessions(), previousSelection = selected;
    selected = sessions.some(session => session.id === preferredSelection) ? preferredSelection : sessions[0]?.id || null;
    const selectionChanged = selected !== previousSelection;
    const moveFocus = selectionChanged && ($('sessions').contains(activeElement) || $('workspace').contains(activeElement));
    if (selectionChanged) {
      $('detail').scrollTop = 0; $('workspace').scrollTop = 0;
      $('graph-viewport').scrollTop = 0; $('graph-viewport').scrollLeft = 0;
      $('workspace').classList.remove('outline-open', 'inspector-open');
    }
    const scroll = ['sessions', 'explorer', 'detail', 'task-tree-container', 'graph-viewport'].map(id => [id, $(id).scrollTop, $(id).scrollLeft]);
    const global = globalStatus(state.sessions, readError);
    $('global-indicator').dataset.color = global.color;
    text('global-label', global.label); text('global-detail', global.detail);
    $('sessions').replaceChildren(...sessions.map(tab));
    const completedCount = groupSessions(state.sessions).history.length;
    $('history-toggle').hidden = !completedCount;
    $('history-toggle').setAttribute('aria-pressed', String(showCompleted));
    text('history-toggle', `完了履歴 (${completedCount})`);
    const emptyMessage = completedCount ? '進行中の作業はありません。完了した作業は「完了履歴」から確認できます。' : '表示する作業はありません';
    text('graph-empty', emptyMessage); text('empty-message', emptyMessage);
    const session = current(), tasks = session?.tasks || [], task = taskFor(session), agents = session?.agents || [];
    $('workspace').setAttribute('aria-labelledby', session ? `session-${session.id}` : 'global-label');
    $('empty').hidden = !!session; $('session-content').hidden = !session; $('explorer').hidden = !session;
    const completed = tasks.filter(item => ['done', 'skipped'].includes(item.status)).length;
    const count = tasks.length ? `${completed} / ${tasks.length}` : '0件';
    text('task-count', count);
    $('overview').setAttribute('aria-pressed', String(!task)); $('overview').dataset.state = overall(session);
    $('task-tree').replaceChildren(); appendTasks($('task-tree'), tasks, null, agents); $('no-tasks').hidden = tasks.length > 0;
    if (session) {
      text('project', shortProject(session.project)); $('project').title = session.project;
      text('session-name', session.title); $('session-name').hidden = !task; text('detail-title', task ? task.title : session.title);
      const status = task ? task.status : overall(session);
      $('detail-state').dataset.state = status;
      $('detail-state').replaceChildren(dot(), document.createTextNode((task ? TASK_STATES : STATES)[status].label));
      text('report', task ? task.message : focusMessage(session)); $('report').hidden = !$('report').textContent;
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
    renderGraph(session); syncPanels();
    for (const [id, top, left] of scroll) { $(id).scrollTop = top; $(id).scrollLeft = left; }
    if (selectionChanged) {
      selectedTab()?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      resetGraphView(selectedTasks.get(selected));
    }
    if (moveFocus || (activeElement === $('history-toggle') && !completedCount)) {
      (selectedTab() || (!$('history-toggle').hidden && $('history-toggle')) || $('graph-viewport')).focus({ preventScroll: true });
    } else if (focused && !selectionChanged) {
      [...document.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === focused)?.focus({ preventScroll: true });
    }
    const announcement = session ? `${session.title}、${STATES[overall(session)].label}${task ? `。${task.title}、${TASK_STATES[task.status].label}` : ''}` : emptyMessage;
    if ($('announcement').textContent !== announcement) text('announcement', announcement); updateClock();
  }
  $('history-toggle').addEventListener('click', () => { showCompleted = !showCompleted; render(); });
  function updateClock() {
    const session = current(); if (!session) return;
    const task = taskFor(session); text('updated', ageLabel(task?.updatedAt || session.updatedAt));
    text('duration', (overall(session) === 'done' ? '所要 ' : '経過 ') + elapsed(session.startedAt, overall(session) === 'done' ? session.updatedAt : new Date()));
  }
  $('overview').addEventListener('click', () => selectTask(null, 'explorer'));
  $('explorer-toggle').addEventListener('click', () => {
    const open = !$('workspace').classList.contains('outline-open');
    $('workspace').classList.toggle('outline-open', open); $('workspace').classList.remove('inspector-open'); syncPanels();
    if (open) $('overview').focus({ preventScroll: true });
  });
  $('inspector-toggle').addEventListener('click', () => {
    const open = !$('workspace').classList.contains('inspector-open');
    if (!open) { closeInspector(); return; }
    $('workspace').classList.add('inspector-open'); $('workspace').classList.remove('outline-open'); syncPanels();
    $('inspector-close').focus({ preventScroll: true });
  });
  $('inspector-close').addEventListener('click', closeInspector);
  $('graph-home').addEventListener('click', () => {
    resetGraphView();
  });
  $('workspace').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if ($('workspace').classList.contains('inspector-open')) { event.preventDefault(); closeInspector(); }
    else if ($('workspace').classList.contains('outline-open')) {
      event.preventDefault(); $('workspace').classList.remove('outline-open'); syncPanels(); $('explorer-toggle').focus({ preventScroll: true });
    }
  });
  window.luma = {
    receive(payload) {
      if (!validPayload(payload)) { this.connectionError('状態ファイルの形式を確認してください'); return; }
      const previous = current(), previousIDs = new Set(state.sessions.map(session => session.id));
      state = payload;
      let nextSelection = selected;
      const newest = state.sessions[state.sessions.length - 1];
      if (previous && state.sessions.some(session => session.id === selected) && newest &&
        !previousIDs.has(newest.id) && overall(previous) === 'done') nextSelection = newest.id;
      for (const [id, taskID] of selectedTasks) if (!state.sessions.find(session => session.id === id)?.tasks?.some(task => task.id === taskID)) selectedTasks.delete(id);
      readError = false; $('connection-error').hidden = true; render(nextSelection);
    },
    connectionError(message) { readError = true; text('connection-error', message); $('connection-error').hidden = false; render(); },
    preferences(prefs) {
      $('pin').setAttribute('aria-pressed', String(prefs.pinned)); $('pin').title = prefs.pinned ? '最前面への固定を解除' : '最前面に固定'; $('pin').setAttribute('aria-label', $('pin').title);
      $('compact').setAttribute('aria-pressed', String(prefs.compact)); text('compact-label', prefs.compact ? 'FULL' : 'COMPACT');
      $('compact').title = prefs.compact ? '通常の大きさに戻す' : '小さく表示'; $('compact').setAttribute('aria-label', $('compact').title); document.body.classList.toggle('compact', prefs.compact); syncPanels();
    }
  };
  for (const action of ['pin', 'compact']) $(action).addEventListener('click', () => window.webkit?.messageHandlers?.luma?.postMessage(action));
  new ResizeObserver(() => {
    syncPanels();
    if ($('graph-viewport').clientWidth !== graphWidth) {
      renderGraph(current()); resetGraphView(selectedTasks.get(selected));
    }
  }).observe($('graph-viewport'));
  setInterval(updateClock, 1000); render();
})();
