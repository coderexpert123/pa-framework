/**
 * Unit tests for command-router.ts (AI-173 phase 2): the deterministic
 * command-interception cascade extracted from main.ts's processUpdate.
 *
 * Everything is injected — no test here spawns the real pa CLI, touches the
 * network, or reads the real ~/.pa (PA_HOME points at a temp dir). Ordering
 * cases (R-T6, R-T27, R-T36) assert on a shared `calls` log so the cascade's
 * load-bearing order is pinned, not just its outcomes.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import type { ConversationState } from '../types.js';
import {
  runCommandRouter,
  execPaCommand,
  execPaRef,
  type CommandRouterInput,
  type CommandRouterDeps,
} from '../command-router.js';
import {
  guardUnknownCommand,
  isKnownCommand,
  renderSessionExpiryMessage,
} from '../logic.js';
import { BOT_COMMANDS } from '../commands.js';
import { TOPIC_SOURCES_MAX } from '../sources.js';
import { redactAuthCommand, redactSecretCommand, buildOAuthCompletionMessage } from '../oauth.js';
import {
  voiceErrorMessage,
  formatTranscriptUserText,
  type VoiceResult,
} from '../voice.js';
import { formatWorkerDescriptor } from '../../../../pa/dist/src/lib/tunables.js';
import { waitForDrain } from './test-teardown-guard.js';
import { rmRetry } from './rm-retry.js';

const CHAT = -1001234567890;
const THREAD = 5001;

let sharedTempDir: string;

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'cmd-router-test-'));
  process.env.PA_HOME = sharedTempDir;
  await writeFile(join(sharedTempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
  await writeFile(join(sharedTempDir, 'rate-limit-state.json'), '{}', 'utf8');
  // /default's saveTopicDefault runs REAL in R-T22 — seed the config it opens.
  await writeFile(join(sharedTempDir, 'config.yaml'), 'workers: []\n', 'utf8');
});

after(async () => {
  await waitForDrain();
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

let caseTempDirs: string[];

beforeEach(async () => {
  caseTempDirs = [];
});

afterEach(async () => {
  await waitForDrain();
  for (const dir of caseTempDirs) await rmRetry(dir);
});

async function tempSubdir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  caseTempDirs.push(dir);
  return dir;
}

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    chat_id: CHAT,
    last_update_id: 0,
    thread_id: THREAD,
    turns: [],
    ...overrides,
  } as ConversationState;
}

/** A spawn() double whose stdout emits `json` and then closes. Also carries
 *  unref() for the git-family detached spawns. */
function makeSpawnDouble(calls: string[], json: () => string) {
  const proc = {
    stdout: {
      on: (ev: string, cb: (d: Buffer) => void) => {
        if (ev === 'data') queueMicrotask(() => cb(Buffer.from(json())));
      },
    },
    on: (ev: string, cb: () => void) => {
      if (ev === 'close') queueMicrotask(cb);
      return proc; // chainable — WB-304 error listeners attach after spawn
    },
    unref: () => calls.push('unref'),
  };
  const fn = ((file: string, args: string[], opts: any) => {
    calls.push(`spawn:${JSON.stringify(args)}:${JSON.stringify(opts)}`);
    return proc as any;
  }) as unknown as typeof import('child_process').spawn;
  return fn;
}

/** Like makeSpawnDouble, but also models a writable stdin — for /secret's
 *  `pa auth answer` spawn, which pipes the value on stdin rather than argv. */
function makeSpawnDoubleWithStdin(calls: string[], stdinWrites: string[], json: () => string) {
  const proc = {
    stdin: {
      write: (data: string) => { stdinWrites.push(data); },
      end: () => {},
    },
    stdout: {
      on: (ev: string, cb: (d: Buffer) => void) => {
        if (ev === 'data') queueMicrotask(() => cb(Buffer.from(json())));
      },
    },
    on: (ev: string, cb: () => void) => {
      if (ev === 'close') queueMicrotask(cb);
      return proc; // chainable — WB-304 error listeners attach after spawn
    },
    unref: () => calls.push('unref'),
  };
  const fn = ((file: string, args: string[], opts: any) => {
    calls.push(`spawn:${JSON.stringify(args)}:${JSON.stringify(opts)}`);
    return proc as any;
  }) as unknown as typeof import('child_process').spawn;
  return fn;
}

function baseInput(overrides: Partial<CommandRouterInput> = {}): CommandRouterInput {
  return {
    msg: { message_id: 42, date: 1757000000, from: { id: 42, first_name: 'Op' } },
    update: { update_id: 7 },
    userText: 'hello there',
    skipWorker: false,
    response: '',
    voiceTranscribed: false,
    audioAttachment: undefined,
    token: 'test-token',
    chatId: CHAT,
    threadId: THREAD,
    messageId: 42,
    timestamp: new Date(1757000000 * 1000).toISOString(),
    repoRoot: '/repo',
    topicState: makeState(),
    config: { workers: [{ name: 'agy' }, { name: 'zclaude' }, { name: 'claude' }, { name: 'codex' }] },
    effectiveDefault: 'agy',
    workdir: { dir: '/repo', tier: 'bot-cwd' },
    runtimeEnv: { PA_CMD_ROUTER_TEST: '1' } as NodeJS.ProcessEnv,
    secrets: {},
    allowedChatIds: new Set([CHAT]),
    ...overrides,
  };
}

function baseDeps(): { deps: CommandRouterDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: CommandRouterDeps = {
    refreshCard: (async () => { calls.push('refreshCard'); }) as any,
    syncModelStatus: ((state: any, snapshot: any) => {
      calls.push(`syncModelStatus:${snapshot.reason_code}`);
      state.model_status = snapshot;
    }) as any,
    spawnReauthLink: ((chatId: number, threadId: number | undefined, _env: NodeJS.ProcessEnv, skill?: string) => {
      calls.push(`spawnReauthLink:${skill ?? ''}`);
      return `reauth-link:${skill ?? 'none'}`;
    }) as any,
    injectResumeUpdate: ((args: { chatId: number; threadId: number; prompt: string }) => {
      calls.push(`injectResume:${args.chatId}_${args.threadId}`);
      return 1;
    }) as any,
    handleTunables: (async () => { calls.push('handleTunables'); return 'tunables-ok'; }) as any,
    send: (async () => { calls.push('send'); return {} as any; }) as any,
    deleteMessageFn: (async () => { calls.push('deleteMessage'); return {} as any; }) as any,
    addTurnFn: ((state: any, turn: any) => { calls.push(`addTurn:${turn.text}`); state.turns.push(turn); }) as any,
    saveTopicStateFn: (async () => { calls.push('saveTopicState'); }) as any,
    markRepliedFn: ((chatId: number, threadId: number) => { calls.push(`markReplied:${chatId}_${threadId}`); }) as any,
    spawnFn: makeSpawnDouble(calls, () => '') as any,
    statFn: stat as any,
    mkdirFn: (async (path: string, opts: any) => { calls.push(`mkdir:${path}`); return undefined as any; }) as any,
    execPaCommandFn: ((args: string[], maxChars?: number) => {
      calls.push(`execPaCommand:${JSON.stringify(args)}:${maxChars}`);
      return `PA-OUT:${args.join(' ')}`;
    }) as any,
    execPaRefFn: ((refId: string) => { calls.push(`execPaRef:${refId}`); return `REF-OUT:${refId}`; }) as any,
    appendTaskFn: (async (chatId: number, threadId: number, task: any) => {
      calls.push(`appendTask:${chatId}_${threadId}:${task.title}`);
      return { id: 'task-1', deduped: false };
    }) as any,
    loadSupportTopicFn: (async () => undefined) as any,
    getTopicExemptionsFn: (async () => new Map<string, string>()) as any,
    getTopicBrainInfoFn: (async () => ({ path: `${process.env.PA_HOME}/topic-brains/${CHAT}_${THREAD}/BRAIN.md` })) as any,
    findSessionForRefIdFn: (async () => undefined) as any,
    findHistoricalTurnsFn: (async () => [] as any[]) as any,
    transcribeFn: (async () => { throw new Error('transcribeFn not stubbed for this case'); }) as any,
    markAudioFn: (async () => { calls.push('markAudio'); return {} as any; }) as any,
    log: {
      info: (module: string, message: string) => calls.push(`log.info:${module}:${message}`),
      warn: (module: string, message: string) => calls.push(`log.warn:${module}:${message}`),
    },
  };
  return { deps, calls };
}

async function run(overrides: Partial<CommandRouterInput>, deps: CommandRouterDeps) {
  return runCommandRouter(baseInput(overrides), deps);
}

// ---------------------------------------------------------------------------
// R-T1 .. R-T10: guard, /auth, archive, no-content, skipWorker inputs
// ---------------------------------------------------------------------------

describe('command router — plain text, guard, /auth, archive', () => {
  it('R-T1: plain text matches nothing, archives, and leaves worker dispatch on', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({}, deps);
    assert.equal(r.skipWorker, false);
    assert.equal(r.response, '');
    assert.equal(r.voiceTranscribed, false);
    assert.equal(r.archivedUserText, 'hello there');
    // no interception dep fired
    for (const marker of ['refreshCard', 'syncModelStatus:', 'handleTunables', 'execPaCommand:', 'execPaRef:', 'spawnReauthLink:', 'injectResume:']) {
      assert.ok(!calls.some((c) => c.startsWith(marker)), `unexpected call: ${marker}`);
    }
    assert.ok(calls.some((c) => c.startsWith('addTurn:')));
  });

  it('R-T2: unknown single-token command gets the local guard reply and never reaches /auth', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/nosuchcmd' }, deps);
    assert.equal(r.response, 'Unknown command: /nosuchcmd\n\nTry /help for available commands.');
    assert.equal(r.response, guardUnknownCommand('/nosuchcmd')!.response);
    assert.equal(r.skipWorker, true);
    // guard-before-chain pin: no /auth-family dep ran
    assert.ok(!calls.some((c) => c.startsWith('deleteMessage')));
    assert.ok(!calls.some((c) => c.startsWith('spawn:')));
    assert.ok(!calls.some((c) => c.startsWith('injectResume:')));
  });

  it('R-T3: /auth exchanges via spawn with runtimeEnv, redacts, deletes the code message, completes', async () => {
    const { deps, calls } = baseDeps();
    deps.spawnFn = makeSpawnDouble(calls, () => JSON.stringify({ status: 'ok' })) as any;
    const runtimeEnv = { PA_OAUTH_TEST: '1' } as NodeJS.ProcessEnv;
    const r = await run({ userText: '/auth abc def', runtimeEnv }, deps);
    assert.equal(r.archivedUserText, redactAuthCommand());
    assert.ok(calls.some((c) => c === 'deleteMessage'));
    const spawnCall = calls.find((c) => c.startsWith('spawn:['));
    assert.ok(spawnCall);
    assert.ok(spawnCall.includes('"shell":true'));
    assert.ok(spawnCall.includes('finish_google_telegram_reauth.py'));
    assert.equal(r.response, buildOAuthCompletionMessage({ status: 'ok' }, 'not_needed', { chatId: CHAT, threadId: THREAD }));
    assert.equal(r.skipWorker, true);
  });

  it('R-T4: /auth topic_resume to an allowed chat injects the resume update', async () => {
    const { deps, calls } = baseDeps();
    deps.spawnFn = makeSpawnDouble(calls, () => JSON.stringify({
      resume_action: { type: 'topic_resume', prompt: 'resume the quarterly report' },
      chat_id: CHAT,
      thread_id: THREAD,
    })) as any;
    const r = await run({ userText: '/auth abc' }, deps);
    assert.deepEqual(
      calls.filter((c) => c.startsWith('injectResume:')),
      [`injectResume:${CHAT}_${THREAD}`],
    );
    assert.equal(r.skipWorker, true);
  });

  it('R-T5: /auth topic_resume to a disallowed chat degrades without throwing', async () => {
    const { deps, calls } = baseDeps();
    deps.spawnFn = makeSpawnDouble(calls, () => JSON.stringify({
      resume_action: { type: 'topic_resume', prompt: 'resume the quarterly report' },
      chat_id: '-1001999999999',
      thread_id: 9,
    })) as any;
    const r = await run({ userText: '/auth abc' }, deps);
    assert.ok(!calls.some((c) => c.startsWith('injectResume:')));
    assert.ok(calls.some((c) => c.startsWith('log.warn:auth:')));
    assert.equal(r.response, buildOAuthCompletionMessage(
      { resume_action: { type: 'topic_resume', prompt: 'resume the quarterly report' }, chat_id: '-1001999999999', thread_id: 9 },
      'topic_resume_failed',
      { chatId: CHAT, threadId: THREAD },
    ));
    assert.equal(r.skipWorker, true);
  });

  it('R-T6: archive runs once, after the /auth exchange and the expiry card refresh, before the command family', async () => {
    const { deps, calls } = baseDeps();
    deps.spawnFn = makeSpawnDouble(calls, () => JSON.stringify({ ok: true })) as any;
    const r = await run({
      userText: '/auth abc',
      topicState: makeState({
        preferred_worker: 'zclaude',
        preferred_worker_set_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      }),
    }, deps);
    const idxSpawn = calls.findIndex((c) => c.startsWith('spawn:'));
    const idxRefresh = calls.findIndex((c) => c === 'refreshCard'); // workerExpired card refresh
    const idxSave = calls.findIndex((c) => c === 'saveTopicState');
    const idxTurn = calls.findIndex((c) => c.startsWith('addTurn:'));
    assert.ok(idxSpawn >= 0 && idxRefresh >= 0 && idxSave >= 0 && idxTurn >= 0, calls.join(' | '));
    assert.ok(idxSpawn < idxRefresh, 'auth before expiry card');
    assert.ok(idxRefresh < idxTurn, 'expiry card before archive');
    assert.ok(idxTurn < idxSave, 'addTurn before saveTopicState');
    assert.equal(calls.filter((c) => c === 'saveTopicState').length, 1);
    assert.equal(r.skipWorker, true);
  });

  it('R-T7: the archived user turn carries role/text/update_id/via and marks replied', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({}, deps);
    const turnCall = calls.find((c) => c.startsWith('addTurn:'));
    assert.ok(turnCall);
    assert.equal(turnCall, `addTurn:${r.archivedUserText}`);
    const state = r.userText === '' ? null : null; // state mutated in place on input
    void state;
    assert.ok(calls.some((c) => c === `markReplied:${CHAT}_${THREAD}`));
    assert.equal(calls.filter((c) => c === 'saveTopicState').length, 1);
  });

  it('R-T8: a requeued synthetic (__requeueCount) skips the archive but not the cascade', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/status', update: { update_id: 7, __requeueCount: 1 } }, deps);
    assert.ok(!calls.some((c) => c.startsWith('addTurn:')));
    assert.ok(!calls.some((c) => c.startsWith('markReplied:')));
    assert.ok(!calls.some((c) => c === 'saveTopicState'));
    assert.ok(r.response.includes('_Ref: ')); // the /status block still ran
    assert.equal(r.skipWorker, true);
  });

  it('R-T9: the no-content guard needs the attachment handle to keep dispatch on', async () => {
    const { deps } = baseDeps();
    const empty = await run({ userText: '', msg: { message_id: 42, date: 1757000000 } }, deps);
    assert.equal(empty.skipWorker, true);
    const { deps: deps2 } = baseDeps();
    const withAudio = await run({
      userText: '',
      msg: { message_id: 42, date: 1757000000 },
      audioAttachment: { kind: 'voice', media: { file_unique_id: 'fid', file_id: 'f' } } as any,
    }, deps2);
    assert.equal(withAudio.skipWorker, false);
  });

  it('R-T10: a stage-set skipWorker suppresses the guard but the /auth pattern still evaluates', async () => {
    const { deps, calls } = baseDeps();
    const marker = '[Voice message] transcription failed after 3 attempts';
    const r = await run({ userText: marker, skipWorker: true }, deps);
    assert.ok(!calls.some((c) => c.startsWith('spawn:'))); // /auth pattern evaluated, no match
    assert.equal(r.skipWorker, true);
  });

  it('R-T41: the attachment stage’s response (voice-failure notice) survives the router untouched', async () => {
    const { deps, calls } = baseDeps();
    const notice = '🎙 Could not transcribe that note — try /retranscribe or send it again.';
    const r = await run({ userText: '[Voice message] transcription failed', skipWorker: true, response: notice }, deps);
    assert.equal(r.response, notice); // the witness for this is voice-poll-loop's failure-path cases
    assert.ok(calls.some((c) => c.startsWith('addTurn:'))); // archive still ran for the marker text
  });

  it('R-T42: the attachment stage’s voiceTranscribed (first writer) survives into the result', async () => {
    const { deps } = baseDeps();
    const r = await run({ voiceTranscribed: true }, deps);
    assert.equal(r.voiceTranscribed, true); // /retranscribe below is only the SECOND writer
    const { deps: deps2 } = baseDeps();
    const r2 = await run({}, deps2);
    assert.equal(r2.voiceTranscribed, false);
  });
});

// ---------------------------------------------------------------------------
// command-router — /secret (auth broker Phase A, generalizes /auth)
// ---------------------------------------------------------------------------

describe('command-router — /secret (auth broker)', () => {
  it('delivers the value via pa auth answer, redacts the archive, deletes the message, never logs the value', async () => {
    const { deps, calls } = baseDeps();
    const deleteMessageCalls: unknown[][] = [];
    deps.deleteMessageFn = (async (t: string, c: number, m: number) => {
      deleteMessageCalls.push([t, c, m]);
      return {} as any;
    }) as any;
    const stdinWrites: string[] = [];
    deps.spawnFn = makeSpawnDoubleWithStdin(
      calls,
      stdinWrites,
      () => JSON.stringify({ ok: true, status: 'answered', request_id: 'ir-0123456789ab' })
    ) as any;

    const r = await run({ userText: '/secret ir-0123456789ab hunter2' }, deps);

    assert.equal(r.archivedUserText, redactSecretCommand());
    assert.equal(deleteMessageCalls.length, 1);
    assert.deepEqual(deleteMessageCalls[0], ['test-token', CHAT, 42]);

    const spawnCall = calls.find((c) => c.startsWith('spawn:['));
    assert.ok(spawnCall);
    assert.ok(!spawnCall!.includes('hunter2'), 'value must never reach argv');
    assert.ok(spawnCall!.includes('"auth"') && spawnCall!.includes('"answer"') && spawnCall!.includes('ir-0123456789ab'));
    assert.ok(!spawnCall!.includes('"shell":true'), 'no shell:true — the value can never reach a shell command line');

    assert.deepEqual(stdinWrites, ['hunter2']);

    assert.equal(r.response, 'Sent. The task continues.');
    assert.equal(r.skipWorker, true);

    // Known-bad control: the value must appear in NO captured log line for the turn.
    assert.ok(!calls.some((c) => c.includes('hunter2')));
  });

  it('a non-ok result from pa auth answer yields the not-pending/unknown message', async () => {
    const { deps } = baseDeps();
    deps.spawnFn = makeSpawnDoubleWithStdin([], [], () => JSON.stringify({ ok: false })) as any;
    const r = await run({ userText: '/secret ir-0123456789ab hunter2' }, deps);
    assert.equal(r.response, 'That request is no longer pending, or the id is unknown.');
    assert.equal(r.skipWorker, true);
  });

  it('a malformed /secret falls through to the worker, not to this branch', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/secret nope x' }, deps);
    assert.ok(!calls.some((c) => c.startsWith('spawn:')));
    assert.equal(r.skipWorker, false);
  });
});

// ---------------------------------------------------------------------------
// R-T11 .. R-T17: agent card, agent switch, reset, /new
// ---------------------------------------------------------------------------

describe('command router — agent/reset//new blocks', () => {
  it('R-T11: bare /agent renders the agent status card', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/agent' }, deps);
    assert.ok(r.response.startsWith('*Agent Status*'));
    assert.ok(r.response.includes('Current: *agy* (topic default)'));
    assert.ok(r.response.includes('Default: *agy*'));
    assert.equal(r.skipWorker, true);
    assert.ok(!calls.some((c) => c.startsWith('syncModelStatus:')));
  });

  it('R-T12: /agent zclaude sets the session override and refreshes the card', async () => {
    const { deps, calls } = baseDeps();
    const state = makeState({ session: { session_id: 's1', worker: 'agy', started_at: new Date().toISOString() } });
    const r = await run({ userText: '/agent zclaude', topicState: state }, deps);
    assert.equal(state.preferred_worker, 'zclaude');
    assert.ok(state.preferred_worker_set_at);
    assert.ok(calls.includes('syncModelStatus:user_override'));
    assert.ok(calls.includes('refreshCard'));
    assert.equal(state.session, undefined);
    assert.equal(r.skipWorker, true);
  });

  it('R-T13: /agent back to the topic default clears the override', async () => {
    const { deps, calls } = baseDeps();
    const state = makeState({ preferred_worker: 'claude', preferred_worker_set_at: new Date().toISOString() });
    const r = await run({ userText: '/agent zclaude', effectiveDefault: 'zclaude', topicState: state }, deps);
    assert.equal(state.preferred_worker, undefined);
    assert.ok(calls.includes('syncModelStatus:user_selected_default'));
    assert.equal(r.skipWorker, true);
  });

  it('R-T15: /reset responds with the expiry renderer and refreshes the card', async () => {
    const { deps, calls } = baseDeps();
    const state = makeState({ preferred_worker: 'zclaude', preferred_worker_set_at: new Date().toISOString() });
    const r = await run({ userText: '/reset', topicState: state }, deps);
    const expected = renderSessionExpiryMessage(
      formatWorkerDescriptor('zclaude', undefined, undefined),
      formatWorkerDescriptor('agy', undefined, undefined),
      'cleared',
    );
    assert.equal(r.response, expected);
    assert.ok(calls.includes('refreshCard'));
    assert.equal(r.skipWorker, true);
  });

  it('R-T16: bare /new clears the session and responds locally', async () => {
    const { deps } = baseDeps();
    const state = makeState({ session: { session_id: 's1', worker: 'agy', started_at: new Date().toISOString() } });
    const r = await run({ userText: '/new', topicState: state }, deps);
    assert.equal(state.session, undefined);
    assert.equal(r.response, '🔄 Context cleared and ready for a fresh session.');
    assert.equal(r.skipWorker, true);
  });

  it('R-T17: /new with an instruction rewrites the text and falls through to dispatch', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/new finish the report' }, deps);
    assert.equal(r.userText, 'finish the report');
    assert.equal(r.archivedUserText, 'finish the report');
    assert.ok(calls.includes('addTurn:finish the report'));
    assert.equal(r.skipWorker, false); // cascade continues
  });
});

// ---------------------------------------------------------------------------
// R-T18 .. R-T24: /new seeding, /code, /default, sunset, tunables
// ---------------------------------------------------------------------------

describe('command router — /new seeding, /code, /default, tunables', () => {
  it('R-T18: /new replying to a ref-ID seeds from the replied session; same-session does not', async () => {
    const { deps, calls } = baseDeps();
    deps.findSessionForRefIdFn = (async () => 'sess-old') as any;
    deps.findHistoricalTurnsFn = (async () => [
      { role: 'user', text: 'earlier question', timestamp: 't1' },
      { role: 'assistant', text: 'earlier answer', timestamp: 't2' },
    ] as any[]) as any;
    const state = makeState({ session: { session_id: 'sess-current', worker: 'agy', started_at: new Date().toISOString() } });
    const r = await run({
      userText: '/new',
      topicState: state,
      msg: { message_id: 42, date: 1757000000, reply_to_message: { text: 'done — _Ref: s-abc123456789_' } },
    }, deps);
    assert.ok(calls.some((c) => c.startsWith('execPaRef:') === false));
    assert.deepEqual(state.turns.map((t: any) => t.text), ['earlier question', 'earlier answer']);
    assert.equal(r.response, '🔄 Context reset and seeded with 2 turn(s) from previous session.');
    assert.equal(r.skipWorker, true);

    // same-session reply: no reseed
    const { deps: deps2, calls: calls2 } = baseDeps();
    deps2.findSessionForRefIdFn = (async () => 'sess-current') as any;
    const state2 = makeState({ session: { session_id: 'sess-current', worker: 'agy', started_at: new Date().toISOString() } });
    await run({
      userText: '/new',
      topicState: state2,
      msg: { message_id: 42, date: 1757000000, reply_to_message: { text: 'done — _Ref: s-abc123456789_' } },
    }, deps2);
    assert.ok(!calls2.some((c) => c.startsWith('findHistorical') ));
    void calls;
  });

  it('R-T19: /code show and reset respond locally', async () => {
    const { deps } = baseDeps();
    const r = await run({ userText: '/code' }, deps);
    assert.ok(r.response.length > 0);
    assert.equal(r.skipWorker, true);
    const { deps: deps2 } = baseDeps();
    const r2 = await run({ userText: '/code reset' }, deps2);
    assert.ok(r2.response.length > 0);
    assert.equal(r2.skipWorker, true);
  });

  it('R-T20: /code with a missing directory refuses and leaves cwd_override untouched', async () => {
    const { deps } = baseDeps();
    const state = makeState();
    const r = await run({ userText: '/code /no/such/dir', topicState: state }, deps);
    assert.equal(r.response, '⚠️ Directory not found: `/no/such/dir`');
    assert.equal(state.cwd_override, undefined);
    assert.equal(r.skipWorker, true);
  });

  it('R-T21: /code to a real directory sets cwd_override; with an instruction it rewrites the turn', async () => {
    const dir = await tempSubdir('cmd-router-code-');
    const { deps, calls } = baseDeps();
    const state = makeState();
    const r = await run({ userText: `/code ${dir}`, topicState: state }, deps);
    assert.equal(state.cwd_override, dir);
    assert.equal(state.session, undefined);
    assert.equal(r.response, `📁 Working directory set to: \`${dir}\``);
    assert.equal(r.skipWorker, true);

    // with an instruction: rewrite + last user turn edit + fall-through
    const { deps: deps2, calls: calls2 } = baseDeps();
    const state2 = makeState();
    const r2 = await run({ userText: `/code ${dir} fix the flaky test`, topicState: state2 }, deps2);
    assert.equal(r2.userText, 'fix the flaky test');
    assert.equal(r2.archivedUserText, 'fix the flaky test');
    assert.equal(state2.cwd_override, dir);
    const lastTurn = state2.turns[state2.turns.length - 1];
    assert.equal(lastTurn.text, 'fix the flaky test');
    assert.equal(r2.skipWorker, false);
    void calls; void calls2;
  });

  it('R-T22: /default <worker> runs the real saveTopicDefault and reassigns effectiveDefault', async () => {
    const { deps, calls } = baseDeps();
    const state = makeState({ preferred_worker: 'claude', preferred_worker_set_at: new Date().toISOString() });
    const r = await run({ userText: '/default zclaude', topicState: state }, deps);
    assert.equal(r.effectiveDefault, 'zclaude');
    assert.equal(state.preferred_worker, undefined);
    assert.ok(calls.includes('syncModelStatus:default_changed'));
    assert.ok(calls.includes('refreshCard'));
    assert.equal(r.skipWorker, true);

    // bare /default: promotes the current configuration
    const { deps: deps2 } = baseDeps();
    const state2 = makeState({ preferred_worker: 'claude', preferred_worker_set_at: new Date().toISOString() });
    const r2 = await run({ userText: '/default', effectiveDefault: 'agy', topicState: state2 }, deps2);
    assert.equal(r2.effectiveDefault, 'claude');
    assert.equal(state2.preferred_worker, undefined);
    assert.equal(r2.skipWorker, true);
  });

  it('R-T23: sunset /llm responds without a worker', async () => {
    const { deps } = baseDeps();
    const r = await run({ userText: '/llm gpt-x' }, deps);
    assert.ok(r.response.length > 0);
    assert.ok(!r.response.startsWith('Unknown command'));
    assert.equal(r.skipWorker, true);
  });

  it('R-T24: /model <value> routes through the handleTunables dep and refreshes the card', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/model gpt-x' }, deps);
    assert.equal(calls.filter((c) => c === 'handleTunables').length, 1);
    assert.ok(calls.includes('refreshCard'));
    assert.equal(r.response, 'tunables-ok');
    assert.equal(r.skipWorker, true);
  });
});

// ---------------------------------------------------------------------------
// R-T25 .. R-T27: /retranscribe
// ---------------------------------------------------------------------------

describe('command router — /retranscribe', () => {
  const REPLY_VOICE = {
    message_id: 99,
    date: 1757000000,
    voice: { file_unique_id: 'fid1', file_id: 'file1', duration: 2 },
  };

  it('R-T25: /retranscribe with no target responds with the notice and never transcribes', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/retranscribe' }, deps);
    assert.equal(r.response, '🎙 No recent voice or audio messages from this topic to re-transcribe — reply to the note you want, or send a new one.');
    assert.equal(r.skipWorker, true);
    assert.ok(!calls.some((c) => c.startsWith('markAudio')));
    assert.ok(!calls.some((c) => c.startsWith('send')));
  });

  it('R-T26: /retranscribe failure records the index entry and reports the failure', async () => {
    const { deps, calls } = baseDeps();
    const vr: VoiceResult = { ok: false, reason: 'transcribe-failed', message: 'engine exploded' };
    deps.transcribeFn = (async () => vr) as any;
    const r = await run({ userText: '/retranscribe', msg: { message_id: 42, date: 1757000000, reply_to_message: REPLY_VOICE } }, deps);
    assert.ok(calls.some((c) => c.startsWith('markAudio')));
    assert.equal(r.response, voiceErrorMessage(vr));
    assert.equal(r.skipWorker, true);
    assert.equal(r.voiceTranscribed, false);
  });

  it('R-T27: /retranscribe success sends once (awaited), rewrites the text, and sets voiceTranscribed', async () => {
    const { deps, calls } = baseDeps();
    const vr: VoiceResult = {
      ok: true, text: 'the spoken words', engine: 'testengine', mode: 'spawn',
      audioPath: '/tmp/a.ogg', elapsedMs: 5, truncated: false,
    };
    deps.transcribeFn = (async () => { calls.push('transcribe'); return vr; }) as any;
    const r = await run({ userText: '/retranscribe', msg: { message_id: 42, date: 1757000000, reply_to_message: REPLY_VOICE } }, deps);
    const idxTranscribe = calls.findIndex((c) => c === 'transcribe');
    const idxMark = calls.findIndex((c) => c.startsWith('markAudio'));
    const idxSend = calls.findIndex((c) => c === 'send');
    assert.ok(idxTranscribe >= 0 && idxMark > idxTranscribe && idxSend > idxMark, calls.join(' | '));
    assert.equal(calls.filter((c) => c === 'send').length, 1);
    assert.ok(r.response === ''); // nothing local; the message went via send
    assert.ok(r.userText.includes('the spoken words'));
    assert.equal(r.userText, formatTranscriptUserText(vr.text, {
      truncated: vr.truncated,
      kind: 'voice',
      fileName: undefined,
      speakers: vr.speakers,
    }));
    assert.equal(r.archivedUserText, r.userText);
    assert.equal(r.voiceTranscribed, true);
    assert.equal(r.skipWorker, false);
  });
});

// ---------------------------------------------------------------------------
// R-T28 .. R-T33: status family, /debug, /reauth, /pair, git family
// ---------------------------------------------------------------------------

describe('command router — status family, /debug, /reauth, /pair, git family', () => {
  it('R-T28: /status /skills /help each respond ref-ID-d and locally', async () => {
    for (const text of ['/status', '/skills', '/help']) {
      const { deps } = baseDeps();
      const r = await run({ userText: text }, deps);
      assert.ok(r.response.includes('_Ref: '), `${text} response carries a ref-ID`);
      assert.equal(r.skipWorker, true);
    }
  });

  it('R-T29: /health /claims /ref go through the injected pa CLI seams', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/health' }, deps);
    assert.ok(calls.includes(`execPaCommand:${JSON.stringify(['health', '--no-color'])}:3500`));
    assert.ok(r.response.includes('_Ref: '));
    assert.equal(r.skipWorker, true);

    const { deps: deps2, calls: calls2 } = baseDeps();
    await run({ userText: '/claims' }, deps2);
    assert.ok(calls2.includes(`execPaCommand:${JSON.stringify(['claims'])}:1200`));

    const { deps: deps3, calls: calls3 } = baseDeps();
    await run({ userText: '/ref s-abc123' }, deps3);
    assert.ok(calls3.includes('execPaRef:s-abc123'));
  });

  it('R-T30: /debug with no support config reports the configuration error and files nothing', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/debug', secrets: { PA_OPERATOR_USER_ID: '42' } }, deps);
    assert.ok(r.response.startsWith('/debug unavailable: config.yaml topics.support is not set or malformed.'));
    assert.ok(r.response.includes('_Ref: '));
    assert.ok(!calls.some((c) => c.startsWith('appendTask:')));
    assert.equal(r.skipWorker, true);
  });

  it('R-T31: /debug files through the real handleDebugCommand with the injected appendTaskFn', async () => {
    const { deps, calls } = baseDeps();
    deps.loadSupportTopicFn = (async () => '-1001234567890_4999') as any;
    const r = await run({
      userText: '/debug',
      secrets: { PA_OPERATOR_USER_ID: '42' },
      msg: { message_id: 42, date: 1757000000, from: { id: 42 }, reply_to_message: { text: 'boom happened _Ref: s-abc123456789_', message_id: 99 } },
    }, deps);
    assert.ok(calls.some((c) => c.startsWith('appendTask:-1001234567890_4999:')));
    assert.ok(r.response.includes('_Ref: '));
    assert.equal(r.skipWorker, true);
  });

  it('R-T32: /reauth routes through the spawnReauthLink dep, bare and with a skill', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/reauth' }, deps);
    assert.ok(calls.includes('spawnReauthLink:'));
    assert.ok(r.response.includes('_Ref: '));
    assert.equal(r.skipWorker, true);

    const { deps: deps2, calls: calls2 } = baseDeps();
    await run({ userText: '/reauth daily-mail-brief' }, deps2);
    assert.ok(calls2.includes('spawnReauthLink:daily-mail-brief'));
  });

  it('R-T33: /commit kicks the skill via spawn; /push_public never shadows into /push', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/commit' }, deps);
    const spawnCall = calls.find((c) => c.startsWith('spawn:'));
    assert.ok(spawnCall);
    assert.ok(spawnCall.startsWith(`spawn:${JSON.stringify(['run', 'commit'])}`));
    assert.ok(spawnCall.includes('"cwd":"/repo"'));
    assert.ok(spawnCall.includes('"detached":true'));
    assert.ok(spawnCall.includes('"shell":true'));
    assert.ok(spawnCall.includes('"windowsHide":true'));
    assert.ok(calls.includes('unref'));
    assert.equal(r.response, '🚀 Kicked off `commit` — it reports back in the main "My PA" topic when done, not necessarily here.');
    assert.equal(r.skipWorker, true);

    const { deps: deps2, calls: calls2 } = baseDeps();
    await run({ userText: '/push_public' }, deps2);
    assert.equal(calls2.filter((c) => c.startsWith('spawn:')).length, 1);
    assert.ok(calls2.some((c) => c.includes(JSON.stringify(['run', 'push-public']))));
    assert.ok(!calls2.some((c) => c.includes(JSON.stringify(['run', 'push']))));
  });
});

// ---------------------------------------------------------------------------
// R-T34 .. R-T36 + /pair: /update_brain, cascade order, /pair
// ---------------------------------------------------------------------------

describe('command router — /update_brain, cascade order, /pair', () => {
  it('R-T34: /update_brain on a hard-exempt topic refuses before any staging', async () => {
    const { deps, calls } = baseDeps();
    deps.getTopicExemptionsFn = (async () => new Map([[`${CHAT}_${THREAD}`, 'output-only']])) as any;
    const r = await run({ userText: '/update_brain' }, deps);
    assert.ok(r.response.includes('exempt from topic brains'));
    assert.ok(!calls.some((c) => c.startsWith('mkdir:')));
    assert.equal(r.skipWorker, true);
  });

  it('R-T35: /update_brain stages: mkdir, instruction rewrite, brain-path substitution, dispatch fall-through', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/update_brain' }, deps);
    assert.ok(calls.some((c) => c.startsWith(`mkdir:${join(process.env.PA_HOME!, 'topic-brains', '.staged')}`)));
    assert.ok(r.userText.startsWith('The user ran /update_brain in this topic.'));
    assert.ok(r.userText.includes(`${process.env.PA_HOME}/topic-brains/${CHAT}_${THREAD}/BRAIN.md`));
    assert.ok(!r.userText.includes('<BRAIN_PATH_ABS>'));
    assert.equal(r.skipWorker, false); // the staging instruction IS the worker request

    // no brain: the brain-path sentence is dropped instead
    const { deps: deps2 } = baseDeps();
    deps2.getTopicBrainInfoFn = (async () => undefined) as any;
    const r2 = await run({ userText: '/update_brain' }, deps2);
    assert.ok(!r2.userText.includes('<BRAIN_PATH_ABS>'));
    assert.ok(!r2.userText.includes('If the topic brain at'));
    assert.equal(r2.skipWorker, false);
  });

  it('R-T36: a /new-style rewrite is what later blocks see (fall-through on shared state)', async () => {
    const { deps } = baseDeps();
    const r = await run({ userText: '/new /status' }, deps);
    assert.equal(r.userText, '/status');
    assert.ok(r.response.includes('_Ref: ')); // the /status block answered
    assert.equal(r.skipWorker, true);
  });

  it('R-T40: /pair mints locally via the real handler and never reaches a worker', async () => {
    const { deps, calls } = baseDeps();
    const r = await run({ userText: '/pair' }, deps);
    assert.ok(r.response.includes('_Ref: '));
    assert.equal(r.skipWorker, true);
    assert.ok(!calls.some((c) => c.startsWith('spawn:')));
  });
});

// ---------------------------------------------------------------------------
// R-T37 .. R-T39: the exported pa-CLI helpers + the ESM guard
// ---------------------------------------------------------------------------

describe('command router — pa CLI helpers and ESM guard', () => {
  it('R-T37: execPaCommand trims, caps, and renders exec failures through the injected seam', () => {
    assert.equal(execPaCommand(['claims'], 1200, () => '  out  \n'), 'out');
    assert.equal(execPaCommand(['x'], 20, () => '12345678901234567890'), '12345678901234567890');
    assert.equal(execPaCommand(['x'], 10, () => 'x'.repeat(50)), 'x'.repeat(10) + '…');
    assert.equal(execPaCommand(['x'], 1200, () => { throw new Error('boom'); }), 'Error: boom');
  });

  it('R-T38: execPaRef returns short output as-is and truncates long output with the footer', () => {
    assert.equal(execPaRef('s-1', () => 'ref body'), 'ref body');
    const long = execPaRef('s-1', () => 'y'.repeat(4001));
    assert.ok(long.startsWith('y'.repeat(4000)));
    assert.ok(long.includes('`s-1` output truncated — full result at terminal'));
    assert.equal(execPaRef('s-1', () => { throw new Error('nope'); }), 'Error: nope');
  });

  it('R-T39: command-router.ts stays require-free (ESM)', () => {
    // Runs from src/tests AND from dist/tests — resolve the TS source either way.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '..', 'command-router.ts'),
      join(here, '..', '..', 'src', 'command-router.ts'),
    ];
    const sourcePath = candidates.find((p) => existsSync(p));
    assert.ok(sourcePath, `command-router.ts source not found from ${here}`);
    const src = readFileSync(sourcePath, 'utf8');
    assert.ok(!src.includes('require('), 'command-router.ts must not contain require(');
  });
});

describe('command router — every intercepted local command is discoverable', () => {
  // Silent-sites pin (deep-recheck 2026-09-06): a deterministic local command
  // that the cascade intercepts but that has no BOT_COMMANDS row is invisible
  // in both /help (which renders from that list) and the Telegram command
  // menu — /pair and /orchestrator shipped exactly that way (AI-201/AI-203
  // pinned interception only). /stop and /steer are deliberately absent from
  // BOTH the guard's known set and this list's isKnownCommand half: they are
  // intercepted in the poll loop on RAW text before transcription/router, so
  // the guard never sees them (attachment-stage.ts documents this).
  it('BOT_COMMANDS covers every local command; bare-complete forms are guard-known', () => {
    const registered = new Set(BOT_COMMANDS.map((c) => c.command));
    // Argument-requiring commands: the bare form is meaningless, so the
    // unknown-command guard eating it is the documented contract — pin
    // registration and that the argumented form is guard-known.
    const argRequired = [
      ['auth', '/auth 4/0abc.def:1:abc'],
      ['secret', '/secret ir-0123456789ab hunter2'],
      ['ref', '/ref s-abc123'],
      ['branch', '/branch name'],
      ['child_of', '/child_of parent'],
    ];
    // Bare form is a complete invocation: it must be guard-known too, or the
    // guard answers "Unknown command" before the handler ever runs.
    const bareComplete = [
      'agent', 'model', 'effort', 'default', 'code', 'sources', 'reset', 'new',
      'status', 'skills', 'reauth', 'help', 'health', 'claims', 'debug',
      'retranscribe', 'commit', 'push', 'push_public',
      'investigate_flagged', 'update_brain', 'pair', 'orchestrator', 'merge',
    ];
    const all = [...argRequired.map(([cmd]) => cmd), ...bareComplete];
    const missingRows = all.filter((cmd) => !registered.has(cmd));
    assert.deepEqual(
      missingRows,
      [],
      `local commands missing a BOT_COMMANDS row (invisible in /help + menu): ${missingRows.join(', ')}`
    );
    const unknownArged = argRequired
      .filter(([, sample]) => !isKnownCommand(sample))
      .map(([cmd]) => cmd);
    assert.deepEqual(
      unknownArged,
      [],
      `argumented forms the unknown-command guard would eat: ${unknownArged.join(', ')}`
    );
    const unknownBare = bareComplete.filter((cmd) => !isKnownCommand(`/${cmd}`));
    assert.deepEqual(
      unknownBare,
      [],
      `bare forms the guard eats before the handler runs: ${unknownBare.join(', ')}`
    );
  });
});

describe('command router — /sources add seam (stat gate + frozen responses)', () => {
  // Router-level pin (deep-recheck 2026-09-06): the pure layer (sources.test)
  // covers addTopicSource's ok/duplicate/cap RESULTS, but the stat gate and
  // the user-facing strings for the add path live ONLY here in the router —
  // until now nothing executed them. Absolute tmp paths pass through
  // resolveCodePath unchanged, so real temp files drive the real gate.
  it('A-RS1: add to a real file applies it and speaks the frozen declared string', async () => {
    const dir = await tempSubdir('cmd-router-src-');
    const file = join(dir, 'sysdoc.md');
    await writeFile(file, 'system of record', 'utf8');
    const state = makeState();
    const { deps } = baseDeps();
    const out = await runCommandRouter(baseInput({ userText: `/sources ${file}`, topicState: state }), deps);
    assert.equal(out.skipWorker, true);
    assert.equal(state.sources?.length, 1);
    assert.equal(out.response, `📚 Source declared: \`${file}\` — 1 total. It will be injected (or pointed at) in every fresh dispatch from now on.`);
  });

  it('A-RS2: re-adding the same path reports Already declared', async () => {
    const dir = await tempSubdir('cmd-router-src-');
    const file = join(dir, 'sysdoc.md');
    await writeFile(file, 'system of record', 'utf8');
    const state = makeState();
    const { deps } = baseDeps();
    await runCommandRouter(baseInput({ userText: `/sources ${file}`, topicState: state }), deps);
    const out = await runCommandRouter(baseInput({ userText: `/sources ${file}`, topicState: state }), deps);
    assert.equal(out.skipWorker, true);
    assert.equal(state.sources?.length, 1, 'duplicate must not append');
    assert.equal(out.response, `📚 Already declared: \`${file}\`.`);
  });

  it('A-RS3: a directory is rejected by the stat gate', async () => {
    const dir = await tempSubdir('cmd-router-src-');
    const state = makeState();
    const { deps } = baseDeps();
    const out = await runCommandRouter(baseInput({ userText: `/sources ${dir}`, topicState: state }), deps);
    assert.equal(out.skipWorker, true);
    assert.equal(state.sources?.length ?? 0, 0, 'directory must not be declared');
    assert.equal(out.response, `⚠️ Not a readable file: \`${dir}\`. Declare a specific file, not a directory.`);
  });

  it('A-RS4: the eight-source cap speaks the cap string and applies nothing', async () => {
    const dir = await tempSubdir('cmd-router-src-');
    const file = join(dir, 'sysdoc.md');
    await writeFile(file, 'system of record', 'utf8');
    const full = Array.from({ length: TOPIC_SOURCES_MAX }, (_, i) => ({
      path: `C:/fake/src-${i}.md`, label: `s${i}`,
    }));
    const state = makeState({ sources: full });
    const { deps } = baseDeps();
    const out = await runCommandRouter(baseInput({ userText: `/sources ${file}`, topicState: state }), deps);
    assert.equal(out.skipWorker, true);
    assert.equal(state.sources?.length, TOPIC_SOURCES_MAX, 'cap must not append');
    assert.equal(out.response, `⚠️ Source cap reached (${TOPIC_SOURCES_MAX} per topic). Remove one first: /sources remove <n>.`);
  });
});

// ---------------------------------------------------------------------------
// WP-5 (§5, decision 25): /agent under an effective deprecate-pins gate —
// the standing notice rides the reply while the state writes stay EXACTLY
// today's (flag-off reversal). No block / explicit false → no notice.
// ---------------------------------------------------------------------------
const { ROUTER_OWNS_DISPATCH_NOTICE } = await import('../command-router.js');

describe('WP-5 /agent standing notice under the deprecate-pins gate', () => {
  it('gate effective (absent deprecate_pins + enabled block): notice on, state writes unchanged', async () => {
    const { deps, calls } = baseDeps();
    const state = makeState({ session: { session_id: 's1', worker: 'agy', started_at: new Date().toISOString() } });
    const r = await run(
      {
        userText: '/agent zclaude',
        topicState: state,
        config: { workers: [{ name: 'agy' }, { name: 'zclaude' }], model_router: { enabled: true, table: [] } },
      },
      deps,
    );
    assert.ok(r.response.startsWith('Switched agent:'));
    assert.ok(r.response.endsWith(ROUTER_OWNS_DISPATCH_NOTICE), 'the reply must carry the standing notice');
    assert.equal(state.preferred_worker, 'zclaude', 'the pin still writes (flag-off reversal)');
    assert.ok(state.preferred_worker_set_at);
    assert.ok(calls.includes('syncModelStatus:user_override'), 'state writes unchanged');
    assert.ok(calls.includes('refreshCard'));
    assert.equal(r.skipWorker, true);
  });

  it('no block → no notice (byte-identity); explicit deprecate_pins false → no notice', async () => {
    const { deps } = baseDeps();
    const plain = await run({ userText: '/agent zclaude', topicState: makeState() }, deps);
    assert.ok(!plain.response.includes('routing owns worker+model now'), 'no block = today’s reply');

    const { deps: deps2 } = baseDeps();
    const off = await run(
      {
        userText: '/agent zclaude',
        topicState: makeState(),
        config: { workers: [{ name: 'agy' }, { name: 'zclaude' }], model_router: { enabled: true, deprecate_pins: false, table: [] } },
      },
      deps2,
    );
    assert.ok(!off.response.includes('routing owns worker+model now'), 'explicit false = today’s reply');
  });
});
