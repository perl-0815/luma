/* Deterministic local graph geometry; independent of status, text and the DOM. */
(function (root) {
  'use strict';

  const DEFAULTS = {
    orientation: 'vertical', nodeWidth: 220, nodeHeight: 104,
    gapX: 56, gapY: 64, padding: 40
  };

  function optionsFor(options) {
    const result = { ...DEFAULTS, ...options };
    if (!['vertical', 'horizontal'].includes(result.orientation)) throw new TypeError('Unknown graph orientation');
    for (const key of ['nodeWidth', 'nodeHeight', 'gapX', 'gapY', 'padding']) {
      if (!Number.isFinite(result[key]) || result[key] < 0 || (key.startsWith('node') && result[key] === 0)) {
        throw new TypeError(`Invalid graph ${key}`);
      }
    }
    return result;
  }

  function collectEdges(tasks, ids) {
    const edges = new Map();
    function add(from, to, type) {
      if (!ids.has(from)) return;
      const key = `${from}\0${to}`;
      const previous = edges.get(key);
      if (!previous) edges.set(key, { from, to, type });
      else if (type === 'dependency') previous.type = type;
    }
    for (const task of tasks) {
      if (task.parentId !== null && task.parentId !== undefined) add(task.parentId, task.id, 'hierarchy');
      for (const from of task.dependsOn || []) add(from, task.id, 'dependency');
    }
    return [...edges.values()];
  }

  // Rank the condensation DAG so a cycle spanning the two different relations
  // never hides nodes or turns layout into an unbounded relaxation loop.
  function ranksFor(tasks, edges) {
    const outgoing = new Map(tasks.map(task => [task.id, []]));
    for (const edge of edges) outgoing.get(edge.from).push(edge.to);
    const index = new Map(), low = new Map(), onStack = new Set(), stack = [], components = [];
    let sequence = 0;
    function visit(id) {
      index.set(id, sequence); low.set(id, sequence++);
      stack.push(id); onStack.add(id);
      for (const next of outgoing.get(id)) {
        if (!index.has(next)) { visit(next); low.set(id, Math.min(low.get(id), low.get(next))); }
        else if (onStack.has(next)) low.set(id, Math.min(low.get(id), index.get(next)));
      }
      if (low.get(id) === index.get(id)) {
        const members = [];
        let next;
        do { next = stack.pop(); onStack.delete(next); members.push(next); } while (next !== id);
        components.push(members);
      }
    }
    for (const task of tasks) if (!index.has(task.id)) visit(task.id);
    const componentOf = new Map();
    components.forEach((members, number) => members.forEach(id => componentOf.set(id, number)));
    const links = components.map(() => new Set()), incoming = components.map(() => 0), ranks = components.map(() => 0);
    for (const edge of edges) {
      const from = componentOf.get(edge.from), to = componentOf.get(edge.to);
      if (from !== to && !links[from].has(to)) { links[from].add(to); incoming[to]++; }
    }
    const first = components.map(() => tasks.length);
    tasks.forEach((task, position) => { const number = componentOf.get(task.id); first[number] = Math.min(first[number], position); });
    const ready = components.map((_, number) => number).filter(number => incoming[number] === 0).sort((a, b) => first[a] - first[b]);
    while (ready.length) {
      const from = ready.shift();
      for (const to of links[from]) {
        ranks[to] = Math.max(ranks[to], ranks[from] + 1);
        if (--incoming[to] === 0) { ready.push(to); ready.sort((a, b) => first[a] - first[b]); }
      }
    }
    return new Map(tasks.map(task => [task.id, ranks[componentOf.get(task.id)]]));
  }

  function layoutTasks(tasks, options = {}) {
    if (!Array.isArray(tasks)) throw new TypeError('Graph tasks must be an array');
    const settings = optionsFor(options);
    const { orientation, nodeWidth, nodeHeight, gapX, gapY, padding } = settings;
    const ids = new Set(tasks.map(task => task.id));
    if (ids.size !== tasks.length) throw new TypeError('Graph task IDs must be unique');
    if (!tasks.length) return { nodes: [], edges: [], width: 0, height: 0 };
    const relations = collectEdges(tasks, ids), ranks = ranksFor(tasks, relations);
    const groups = new Map();
    for (const task of tasks) {
      const rank = ranks.get(task.id);
      if (!groups.has(rank)) groups.set(rank, []);
      groups.get(rank).push(task.id);
    }
    const maxRank = Math.max(...groups.keys()), maxLanes = Math.max(...[...groups.values()].map(group => group.length));
    const laneOf = new Map();
    for (const group of groups.values()) group.forEach((id, position) => laneOf.set(id, position + (maxLanes - group.length) / 2));
    const vertical = orientation === 'vertical';
    const nodes = tasks.map(task => {
      const rank = ranks.get(task.id), lane = laneOf.get(task.id);
      return {
        id: task.id, rank,
        x: padding + (vertical ? lane : rank) * (nodeWidth + gapX),
        y: padding + (vertical ? rank : lane) * (nodeHeight + gapY),
        width: nodeWidth, height: nodeHeight
      };
    });
    const byID = new Map(nodes.map(node => [node.id, node]));
    let width = padding * 2 + (vertical ? maxLanes : maxRank + 1) * nodeWidth + (vertical ? maxLanes - 1 : maxRank) * gapX;
    let height = padding * 2 + (vertical ? maxRank + 1 : maxLanes) * nodeHeight + (vertical ? maxRank : maxLanes - 1) * gapY;
    const maxRight = width - padding, maxBottom = height - padding;
    let outerLane = 0;
    const edges = relations.map(edge => {
      const from = byID.get(edge.from), to = byID.get(edge.to);
      const sx = from.x + (vertical ? nodeWidth / 2 : nodeWidth), sy = from.y + (vertical ? nodeHeight : nodeHeight / 2);
      const tx = to.x + (vertical ? nodeWidth / 2 : 0), ty = to.y + (vertical ? 0 : nodeHeight / 2);
      let path;
      if (to.rank === from.rank + 1) {
        if (vertical) {
          const middle = (sy + ty) / 2;
          path = `M ${sx} ${sy} C ${sx} ${middle} ${tx} ${middle} ${tx} ${ty}`;
        } else {
          const middle = (sx + tx) / 2;
          path = `M ${sx} ${sy} C ${middle} ${sy} ${middle} ${ty} ${tx} ${ty}`;
        }
      } else {
        // Long and cyclic edges use the outside of all node boxes. Reuse a
        // small set of gutters rather than expanding a dense graph per edge.
        const offset = 20 + (outerLane++ % 6) * 8;
        if (vertical) {
          const gutter = maxRight + offset, clearance = Math.min(14, gapY / 3);
          const exit = sy + clearance, entry = Math.max(0, ty - clearance);
          path = `M ${sx} ${sy} L ${sx} ${exit} L ${gutter} ${exit} L ${gutter} ${entry} L ${tx} ${entry} L ${tx} ${ty}`;
          width = Math.max(width, gutter + padding);
          height = Math.max(height, exit + padding);
        } else {
          const gutter = maxBottom + offset, clearance = Math.min(14, gapX / 3);
          const exit = sx + clearance, entry = Math.max(0, tx - clearance);
          path = `M ${sx} ${sy} L ${exit} ${sy} L ${exit} ${gutter} L ${entry} ${gutter} L ${entry} ${ty} L ${tx} ${ty}`;
          width = Math.max(width, exit + padding);
          height = Math.max(height, gutter + padding);
        }
      }
      return { ...edge, path };
    });
    return { nodes, edges, width, height };
  }

  const api = { layoutTasks };
  root.LumaGraph = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
