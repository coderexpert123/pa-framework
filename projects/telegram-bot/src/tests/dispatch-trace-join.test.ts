/**
 * Source invariant: every worker call inside `dispatchMessage` must pass `updateId`.
 *
 * WHY THIS IS A SOURCE TEST, NOT A FUNCTIONAL ONE. `main.ts` imports `executeWorker`
 * and `runWithFailover` directly from `pa/dist` with no injection seam, so no unit test
 * can observe the options object a real dispatch builds. The existing dispatch tests
 * (`dispatch-session.test.ts`) hand-roll their own mock worker and therefore cannot
 * catch a missing option at main.ts's real call sites. Same class as pa's
 * `worker-exec-silent-sites.test.ts` / `analyzer-silent-sites.test.ts`.
 *
 * WHAT IT PROTECTS (AI-161, found 2026-08-25 against live data). The trace sidecar
 * (`~/.pa/turn-traces.jsonl`, `pa/src/lib/turn-trace.ts`) records `update_id` only from
 * `options.updateId` (`worker-exec.ts`, the `appendTurnTrace` call). `parseBotResource`
 * recovers `chat_id`/`thread_id` from the `topic-<chat>_<thread>` resource string, but the
 * resource carries NO update id. `pa ref <refId>` joins an archived turn to its trace on
 * `(thread_id, update_id)` (`lookupTraceByUpdate`, `pa/src/lib/ref-lookup.ts`), because the
 * archive row deliberately does not carry `run_id`.
 *
 * So a call site that omits `updateId` produces a trace with no join key and `pa ref`
 * silently renders no trace block — no error, no failing test, just a missing feature.
 * That is exactly what shipped: only the failover site passed it, while the resumed /
 * preferred / default sites did not, so EVERY ordinary turn was unjoinable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
// dist/tests -> dist -> projects/telegram-bot; src/tests -> src -> projects/telegram-bot
const mainTs = join(here, '..', '..', 'src', 'main.ts');
// The dispatch call sites moved here in the AI-173 phase 3 extraction; both files
// are scanned so the invariant's strength is unchanged (not a weakening).
const dispatchTs = join(here, '..', '..', 'src', 'dispatch.ts');

/** Extract the balanced `{...}` options object literal that follows `prompt,` in a call. */
function optionsObjectAt(src: string, callIndex: number): string {
  const open = src.indexOf('{', callIndex);
  assert.ok(open > -1, 'no options object found after the call');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  assert.fail('unbalanced options object literal');
}

describe('dispatch worker call sites carry the trace join key', () => {
  const mainSrc = readFileSync(mainTs, 'utf8');
  const dispatchSrc = readFileSync(dispatchTs, 'utf8');
  const sources: Array<{ name: string; src: string }> = [
    { name: 'main.ts', src: mainSrc },
    { name: 'dispatch.ts', src: dispatchSrc },
  ];

  it('main.ts is readable and still calls the workers directly', () => {
    assert.ok(mainSrc.length > 0, 'expected main.ts to remain readable');
    assert.ok(dispatchSrc.includes('executeWorker('), 'expected direct executeWorker calls in dispatch.ts');
    assert.ok(dispatchSrc.includes('runWithFailover('), 'expected a runWithFailover call in dispatch.ts');
  });

  it('every executeWorker/runWithFailover call in the dispatch path passes updateId', () => {
    const offenders: string[] = [];
    let seen = 0;

    for (const { name, src } of sources) {
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/\b(executeWorker|runWithFailover)\s*\(/.test(line)) continue;
        // Skip import statements and type-only references.
        if (/^\s*import\b/.test(line)) continue;

        const callIndex = src.indexOf(line) === -1 ? -1 : src.indexOf(line);
        const opts = optionsObjectAt(src, callIndex);
        // Only dispatch-path calls build a `resource`-bearing options object; other callers
        // (none today in this file) would not be joinable turns anyway.
        if (!/\bresource\b/.test(opts)) continue;

        seen++;
        if (!/\bupdateId\b/.test(opts)) {
          offenders.push(`${name}:${i + 1}: ${line.trim().slice(0, 90)}`);
        }
      }
    }

    assert.ok(seen >= 4, `expected >=4 dispatch worker call sites, found ${seen}`);
    assert.deepEqual(
      offenders,
      [],
      'these dispatch call sites omit `updateId`, so their trace sidecar line gets no ' +
        '(thread_id, update_id) join key and `pa ref` will silently show no trace:\n' +
        offenders.join('\n'),
    );
  });
});
