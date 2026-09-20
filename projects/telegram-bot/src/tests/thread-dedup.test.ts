import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGoal, findDuplicateGoal } from '../thread-dedup.js';
import type { ThreadRecord } from '../topic-threads.js';

function mkRec(id: string, n: number, status: ThreadRecord['status'], goal: string): ThreadRecord {
  return {
    id,
    n,
    title: `thread ${n}`,
    goal,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workdir: 'C:/pa-checkout',
    runSeq: 1,
    attempts: 0,
    pendingInput: [],
  };
}

describe('normalizeGoal', () => {
  it('D1: lowercases, strips punctuation, collapses whitespace, trims', () => {
    assert.equal(normalizeGoal('  Sweep  the LOGS!!\n'), 'sweep the logs');
  });
});

describe('findDuplicateGoal', () => {
  it('D2: exact hit against a running record', () => {
    const rec = mkRec('t-1', 1, 'running', 'Sweep the logs.');
    const match = findDuplicateGoal('sweep  THE logs!!', [rec]);
    assert.deepEqual(match, { id: 't-1', title: 'thread 1', reason: 'exact' });
  });

  it('D3: terminal records are never candidates', () => {
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      const rec = mkRec('t-1', 1, status, 'Sweep the logs.');
      assert.equal(findDuplicateGoal('Sweep the logs.', [rec]), null);
    }
  });

  it('D4: containment arm discriminating pair', () => {
    const long30 = 'a'.repeat(30);
    const short26 = 'a'.repeat(26);
    const containmentRec = mkRec('t-1', 1, 'running', long30);
    const containmentMatch = findDuplicateGoal(short26, [containmentRec]);
    assert.equal(containmentMatch?.reason, 'containment');

    const short20 = 'b'.repeat(20);
    const shorter16 = 'b'.repeat(16);
    const tooShortRec = mkRec('t-2', 2, 'running', short20);
    assert.equal(findDuplicateGoal(shorter16, [tooShortRec]), null);
  });

  it('D5: false-positive guard on genuinely different goals', () => {
    const rec = mkRec('t-1', 1, 'running', 'count the running widgets');
    assert.equal(findDuplicateGoal('tally the B figures', [rec]), null);
  });

  it('D6: oldest live twin wins on identical goals', () => {
    const goal = 'do the exact same thing twice';
    const older = mkRec('t-1', 1, 'queued', goal);
    const newer = mkRec('t-4', 4, 'running', goal);
    const match = findDuplicateGoal(goal, [newer, older]);
    assert.equal(match?.id, 't-1');
  });

  it('D7: exact beats containment', () => {
    const long30 = 'c'.repeat(30);
    const short26 = 'c'.repeat(26);
    const containmentCandidate = mkRec('t-1', 1, 'running', long30);
    const exactCandidate = mkRec('t-3', 3, 'running', short26);
    const match = findDuplicateGoal(short26, [containmentCandidate, exactCandidate]);
    assert.deepEqual(match, { id: 't-3', title: 'thread 3', reason: 'exact' });
  });

  it('D8: empty/whitespace-only incoming goal returns null even with a candidate', () => {
    const rec = mkRec('t-1', 1, 'running', 'Sweep the logs.');
    assert.equal(findDuplicateGoal('   ', [rec]), null);
  });
});
