/**
 * topic-pointers.ts — the shared per-topic pointer lines + ## Live reservations
 * section consumed by every prompt lane (human/orchestrator/thread/task).
 * Pins: the human-lane lines byte-for-byte (context.test.ts quotes them), the
 * orchestrator's spawn-to-run voice (tool-less lane), and the fail-silent
 * contract — a pointer must never break a dispatch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTopicPointerLines, renderReservationsBlock } from '../topic-pointers.js';
import type { TopicBrainInfo } from '../topic-brains.js';
import type { Reservation } from '../../../../pa/dist/src/lib/reservations.js';

const TOPIC = { chatId: -1001234567890, threadId: 5001 };

function makeBrainInfo(overrides: Partial<TopicBrainInfo> = {}): TopicBrainInfo {
  return {
    path: 'C:/pa-test/topic-brains/-1001234567890_5001/BRAIN.md',
    consolidated: '2026-09-10T12:00:00+05:30',
    covers: '2026-09-09T18:00:00.000Z',
    ...overrides,
  };
}

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r-abc12345',
    paths: ['pa/src/foo.ts'],
    session: 'builder-x',
    note: 'doing a thing',
    claimedAt: '2026-08-23T10:00:00.000Z',
    expiresAt: '2026-08-23T10:30:00.000Z',
    ...overrides,
  };
}

describe('renderTopicPointerLines — human/thread/task lanes', () => {
  it('emits the three pointer lines byte-for-byte (brain interpolated from stubbed info)', async () => {
    const info = makeBrainInfo();
    const lines = await renderTopicPointerLines(TOPIC, 'human', {
      getTopicBrainInfoFn: async () => info,
    });
    assert.equal(
      lines.brain,
      `\nTopic brain: ${info.path} (consolidated 2026-09-10, covers through 2026-09-09) — durable per-topic knowledge: what was discussed, decided, and left open. Read it before assuming prior context in this topic; fresh turns override it.`
    );
    assert.equal(
      lines.recall,
      '\nRecall: `pa recall "<terms>" --thread 5001 --json` searches this topic\'s full history, worker traces, topic brains and the Ecosystem KB — use it instead of guessing about anything before the window above.'
    );
    assert.equal(
      lines.decisions,
      '\nPrecedent: before proposing in this topic, run `pa recall "<intent>" --source decisions --thread 5001 --json` — past judgment calls with rationale and your reaction; honor strong precedents.'
    );
  });

  it('thread and task lanes share the human imperative voice', async () => {
    const fn = async () => makeBrainInfo();
    const human = await renderTopicPointerLines(TOPIC, 'human', { getTopicBrainInfoFn: fn });
    for (const lane of ['thread', 'task'] as const) {
      const other = await renderTopicPointerLines(TOPIC, lane, { getTopicBrainInfoFn: fn });
      assert.deepEqual(other, human, `${lane} lane emits the identical pointer lines`);
    }
  });

  it('brain is "" when the topic has no brain (null info)', async () => {
    const lines = await renderTopicPointerLines(TOPIC, 'human', {
      getTopicBrainInfoFn: async () => null,
    });
    assert.equal(lines.brain, '');
    assert.ok(lines.recall.length > 0 && lines.decisions.length > 0, 'recall/decisions always render');
  });

  it('degraded stamp → "freshness unknown", no covers clause', async () => {
    const lines = await renderTopicPointerLines(TOPIC, 'human', {
      getTopicBrainInfoFn: async () => makeBrainInfo({ consolidated: null, covers: null }),
    });
    assert.ok(lines.brain.includes('freshness unknown'));
    assert.ok(!lines.brain.includes('covers through'));
  });

  it('fail-silent: a throwing brain read resolves with brain:"" — never breaks a dispatch', async () => {
    const lines = await renderTopicPointerLines(TOPIC, 'human', {
      getTopicBrainInfoFn: async () => { throw new Error('brain store unavailable'); },
    });
    assert.equal(lines.brain, '');
    assert.ok(lines.recall.includes('pa recall "<terms>" --thread 5001'));
  });
});

describe('renderTopicPointerLines — orchestrator lane (no tools)', () => {
  it('recall/decisions speak spawn-to-run voice, never the worker imperative', async () => {
    const lines = await renderTopicPointerLines(TOPIC, 'orchestrator', {
      getTopicBrainInfoFn: async () => makeBrainInfo(),
    });
    // Brain line identical to every other lane.
    assert.ok(lines.brain.startsWith('\nTopic brain: '), 'brain line is lane-agnostic');
    for (const key of ['recall', 'decisions'] as const) {
      const line = lines[key];
      assert.ok(line.includes('you cannot run commands'), `${key}: spawn-voice framing`);
      assert.ok(line.includes('spawn a thread'), `${key}: delegates through a thread`);
      assert.ok(line.includes('--thread 5001'), `${key}: still carries the thread id`);
      assert.ok(
        !line.includes('Recall: `pa recall "<terms>" --thread') &&
          !line.includes('run `pa recall "<intent>"'),
        `${key}: no imperative aimed at the tool-less orchestrator`
      );
    }
  });
});

describe('renderReservationsBlock', () => {
  const HEADER = '## Live reservations\n- Active reservations right now (do not edit these paths unless the reservation is yours):';

  it('two rows: standalone section with header + both rows', async () => {
    const r1 = makeReservation({ id: 'r-11111111', paths: ['pa/src/a.ts'], session: 'sess-a', note: 'work a' });
    const r2 = makeReservation({ id: 'r-22222222', paths: ['pa/src/b.ts'], session: 'sess-b', note: 'work b' });
    const block = await renderReservationsBlock({ readActiveFn: async () => [r1, r2] });
    assert.ok(block.startsWith(`\n${HEADER}`), 'section leads with the header');
    assert.ok(block.includes('  - r-11111111 — pa/src/a.ts — session "sess-a" — "work a"'), 'row shape preserved');
    assert.ok(block.includes('r-22222222'), 'second row present');
  });

  it('zero reservations: "none." line under the section header', async () => {
    const block = await renderReservationsBlock({ readActiveFn: async () => [] });
    assert.equal(block, '\n## Live reservations\n- Active reservations right now: none.');
  });

  it('readActive throws → "" (no header, no partial section)', async () => {
    const block = await renderReservationsBlock({
      readActiveFn: async () => { throw new Error('reservation store unavailable'); },
    });
    assert.equal(block, '');
  });

  it('12 active reservations: exactly 10 rows plus the "(+2 more" overflow marker', async () => {
    const reservations = Array.from({ length: 12 }, (_, i) =>
      makeReservation({ id: `r-${String(i).padStart(8, '0')}`, session: `sess-${i}` })
    );
    const block = await renderReservationsBlock({ readActiveFn: async () => reservations });
    const rowLines = block.split('\n').filter((l) => /^ {2}- r-\d{8} /.test(l));
    assert.equal(rowLines.length, 10, 'exactly 10 reservation rows rendered');
    assert.ok(block.includes('(+2 more'), 'overflow line present');
    assert.ok(block.includes('run `pa claims`'), 'overflow points at the discovery command');
  });

  it('a reservation with 5 paths: 3 paths plus "(+2 more)"', async () => {
    const r = makeReservation({ paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] });
    const block = await renderReservationsBlock({ readActiveFn: async () => [r] });
    assert.ok(block.includes('a.ts, b.ts, c.ts (+2 more)'), 'first 3 paths plus overflow marker');
    assert.ok(!block.includes('d.ts'), 'path 4 must not appear');
    assert.ok(!block.includes('e.ts'), 'path 5 must not appear');
  });
});
