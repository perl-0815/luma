const assert = require('node:assert/strict');
const { test } = require('node:test');
const { layoutTasks } = require('../web/graph.js');

const task = (id, extra = {}) => ({ id, title: id, status: 'pending', parentId: null, dependsOn: [], ...extra });
function nonOverlapping(nodes) {
  for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
    const first = nodes[a], second = nodes[b];
    assert.ok(first.x + first.width <= second.x || second.x + second.width <= first.x ||
      first.y + first.height <= second.y || second.y + second.height <= first.y,
    `${first.id} overlaps ${second.id}`);
  }
}
function bounded(layout) {
  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.y >= 0);
    assert.ok(node.x + node.width <= layout.width && node.y + node.height <= layout.height);
  }
  for (const edge of layout.edges) {
    const coordinates = edge.path.match(/-?\d+(?:\.\d+)?/g).map(Number);
    for (let index = 0; index < coordinates.length; index += 2) {
      assert.ok(coordinates[index] >= 0 && coordinates[index] <= layout.width);
      assert.ok(coordinates[index + 1] >= 0 && coordinates[index + 1] <= layout.height);
    }
  }
}

test('empty task plans have no invented nodes or edges', () => {
  assert.deepEqual(layoutTasks([]), { nodes: [], edges: [], width: 0, height: 0 });
});

test('branches and merges occupy stable non-overlapping ranks', () => {
  const tasks = [task('inspect'), task('ui', { dependsOn: ['inspect'] }), task('backend', { dependsOn: ['inspect'] }),
    task('verify', { dependsOn: ['ui', 'backend'] })];
  const graph = layoutTasks(tasks);
  assert.deepEqual(graph.nodes.map(node => [node.id, node.rank]), [['inspect', 0], ['ui', 1], ['backend', 1], ['verify', 2]]);
  assert.equal(graph.edges.length, 4);
  assert.equal(graph.nodes[1].y, graph.nodes[2].y);
  assert.ok(graph.nodes[1].x < graph.nodes[2].x);
  nonOverlapping(graph.nodes); bounded(graph);
});

test('hierarchy and dependency keep their meaning and duplicate relations draw once', () => {
  const graph = layoutTasks([task('group'), task('child', { parentId: 'group' }),
    task('next', { parentId: 'group', dependsOn: ['group', 'child'] })]);
  assert.deepEqual(graph.edges.map(({ from, to, type }) => ({ from, to, type })), [
    { from: 'group', to: 'child', type: 'hierarchy' },
    { from: 'group', to: 'next', type: 'dependency' },
    { from: 'child', to: 'next', type: 'dependency' }
  ]);
  nonOverlapping(graph.nodes); bounded(graph);
});

test('status, report text and titles never move nodes or mutate the input', () => {
  const original = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { parentId: 'a' })];
  const saved = JSON.stringify(original);
  const before = layoutTasks(original);
  const changed = original.map(item => ({ ...item, status: 'done', title: '長い名前'.repeat(15), message: '新しい報告' }));
  assert.deepEqual(layoutTasks(changed), before);
  assert.equal(JSON.stringify(original), saved);
});

test('cycles spanning hierarchy and dependencies retain every node and route outside boxes', () => {
  const tasks = [task('a', { parentId: 'b' }), task('b', { dependsOn: ['a'] }), task('after', { dependsOn: ['b'] })];
  for (const orientation of ['vertical', 'horizontal']) {
    const graph = layoutTasks(tasks, { orientation });
    assert.equal(graph.nodes.length, 3);
    assert.deepEqual(graph.nodes.map(node => node.rank), [0, 0, 1]);
    assert.equal(graph.edges.length, 3);
    assert.ok(graph.edges.filter(edge => edge.from !== 'b' || edge.to !== 'after').every(edge => edge.path.includes(' L ')));
    nonOverlapping(graph.nodes); bounded(graph);
  }
});

test('disconnected tasks stay independent without inferred ordering edges', () => {
  const graph = layoutTasks([task('one'), task('two'), task('three')]);
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(graph.nodes.map(node => node.rank), [0, 0, 0]);
  assert.deepEqual(graph.nodes.map(node => node.id), ['one', 'two', 'three']);
  nonOverlapping(graph.nodes); bounded(graph);
});

test('horizontal and vertical edges meet the expected node ports', () => {
  for (const orientation of ['vertical', 'horizontal']) {
    const graph = layoutTasks([task('from'), task('to', { dependsOn: ['from'] })], { orientation, nodeWidth: 180, nodeHeight: 80 });
    const [from, to] = graph.nodes, edge = graph.edges[0];
    const vertical = orientation === 'vertical';
    const start = `M ${from.x + (vertical ? 90 : 180)} ${from.y + (vertical ? 80 : 40)} `;
    const end = `${to.x + (vertical ? 90 : 0)} ${to.y + (vertical ? 0 : 40)}`;
    assert.ok(edge.path.startsWith(start));
    assert.ok(edge.path.endsWith(end));
    if (vertical) assert.ok(to.y > from.y); else assert.ok(to.x > from.x);
    nonOverlapping(graph.nodes); bounded(graph);
  }
});

test('edges which skip ranks use outer gutters instead of crossing intermediate nodes', () => {
  const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b', 'a'] })];
  const graph = layoutTasks(tasks);
  assert.ok(graph.edges.find(edge => edge.from === 'a' && edge.to === 'c').path.includes(' L '));
  assert.ok(graph.edges.find(edge => edge.from === 'b' && edge.to === 'c').path.includes(' C '));
  bounded(graph);
});

test('the supported 200-task chain stays finite and preserves all relationships', () => {
  const tasks = Array.from({ length: 200 }, (_, index) => task(`task-${index}`, { dependsOn: index ? [`task-${index - 1}`] : [] }));
  for (const orientation of ['vertical', 'horizontal']) {
    const graph = layoutTasks(tasks, { orientation });
    assert.equal(graph.nodes.length, 200); assert.equal(graph.edges.length, 199);
    assert.equal(graph.nodes[199].rank, 199);
    assert.ok(Number.isFinite(graph.width) && Number.isFinite(graph.height));
    nonOverlapping(graph.nodes); bounded(graph);
    assert.deepEqual(layoutTasks(tasks, { orientation }), graph);
  }
});

test('invalid geometry cannot produce NaN or inverted graph dimensions', () => {
  for (const settings of [{ nodeWidth: 0 }, { nodeHeight: NaN }, { gapX: -1 }, { padding: Infinity }, { orientation: 'diagonal' }]) {
    assert.throws(() => layoutTasks([task('a')], settings), TypeError);
  }
  assert.throws(() => layoutTasks([task('a'), task('a')]), TypeError);
  const zeroSpacing = layoutTasks([task('a', { dependsOn: ['a'] })], { padding: 0, gapX: 0, gapY: 0 });
  bounded(zeroSpacing);
});
