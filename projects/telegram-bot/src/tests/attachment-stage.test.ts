/**
 * attachment-stage.test.ts — AI-173 phase 1 (2026-09-01).
 *
 * Pure unit tests against runAttachmentStage with fully injected deps. No
 * runPollLoop involved, so no _setExitForTest needed.
 * Spec: plans/2026-09-01-ai173-phase1-attachment-stage-SPEC.md §6.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { waitForDrain } from './test-teardown-guard.js';
import { runAttachmentStage, matchVoiceCommand, liveRegisteredVoiceCommands } from '../attachment-stage.js';
import type { AttachmentStageInput, AttachmentStageDeps, VoiceCommandMatch } from '../attachment-stage.js';
import { guardUnknownCommand } from '../logic.js';
import { voiceErrorMessage, formatFailedTranscriptUserText } from '../voice.js';
import type { VoiceResult } from '../voice.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'attachment-stage-'));
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  await waitForDrain();
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

const CHAT_ID = -1001234;
const THREAD_ID = 7;
const MESSAGE_ID = 42;
const TOKEN = 'test-token';

function baseInput(overrides: Partial<AttachmentStageInput> = {}): AttachmentStageInput {
  return {
    msg: {},
    update: {},
    userText: '',
    token: TOKEN,
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    repoRoot: '/repo',
    runtimeEnv: {} as NodeJS.ProcessEnv,
    transcription: undefined,
    ...overrides,
  };
}

interface Harness {
  deps: AttachmentStageDeps;
  calls: string[];
  transcribeArgs: any[];
  sent: Array<{ token: string; chatId: number; text: string; replyToMessageId?: number; threadId?: number }>;
  markAudioArgs: any[];
  recordAudioArgs: any[];
  infoLogs: Array<{ module: string; message: string; context?: Record<string, unknown> }>;
  warnLogs: Array<{ module: string; message: string; context?: Record<string, unknown> }>;
  madeDirs: string[];
  downloadArgs: Array<{ token: string; fileId: string; destPath: string }>;
}

function okResult(overrides: Partial<Extract<VoiceResult, { ok: true }>> = {}): VoiceResult {
  return {
    ok: true,
    text: 'hello there',
    engine: 'whisper_local',
    mode: 'spawn',
    audioPath: '/tmp/audio.oga',
    elapsedMs: 100,
    truncated: false,
    ...overrides,
  };
}

function failResult(overrides: Partial<Extract<VoiceResult, { ok: false }>> = {}): VoiceResult {
  return {
    ok: false,
    reason: 'transcribe-failed',
    message: 'boom',
    audioPath: '/tmp/audio.oga',
    ...overrides,
  };
}

function makeHarness(opts: {
  transcribeResult?: VoiceResult;
  transcribeShouldBeCalled?: boolean;
  recordAudioBehavior?: 'resolve' | 'reject';
  markAudioBehavior?: 'resolve' | 'reject';
  sendBehavior?: 'resolve' | 'reject';
  downloadBehavior?: 'true' | 'false' | 'throw';
  now?: Date;
} = {}): Harness {
  const calls: string[] = [];
  const transcribeArgs: any[] = [];
  const sent: Harness['sent'] = [];
  const markAudioArgs: any[] = [];
  const recordAudioArgs: any[] = [];
  const infoLogs: Harness['infoLogs'] = [];
  const warnLogs: Harness['warnLogs'] = [];
  const madeDirs: string[] = [];
  const downloadArgs: Harness['downloadArgs'] = [];

  const deps: AttachmentStageDeps = {
    transcribe: (async (...args: any[]) => {
      calls.push('transcribe');
      transcribeArgs.push(args);
      if (!opts.transcribeResult) throw new Error('transcribe should not have been called in this test');
      return opts.transcribeResult;
    }) as AttachmentStageDeps['transcribe'],
    recordAudio: (async (...args: any[]) => {
      calls.push('recordAudio');
      recordAudioArgs.push(args);
      if (opts.recordAudioBehavior === 'reject') throw new Error('recordAudio failed');
    }) as AttachmentStageDeps['recordAudio'],
    markAudio: (async (...args: any[]) => {
      calls.push('markAudio');
      markAudioArgs.push(args);
      if (opts.markAudioBehavior === 'reject') throw new Error('markAudio failed');
    }) as AttachmentStageDeps['markAudio'],
    audioRoot: () => '/fake-audio-root',
    sendMessageFn: (async (token: string, chatId: number, text: string, replyToMessageId?: number, threadId?: number) => {
      calls.push('send');
      sent.push({ token, chatId, text, replyToMessageId, threadId });
      if (opts.sendBehavior === 'reject') throw new Error('send failed');
      return true;
    }) as AttachmentStageDeps['sendMessageFn'],
    downloadFileFn: (async (token: string, fileId: string, destPath: string) => {
      calls.push('download');
      downloadArgs.push({ token, fileId, destPath });
      if (opts.downloadBehavior === 'throw') throw new Error('download exploded');
      return opts.downloadBehavior !== 'false';
    }) as AttachmentStageDeps['downloadFileFn'],
    makeDir: (dir: string) => {
      calls.push('makeDir');
      madeDirs.push(dir);
    },
    now: () => opts.now ?? new Date('2026-09-01T12:00:00.000Z'),
    log: {
      info: (module: string, message: string, context?: Record<string, unknown>) => infoLogs.push({ module, message, context }),
      warn: (module: string, message: string, context?: Record<string, unknown>) => warnLogs.push({ module, message, context }),
    },
  };

  return { deps, calls, transcribeArgs, sent, markAudioArgs, recordAudioArgs, infoLogs, warnLogs, madeDirs, downloadArgs };
}

describe('runAttachmentStage', () => {
  it('A-T1: plain text, no attachment', async () => {
    const h = makeHarness();
    const result = await runAttachmentStage(baseInput({ userText: 'plain text' }), h.deps);
    assert.deepEqual(result, {
      userText: 'plain text',
      voiceTranscribed: false,
      response: '',
      skipWorker: false,
      audioAttachment: undefined,
    });
    assert.ok(!h.calls.includes('transcribe'));
    assert.ok(!h.calls.includes('recordAudio'));
    assert.ok(!h.calls.includes('download'));
  });

  it('A-T2: __skipVoice with a voice attachment', async () => {
    const h = makeHarness();
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    const result = await runAttachmentStage(
      baseInput({ msg: { voice: media }, update: { __skipVoice: true }, userText: '/some command' }),
      h.deps,
    );
    assert.ok(!h.calls.includes('transcribe'));
    assert.ok(!h.calls.includes('recordAudio'));
    assert.equal(result.userText, '/some command');
    assert.deepEqual(result.audioAttachment, { kind: 'voice', media });
  });

  it('A-T3: voice success, no prefetch', async () => {
    const vr = okResult({ text: 'hello there' });
    const h = makeHarness({ transcribeResult: vr });
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    const result = await runAttachmentStage(
      baseInput({ msg: { voice: media }, userText: '', runtimeEnv: { FOO: 'bar' } as NodeJS.ProcessEnv, transcription: { engine: 'auto' } as any }),
      h.deps,
    );
    assert.deepEqual(h.calls.filter((c) => ['recordAudio', 'transcribe', 'markAudio'].includes(c)), ['recordAudio', 'transcribe', 'markAudio']);
    const [token, chatId, passedMedia, voiceDeps, kind] = h.transcribeArgs[0];
    assert.equal(token, TOKEN);
    assert.equal(chatId, CHAT_ID);
    assert.deepEqual(passedMedia, media);
    assert.deepEqual(voiceDeps, { repoRoot: '/repo', env: { FOO: 'bar' }, transcription: { engine: 'auto' }, threadId: THREAD_ID });
    assert.equal(kind, 'voice');
    const [, , , status, extra] = h.markAudioArgs[0];
    assert.equal(status, 'ok');
    assert.deepEqual(extra, { engine: 'whisper_local' });
    assert.equal(result.userText, '[Voice message] hello there');
    assert.equal(result.voiceTranscribed, true);
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
  });

  it('A-T4: voice success, update.__voiceResult prefetched', async () => {
    const vr = okResult({ text: 'prefetched text' });
    const h = makeHarness(); // transcribeResult unset — transcribe must not be called
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    const result = await runAttachmentStage(
      baseInput({ msg: { voice: media }, update: { __voiceResult: vr } }),
      h.deps,
    );
    assert.ok(!h.calls.includes('transcribe'));
    assert.equal(result.userText, '[Voice message] prefetched text');
    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0].text.includes('prefetched text'));
  });

  it('A-T5: voice success, update.__heldAbsorbed', async () => {
    const vr = okResult({ text: 'raw transcript text' });
    const h = makeHarness({ transcribeResult: vr });
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    const result = await runAttachmentStage(
      baseInput({ msg: { voice: media }, update: { __heldAbsorbed: true }, userText: 'already combined text' }),
      h.deps,
    );
    assert.equal(result.userText, 'already combined text');
    assert.equal(result.voiceTranscribed, true);
    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0].text.includes('raw transcript text'));
  });

  it('A-T6: echo content', async () => {
    const vr = okResult({ text: 'the transcript', engine: 'whisper_local' });
    const h = makeHarness({ transcribeResult: vr });
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    await runAttachmentStage(baseInput({ msg: { voice: media } }), h.deps);
    assert.equal(h.sent.length, 1);
    const m = h.sent[0];
    assert.equal(m.token, TOKEN);
    assert.equal(m.chatId, CHAT_ID);
    assert.equal(m.replyToMessageId, MESSAGE_ID);
    assert.equal(m.threadId, THREAD_ID);
    assert.ok(m.text.startsWith('🎙 Heard (whisper_local):'), `text: ${m.text}`);
    assert.ok(m.text.includes('the transcript'));
    assert.ok(/_Ref: /.test(m.text));
  });

  it('A-T7: truncated transcript', async () => {
    const vr = okResult({ text: 'truncated content', truncated: true });
    const h = makeHarness({ transcribeResult: vr });
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    const result = await runAttachmentStage(baseInput({ msg: { voice: media } }), h.deps);
    // The echo ends with the truncation suffix, then the ref line (appended by appendRefIdAndLog).
    assert.ok(h.sent[0].text.includes('[transcript truncated]\n\n_Ref: '), h.sent[0].text);
    assert.ok(result.userText.includes('truncated content'));
  });

  it('A-T8: vr.engine absent', async () => {
    const vr = okResult({ text: 'no engine text', engine: undefined as any });
    const h = makeHarness({ transcribeResult: vr });
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    await runAttachmentStage(baseInput({ msg: { voice: media } }), h.deps);
    assert.ok(h.sent[0].text.startsWith('🎙 Heard:'), `text: ${h.sent[0].text}`);
  });

  it('A-T9: voice failure', async () => {
    const vr = failResult({ reason: 'no-engine', message: 'no engine configured' });
    const h = makeHarness({ transcribeResult: vr });
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    const result = await runAttachmentStage(baseInput({ msg: { voice: media }, userText: '' }), h.deps);
    const expectedUserText = formatFailedTranscriptUserText('voice', 'no-engine', { caption: undefined });
    assert.equal(result.userText, expectedUserText);
    assert.equal(result.response, voiceErrorMessage(vr as Extract<VoiceResult, { ok: false }>));
    assert.equal(result.skipWorker, true);
    assert.equal(result.voiceTranscribed, false);
    assert.equal(h.sent.length, 0);
    const [, , , status, extra] = h.markAudioArgs[0];
    assert.equal(status, 'failed');
    assert.deepEqual(extra, { reason: 'no-engine' });
  });

  it('A-T10: voice failure + __heldAbsorbed', async () => {
    const vr = failResult({ reason: 'timeout' });
    const h = makeHarness({ transcribeResult: vr });
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    const result = await runAttachmentStage(
      baseInput({ msg: { voice: media }, update: { __heldAbsorbed: true }, userText: 'original text' }),
      h.deps,
    );
    assert.equal(result.userText, 'original text');
    assert.equal(result.response, voiceErrorMessage(vr as Extract<VoiceResult, { ok: false }>));
    assert.equal(result.skipWorker, true);
  });

  it('A-T11: echo send rejects', async () => {
    const vr = okResult({ text: 'text here' });
    const h = makeHarness({ transcribeResult: vr, sendBehavior: 'reject' });
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    const result = await runAttachmentStage(baseInput({ msg: { voice: media } }), h.deps);
    assert.equal(result.voiceTranscribed, true);
    assert.equal(result.skipWorker, false);
  });

  it('A-T12: recordAudio / markAudio reject', async () => {
    const vr = okResult({ text: 'hello there' });
    const h = makeHarness({ transcribeResult: vr, recordAudioBehavior: 'reject', markAudioBehavior: 'reject' });
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };
    const result = await runAttachmentStage(baseInput({ msg: { voice: media } }), h.deps);
    assert.equal(result.userText, '[Voice message] hello there');
    assert.equal(result.voiceTranscribed, true);
    assert.equal(result.skipWorker, false);
    assert.equal(result.response, '');
  });

  it('A-T13: audio-mime document, no caption', async () => {
    const h = makeHarness();
    const result = await runAttachmentStage(
      baseInput({ msg: { document: { mime_type: 'audio/mpeg', file_id: 'd1', file_unique_id: 'du1' } }, userText: '' }),
      h.deps,
    );
    const hint = '[An audio file was attached as a document and was not transcribed. Re-send it as a voice note or audio message to have it transcribed.]';
    assert.equal(result.userText, hint);
    assert.ok(!h.calls.includes('transcribe'));
    assert.ok(!h.calls.includes('download'));
  });

  it('A-T14: audio-mime document with a caption', async () => {
    const h = makeHarness();
    const caption = 'listen to this';
    const result = await runAttachmentStage(
      baseInput({ msg: { document: { mime_type: 'audio/mpeg', file_id: 'd1', file_unique_id: 'du1' } }, userText: caption }),
      h.deps,
    );
    const hint = '[An audio file was attached as a document and was not transcribed. Re-send it as a voice note or audio message to have it transcribed.]';
    assert.equal(result.userText, `${caption}\n\n${hint}`);
  });

  it('A-T15: document notes.exe rejected', async () => {
    const h = makeHarness();
    const result = await runAttachmentStage(
      baseInput({ msg: { document: { file_id: 'd1', file_unique_id: 'du1', file_name: 'notes.exe' } }, userText: '' }),
      h.deps,
    );
    assert.ok(result.userText.includes('rejected: allowed types are pdf, jpg, png, webp, txt, md, csv, xlsx, zip.'), result.userText);
    assert.ok(!h.calls.includes('download'));
  });

  it('A-T16: document with no file_name and no photo', async () => {
    const h = makeHarness();
    const result = await runAttachmentStage(
      baseInput({ msg: { document: {} }, userText: '' }),
      h.deps,
    );
    assert.ok(result.userText.includes('[Attachment (unnamed) rejected:'), result.userText);
  });

  it('A-T17: document report.pdf accepted', async () => {
    const h = makeHarness();
    const result = await runAttachmentStage(
      baseInput({ msg: { document: { file_id: 'd1', file_unique_id: 'du1', file_name: 'report.pdf' } }, userText: '' }),
      h.deps,
    );
    assert.equal(h.madeDirs.length, 1);
    assert.equal(h.downloadArgs.length, 1);
    const { token, fileId, destPath } = h.downloadArgs[0];
    assert.equal(token, TOKEN);
    assert.equal(fileId, 'd1');
    assert.equal(h.madeDirs[0], dirname(destPath));
    assert.ok(destPath.endsWith('.pdf'), destPath);
    assert.ok(destPath.startsWith(join(tempDir, 'attachments', String(CHAT_ID))), destPath);
    assert.ok(result.userText.includes(`[Attachment: report.pdf at ${destPath}]`), result.userText);
    assert.equal(h.infoLogs.length, 1);
    assert.equal(h.infoLogs[0].module, 'attachments');
  });

  it('A-T18: photo — largest size is the last array element', async () => {
    const h = makeHarness();
    const small = { file_id: 'p-small', file_unique_id: 'pu-small' };
    const large = { file_id: 'p-large', file_unique_id: 'pu-large' };
    const result = await runAttachmentStage(
      baseInput({ msg: { photo: [small, large] }, userText: '' }),
      h.deps,
    );
    assert.equal(h.downloadArgs.length, 1);
    assert.equal(h.downloadArgs[0].fileId, 'p-large');
    assert.ok(h.downloadArgs[0].destPath.endsWith('.jpg'), h.downloadArgs[0].destPath);
    assert.ok(result.userText.includes('photo_pu-large.jpg'), result.userText);
  });

  it('A-T19: downloadFileFn returns false', async () => {
    const h = makeHarness({ downloadBehavior: 'false' });
    const result = await runAttachmentStage(
      baseInput({ msg: { document: { file_id: 'd1', file_unique_id: 'du1', file_name: 'report.pdf' } }, userText: '' }),
      h.deps,
    );
    assert.ok(result.userText.includes('[Attachment report.pdf failed to download — see pa-alerts log.]'), result.userText);
    assert.equal(h.warnLogs.length, 1);
  });

  it('A-T20: downloadFileFn throws', async () => {
    const h = makeHarness({ downloadBehavior: 'throw' });
    const result = await runAttachmentStage(
      baseInput({ msg: { document: { file_id: 'd1', file_unique_id: 'du1', file_name: 'report.pdf' } }, userText: '' }),
      h.deps,
    );
    assert.ok(result.userText.includes('[Attachment report.pdf failed to download — see pa-alerts log.]'), result.userText);
    assert.equal(h.warnLogs.length, 1);
  });

  it('A-T21: ESM source guard — no require( in the source file', () => {
    const sourcePath = join(fileURLToPath(import.meta.url), '../../../src/attachment-stage.ts');
    const source = readFileSync(sourcePath, 'utf-8');
    assert.ok(!source.includes('require('), 'attachment-stage.ts must stay require-free (the bot is ESM)');
  });
});

/**
 * AI-191 (2026-09-03): voice-invoked commands. A transcript that confidently
 * invokes a registered command becomes that command's typed-equivalent text;
 * everything else falls through as conversation. Matcher tests inject the
 * closed set; integration tests drive runAttachmentStage; the seam tests
 * assert the REAL interception machinery (logic.ts's patterns via
 * guardUnknownCommand) recognizes everything voice produces.
 */
describe('AI-191: voice-invoked commands', () => {
  /** Injected closed set — matchVoiceCommand's `isRegistered` gate. */
  const reg = (...names: string[]) => (c: string) => names.includes(c);
  /** The nine commands the SAFE_BARE list covers, as a deps-shaped set. */
  const FULL_SAFE_SET = () => new Set(['status', 'health', 'help', 'skills', 'claims', 'agent', 'keepawake', 'retranscribe', 'update_brain']);
  const FULL_SAFE = reg('status', 'health', 'help', 'skills', 'claims', 'agent', 'keepawake', 'retranscribe', 'update_brain');

  describe('layer 1 — literal spoken slash form', () => {
    it('V1: "slash status" → /status', () => {
      assert.deepEqual(matchVoiceCommand('slash status', FULL_SAFE), { normalized: '/status', command: 'status', via: 'literal' });
    });

    it('V2: literal arguments ride verbatim: "slash retranscribe groq"', () => {
      assert.deepEqual(matchVoiceCommand('slash retranscribe groq', FULL_SAFE), { normalized: '/retranscribe groq', command: 'retranscribe', via: 'literal' });
    });

    it('V3: literal destructive form is explicit speech, not inference: "Slash new."', () => {
      assert.deepEqual(matchVoiceCommand('Slash new.', reg('new', 'status')), { normalized: '/new', command: 'new', via: 'literal' });
    });

    it('V4: engine transcribed the symbol: "/status" → /status', () => {
      assert.deepEqual(matchVoiceCommand('/status', FULL_SAFE), { normalized: '/status', command: 'status', via: 'literal' });
    });

    it('V5: unknown word falls through: "slash foobar"', () => {
      assert.equal(matchVoiceCommand('slash foobar', FULL_SAFE), undefined);
    });

    it('V6: gated on the registry: "slash new" without new registered', () => {
      assert.equal(matchVoiceCommand('slash new', reg('status')), undefined);
    });

    it('V7: leading filler: "hey pa slash status"', () => {
      assert.deepEqual(matchVoiceCommand('hey pa slash status', FULL_SAFE), { normalized: '/status', command: 'status', via: 'literal' });
    });

    it('V8: acceptance seam — an argument the pattern cannot accept falls through: "slash status please"', () => {
      assert.equal(matchVoiceCommand('slash status place', FULL_SAFE), undefined);
    });
  });

  describe('layer 2a — bare utterance is the command', () => {
    it('V9: "status" and case/punct "Health."', () => {
      assert.deepEqual(matchVoiceCommand('status', FULL_SAFE), { normalized: '/status', command: 'status', via: 'inferred' });
      assert.deepEqual(matchVoiceCommand('Health.', FULL_SAFE), { normalized: '/health', command: 'health', via: 'inferred' });
    });

    it('V10: edge filler stripped: "please help" and "status please"', () => {
      assert.deepEqual(matchVoiceCommand('please help', FULL_SAFE), { normalized: '/help', command: 'help', via: 'inferred' });
      assert.deepEqual(matchVoiceCommand('status please', FULL_SAFE), { normalized: '/status', command: 'status', via: 'inferred' });
    });
  });

  it('V11: spoken phrase alias: "update brain" → /update_brain', () => {
    assert.deepEqual(matchVoiceCommand('update brain', FULL_SAFE), { normalized: '/update_brain', command: 'update_brain', via: 'inferred' });
    assert.deepEqual(matchVoiceCommand('update brains', FULL_SAFE), { normalized: '/update_brain', command: 'update_brain', via: 'inferred' });
  });

  it('V12: destructive / git / stop commands are NEVER inferred bare', () => {
    const everything = () => true;
    assert.equal(matchVoiceCommand('new', everything), undefined);
    assert.equal(matchVoiceCommand('reset', everything), undefined);
    assert.equal(matchVoiceCommand('commit', everything), undefined);
    assert.equal(matchVoiceCommand('push', everything), undefined);
    assert.equal(matchVoiceCommand('stop', everything), undefined);
    assert.equal(matchVoiceCommand('steer', everything), undefined);
  });

  describe('layer 2b — unambiguous verb + spoken object', () => {
    it('V13: "debug that last message" with debug registered → /debug', () => {
      assert.deepEqual(matchVoiceCommand('debug that last message', reg('debug', 'status')), { normalized: '/debug', command: 'debug', via: 'inferred' });
    });

    it('V14: debug stays dormant when not registered', () => {
      assert.equal(matchVoiceCommand('debug that last message', reg('status')), undefined);
    });

    it('V15: "retranscribe that note" → bare /retranscribe (object resolves via reply-to)', () => {
      assert.deepEqual(matchVoiceCommand('retranscribe that note', FULL_SAFE), { normalized: '/retranscribe', command: 'retranscribe', via: 'inferred' });
      assert.deepEqual(matchVoiceCommand('re-transcribe the last one', FULL_SAFE), { normalized: '/retranscribe', command: 'retranscribe', via: 'inferred' });
    });

    it('V16: "debugging" (not the verb "debug") never matches', () => {
      assert.equal(matchVoiceCommand('debugging this took hours', reg('debug')), undefined);
    });
  });

  it('V17: conversational sentences fall through untouched', () => {
    for (const t of [
      'help me understand this error',
      'status update on the farm project',
      'could you check the status',
      'what is my status',
      'review this code for me',
      'can you help with the deployment',
      'stop doing that tomorrow',
      'new plan for the kitchen',
    ]) {
      assert.equal(matchVoiceCommand(t, FULL_SAFE), undefined, `must stay conversational: "${t}"`);
    }
  });

  it('V18: SEAM — the real unknown-command guard recognizes every normalized form', () => {
    // Drives the REAL consumer (logic.ts's pattern machinery) over real
    // producer output: whenever voice produces a command, the guard must
    // recognize it (never "Unknown command", never a worker dispatch).
    for (const t of [
      'slash status', 'slash health', 'slash help', 'slash skills', 'slash claims',
      'status', 'health.', 'please help', 'skills please', 'claims', 'agent', 'keepawake',
      'update brain', 'update brains',
      'retranscribe', 'retranscribe that note', 'slash retranscribe groq',
    ]) {
      const m: VoiceCommandMatch | undefined = matchVoiceCommand(t, FULL_SAFE);
      assert.ok(m, `expected a match for "${t}"`);
      assert.equal(guardUnknownCommand(m.normalized), undefined, `guard must recognize "${m.normalized}" (from "${t}")`);
    }
  });

  it('V19: live-registry invariant — debug activates exactly when the live set has it', () => {
    const live = liveRegisteredVoiceCommands();
    const m = matchVoiceCommand('debug that last message', (c) => live.has(c));
    assert.equal(m !== undefined, live.has('debug'));
    if (m) {
      assert.equal(m.normalized, '/debug');
      assert.equal(m.via, 'inferred');
      // The real consumer must accept it (AI-190's DEBUG_PATTERN in isKnownCommand).
      assert.equal(guardUnknownCommand('/debug'), undefined);
    }
  });

  describe('integration through runAttachmentStage', () => {
    const media = { file_id: 'v1', file_unique_id: 'vu1', duration: 5 };

    it('V20: "slash status" becomes /status and the echo shows the interpretation', async () => {
      const h = makeHarness({ transcribeResult: okResult({ text: 'slash status' }) });
      const result = await runAttachmentStage(
        baseInput({ msg: { voice: media } }),
        { ...h.deps, registeredCommands: FULL_SAFE_SET },
      );
      assert.equal(result.userText, '/status');
      assert.equal(result.voiceTranscribed, true);
      assert.equal(result.skipWorker, false);
      assert.equal(h.sent.length, 1);
      assert.ok(h.sent[0].text.includes('\n\n→ /status'), h.sent[0].text);
      assert.ok(h.sent[0].text.includes('slash status'), h.sent[0].text);
    });

    it('V21: conversational transcript keeps the wrapped text, no interpretation', async () => {
      const h = makeHarness({ transcribeResult: okResult({ text: 'hello there' }) });
      const result = await runAttachmentStage(baseInput({ msg: { voice: media } }), { ...h.deps, registeredCommands: FULL_SAFE_SET });
      assert.equal(result.userText, '[Voice message] hello there');
      assert.ok(!h.sent[0].text.includes('→'), h.sent[0].text);
    });

    it('V22: a forwarded voice note never invokes a command', async () => {
      const h = makeHarness({ transcribeResult: okResult({ text: 'slash status' }) });
      const msg = { voice: media, forward_origin: { type: 'user', sender_user: { first_name: 'X' } } };
      const result = await runAttachmentStage(baseInput({ msg }), { ...h.deps, registeredCommands: FULL_SAFE_SET });
      // The forwarded-origin descriptor rides the wrapper; the transcript must
      // remain conversational either way.
      assert.equal(result.userText, '[Voice message, forwarded from X] slash status');
      assert.ok(!h.sent[0].text.includes('→'), h.sent[0].text);
    });

    it('V23: held-absorbed combined text is never interpreted', async () => {
      const h = makeHarness({ transcribeResult: okResult({ text: 'slash status' }) });
      const result = await runAttachmentStage(
        baseInput({ msg: { voice: media }, update: { __heldAbsorbed: true }, userText: 'earlier held text' }),
        { ...h.deps, registeredCommands: FULL_SAFE_SET },
      );
      assert.equal(result.userText, 'earlier held text');
      assert.ok(!h.sent[0].text.includes('→'), h.sent[0].text);
    });

    it('V24: live default deps — debug activation is conditional on the live registry', async () => {
      const h = makeHarness({ transcribeResult: okResult({ text: 'debug that last message' }) });
      const liveHasDebug = liveRegisteredVoiceCommands().has('debug');
      const result = await runAttachmentStage(baseInput({ msg: { voice: media } }), h.deps);
      if (liveHasDebug) {
        assert.equal(result.userText, '/debug');
        assert.ok(h.sent[0].text.includes('→ /debug'), h.sent[0].text);
      } else {
        assert.equal(result.userText, '[Voice message] debug that last message');
        assert.ok(!h.sent[0].text.includes('→'), h.sent[0].text);
      }
    });
  });
});
