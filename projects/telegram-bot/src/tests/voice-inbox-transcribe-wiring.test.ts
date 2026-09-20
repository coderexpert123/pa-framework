/**
 * Source invariant: `runPollLoop` must wire the voice-inbox transcription drain
 * (pa `voice-inbox-transcribe-drain.ts`, imported from `pa/dist`) into the bot's
 * poll loop, kicking it before the awaited route drain, without ever awaiting it.
 *
 * WHY THIS IS A SOURCE TEST, NOT A FUNCTIONAL ONE. `main.ts` imports
 * `createVoiceInboxTranscribeDrain` and `voiceInboxRouteHoldStates` directly from
 * `pa/dist` with no injection seam, so no unit test can observe whether the drain
 * is actually constructed, kicked, or wired into `drainVoiceInboxRoutes`'s
 * `taskStatesFn`. Same class as `dispatch-trace-join.test.ts`.
 *
 * WHAT IT PROTECTS. A drain constructed but never kicked (recordings never
 * transcribe), a kick that is mistakenly `await`ed (a hung transcription stalls
 * the whole poll loop), or a route drain wired without the hold (routing workers
 * race the transcription and get told to transcribe a task that is already
 * transcribing — the duplicate-transcription defect this wave exists to close).
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

describe('voice-inbox transcription drain wiring (main.ts, source invariant)', () => {
  it('main.ts imports createVoiceInboxTranscribeDrain and voiceInboxRouteHoldStates from pa/dist', () => {
    assert.match(
      source,
      /import \{ createVoiceInboxTranscribeDrain, voiceInboxRouteHoldStates \} from '\.\.\/\.\.\/\.\.\/pa\/dist\/src\/lib\/voice-inbox-transcribe-drain\.js';/,
    );
  });

  it('main.ts passes taskStatesFn: voiceInboxRouteHoldStates to the route drain', () => {
    assert.ok(loopStart >= 0, 'runPollLoop must exist in main.ts');
    const drainCallIdx = loop.indexOf('drainVoiceInboxRoutes({');
    const taskStatesFnIdx = loop.indexOf('taskStatesFn: voiceInboxRouteHoldStates,');
    const constDrainIdx = loop.indexOf('const voiceTranscribeDrain = createVoiceInboxTranscribeDrain();');
    assert.ok(drainCallIdx >= 0, 'drainVoiceInboxRoutes({ call must exist');
    assert.ok(taskStatesFnIdx >= 0, 'taskStatesFn: voiceInboxRouteHoldStates, must exist');
    assert.ok(constDrainIdx >= 0, 'const voiceTranscribeDrain = createVoiceInboxTranscribeDrain(); must exist');
    assert.ok(drainCallIdx < taskStatesFnIdx);
    assert.ok(taskStatesFnIdx < constDrainIdx);
  });

  it('runPollLoop kicks the transcription drain before the awaited route drain', () => {
    const k = loop.indexOf('voiceTranscribeDrain.kick();');
    const r = loop.indexOf('await routeQueueDrain()');
    assert.ok(k >= 0, 'voiceTranscribeDrain.kick(); must exist');
    assert.ok(r >= 0, 'await routeQueueDrain() must exist');
    assert.ok(k < r, 'the kick must precede the awaited route drain');
    assert.ok(r - k < 800, 'the kick and the route drain call must be close together');
  });

  it('the transcription drain kick is never awaited', () => {
    assert.equal(/await\s+voiceTranscribeDrain/.test(code), false);
    assert.equal(/await\s+[^;\n]*\.kick\(\)/.test(code), false);
  });
});
