/**
 * Source invariant: `runPollLoop` must wire pa's TypeSafe typed route drain
 * (pa `voice-inbox-typed-route-drain.ts`, imported from `pa/dist`) into the
 * bot's route drain as its `typedRouteFn` gate, constructed before the route
 * drain call, and never awaited.
 *
 * WHY THIS IS A SOURCE TEST, NOT A FUNCTIONAL ONE. `main.ts` imports
 * `createVoiceInboxTypedRouteDrain` directly from `pa/dist` with no injection
 * seam, so no unit test can observe whether the drain is actually constructed
 * or wired into `drainVoiceInboxRoutes`'s `typedRouteFn`. Same class as
 * `voice-inbox-transcribe-wiring.test.ts`.
 *
 * WHAT IT PROTECTS. A drain constructed but never wired (the typed gate never
 * consulted, so every inbox entry injects a duplicate routing turn while
 * TypeSafe places it), or a `gate()` call mistakenly `await`ed (gate() is
 * synchronous — awaiting it would stall the poll loop on nothing).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const mainTs = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main.ts');
const source = readFileSync(mainTs, 'utf8');

// SPEC A9 (2026-09-16): every indexOf/ordering assertion below runs against
// comment-stripped source, not raw source — a plain indexOf cannot tell a
// live call from the SAME text sitting inside a `//` comment (a known-bad
// mutation that comments out a call must fail these tests, not pass them).
// Strips block comments, whole-line `//` comments and trailing `//` comments.
// None of the snippets searched below contain the literal `//`, so this never
// eats a string literal that matters to the assertions.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/.*$/gm, '');

const loopStart = code.indexOf('export async function runPollLoop(');
const loop = loopStart >= 0 ? code.slice(loopStart) : '';

describe('voice-inbox typed route drain wiring (main.ts, source invariant)', () => {
  it('main.ts imports createVoiceInboxTypedRouteDrain from pa/dist', () => {
    assert.match(
      source,
      /import \{ createVoiceInboxTypedRouteDrain \} from '\.\.\/\.\.\/\.\.\/pa\/dist\/src\/lib\/voice-inbox-typed-route-drain\.js';/,
    );
  });

  it('runPollLoop constructs the typed route drain before the route drain call', () => {
    assert.ok(loopStart >= 0, 'runPollLoop must exist in main.ts');
    const constTypedIdx = loop.indexOf('const voiceTypedRouteDrain = createVoiceInboxTypedRouteDrain();');
    const drainCallIdx = loop.indexOf('drainVoiceInboxRoutes({');
    assert.ok(constTypedIdx >= 0, 'const voiceTypedRouteDrain = createVoiceInboxTypedRouteDrain(); must exist');
    assert.ok(drainCallIdx >= 0, 'drainVoiceInboxRoutes({ call must exist');
    assert.ok(constTypedIdx < drainCallIdx);
  });

  it('the route drain receives the typed gate right after taskStatesFn', () => {
    const drainCallIdx = loop.indexOf('drainVoiceInboxRoutes({');
    const taskStatesFnIdx = loop.indexOf('taskStatesFn: voiceInboxRouteHoldStates,');
    const typedRouteFnIdx = loop.indexOf('typedRouteFn: (taskId, state) => voiceTypedRouteDrain.gate(taskId, state),');
    const constTranscribeIdx = loop.indexOf('const voiceTranscribeDrain = createVoiceInboxTranscribeDrain();');
    assert.ok(drainCallIdx >= 0, 'drainVoiceInboxRoutes({ call must exist');
    assert.ok(taskStatesFnIdx >= 0, 'taskStatesFn: voiceInboxRouteHoldStates, must exist');
    assert.ok(typedRouteFnIdx >= 0, 'typedRouteFn: (taskId, state) => voiceTypedRouteDrain.gate(taskId, state), must exist');
    assert.ok(constTranscribeIdx >= 0, 'const voiceTranscribeDrain = createVoiceInboxTranscribeDrain(); must exist');
    assert.ok(drainCallIdx < taskStatesFnIdx);
    assert.ok(taskStatesFnIdx < typedRouteFnIdx);
    assert.ok(typedRouteFnIdx < constTranscribeIdx);
  });

  it('the typed route drain is never awaited', () => {
    assert.equal(/await\s+voiceTypedRouteDrain/.test(code), false);
  });
});
