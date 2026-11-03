import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildTurnTree, rootOf } from '../lib/tree-logic.js';

// Exercise the shipped client implementation as well as its pure counterpart.
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const start = bundle.indexOf('function buildTurnTree(');
const end = bundle.indexOf('function layoutTurnTree(', start);
const clientTree = runInNewContext(bundle.slice(start, end) + '\nbuildTurnTree;', { rootOf });
const turns = (...numbers) => numbers.map(turn => ({ turn, text: `Turn ${turn}` }));
const branch = (sessionId, parentSessionId, targetTurn, ...numbers) => ({
  sessionId, parentSessionId, targetTurn, turns: turns(...numbers), operation: 'edit',
});

for (const [name, build] of [['pure', buildTurnTree], ['client', clientTree]]) {
  test(`${name}: editing turn 6 from a turn 7 branch connects to the inherited turn 5`, () => {
    const versions = [
      { sessionId: 'A', turns: turns(1, 2, 3, 4, 5, 6) },
      branch('B', 'A', 6, 6, 7),
      branch('C', 'B', 7, 7, 8),
      branch('D', 'C', 6, 6, 7),
    ];
    const before = structuredClone(versions);
    const nodes = new Map(build(versions, 'D').map(n => [n.id, n]));
    assert.equal(nodes.get('D#t6').parentId, 'A#t5');
    assert.equal(nodes.get('D#t7').parentId, 'D#t6');
    assert.equal(nodes.get('C#t7').parentId, 'B#t6');
    for (const turn of [1, 2, 3, 4, 5]) assert.equal(nodes.get(`A#t${turn}`).onCurrentPath, true);
    assert.equal(nodes.get('B#t6').onCurrentPath, false);
    assert.deepEqual(versions, before, 'Rendering leaves session ancestry untouched');
  });

  test(`${name}: inherited previous turn belongs to an edited ancestor, not always the original`, () => {
    const nodes = new Map(build([
      { sessionId: 'A', turns: turns(1, 2, 3, 4, 5, 6) },
      branch('B', 'A', 4, 4, 5, 6),
      branch('C', 'B', 7, 7),
      branch('D', 'C', 6, 6),
      branch('E', 'D', 6, 6),
      branch('F', 'E', 1, 1),
    ], 'E').map(n => [n.id, n]));
    assert.equal(nodes.get('D#t6').parentId, 'B#t5');
    assert.equal(nodes.get('E#t6').parentId, 'B#t5');
    assert.equal(nodes.get('B#t4').parentId, 'A#t3');
    assert.equal(nodes.get('F#t1').parentId, 'A#root');
  });

  test(`${name}: hiding an archived ancestor preserves inherited turn connections`, () => {
    const versions = [
      { sessionId: 'A', turns: turns(1, 2, 3, 4, 5, 6) },
      { ...branch('B', 'A', 6, 6, 7), archived: true },
      branch('C', 'B', 7, 7),
      branch('D', 'C', 6, 6),
    ];
    const hidden = new Map(build(versions, 'D', false).map(n => [n.id, n]));
    assert.equal(hidden.has('B#t6'), false);
    assert.equal(hidden.get('D#t6').parentId, 'A#t5');
    assert.equal(hidden.get('C#t7').parentId, 'A#t5');
    const shown = new Map(build(versions, 'D', true).map(n => [n.id, n]));
    assert.equal(shown.get('C#t7').parentId, 'B#t6');
    assert.equal(shown.get('D#t6').parentId, 'A#t5');
  });
}
