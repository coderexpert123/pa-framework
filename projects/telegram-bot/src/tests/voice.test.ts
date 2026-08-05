import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { rmRetry } from './rm-retry.js';

let tempDir: string;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'voice-test-'));
  process.env.PA_HOME = tempDir;
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(tempDir);
});

// Dynamic import after PA_HOME is set — voiceAttachmentPath (via pa/dist's
// paHome()) and the structured logger both read process.env.PA_HOME.
const {
  voiceMaxDurationS,
  voiceTimeoutMs,
  voiceMaxFileBytes,
  voiceScriptPath,
  voiceAttachmentPath,
  extensionForAttachment,
  extractAudioAttachment,
  findCachedAudio,
  configuredCloudProviders,
  persistentModeApplies,
  buildBridgeArgs,
  parseVoiceEnvelope,
  reasonForErrorCode,
  formatTranscriptUserText,
  formatFailedTranscriptUserText,
  voiceErrorMessage,
  transcribeVoiceMessage,
  VOICE_TYPING_INTERVAL_MS,
} = await import('../voice.js');
type TelegramVoice = import('../voice.js').TelegramVoice;
type TelegramAudioLike = import('../voice.js').TelegramAudioLike;
type AudioAttachmentKind = import('../voice.js').AudioAttachmentKind;
type VoiceDeps = import('../voice.js').VoiceDeps;
type ExecResult = import('../voice.js').ExecResult;
type VoiceResult = import('../voice.js').VoiceResult;
type VoiceFailureReason = import('../voice.js').VoiceFailureReason;

const { resolveTranscriptionConfig } = await import('../../../../pa/dist/src/config.js');
const { VOICE_ATTACHMENT_FILE_RE } = await import('../../../../pa/dist/src/lib/maintenance/jobs/voice-attachment-gc.js');
type VoiceWorkerRequest = import('../voice-worker-client.js').VoiceWorkerRequest;
type VoiceWorkerClientDeps = import('../voice-worker-client.js').VoiceWorkerClientDeps;
type VoiceWorkerOutcome = import('../voice-worker-client.js').VoiceWorkerOutcome;

const TOKEN = 'test-token';
const CHAT_ID = -1001234;
const REPO_ROOT = 'D:/Personal Assistant';

function makeVoice(overrides: Partial<TelegramVoice> = {}): TelegramVoice {
  return {
    file_id: 'file-1',
    file_unique_id: 'uniq-1',
    duration: 12,
    ...overrides,
  };
}

function okExec(overrides: Record<string, any> = {}): ExecResult {
  return {
    stdout:
      JSON.stringify({
        ok: true,
        text: 'hello there',
        engine: 'whisper_local',
        turns: 1,
        duration_s: 12.4,
        elapsed_s: 2.1,
        truncated: false,
        fallback_from: null,
        ...overrides,
      }) + '\n',
    stderr: '',
    code: 0,
    timedOut: false,
  };
}

function makeDeps(overrides: Partial<VoiceDeps> = {}): VoiceDeps {
  return {
    repoRoot: REPO_ROOT,
    env: { PA_HOME: tempDir },
    downloadFileFn: async () => true,
    sendTypingFn: async () => {},
    execFn: async () => okExec(),
    ...overrides,
  };
}

describe('voiceAttachmentPath', () => {
  it('builds <PA_HOME>/attachments/<chatId>/<YYYY-MM-DD>/<uid>.oga with a pinned date (default ext)', () => {
    const now = new Date('2026-08-04T10:00:00.000Z'); // ~15:30 IST same day
    const p = voiceAttachmentPath(555, 'abc123', now);
    assert.equal(p, join(tempDir, 'attachments', '555', '2026-08-04', 'abc123.oga'));
  });

  it('keeps the sign on a negative (supergroup) chatId', () => {
    const now = new Date('2026-08-04T10:00:00.000Z');
    const p = voiceAttachmentPath(-555, 'abc123', now);
    assert.equal(p, join(tempDir, 'attachments', '-555', '2026-08-04', 'abc123.oga'));
  });

  it('sanitizes a hostile file_unique_id so the result stays under attachments/', () => {
    const now = new Date('2026-08-04T10:00:00.000Z');
    const p = voiceAttachmentPath(555, '../../evil', now);
    assert.ok(!p.includes('..'));
    assert.ok(p.startsWith(join(tempDir, 'attachments', '555')));
  });

  it('honors an explicit ext param', () => {
    const now = new Date('2026-08-04T10:00:00.000Z');
    const p = voiceAttachmentPath(555, 'abc123', now, 'mp3');
    assert.equal(p, join(tempDir, 'attachments', '555', '2026-08-04', 'abc123.mp3'));
  });
});

describe('voiceScriptPath', () => {
  it('defaults to <repoRoot>/pa/scripts/transcribe_voice.py', () => {
    const p = voiceScriptPath({}, REPO_ROOT);
    assert.equal(p, join(REPO_ROOT, 'pa', 'scripts', 'transcribe_voice.py'));
  });

  it('honors PA_VOICE_TRANSCRIBE_SCRIPT override', () => {
    const p = voiceScriptPath({ PA_VOICE_TRANSCRIBE_SCRIPT: 'C:/custom/bridge.py' }, REPO_ROOT);
    assert.equal(p, 'C:/custom/bridge.py');
  });
});

describe('voiceMaxDurationS / voiceTimeoutMs / voiceMaxFileBytes', () => {
  it('default to 1800 / 600000 / 20MiB when unset', () => {
    assert.equal(voiceMaxDurationS({}), 1800);
    assert.equal(voiceTimeoutMs({}), 600000);
    assert.equal(voiceMaxFileBytes({}), 20 * 1024 * 1024);
  });

  it('default when unparseable', () => {
    assert.equal(voiceMaxDurationS({ PA_VOICE_MAX_DURATION_S: 'nope' }), 1800);
    assert.equal(voiceTimeoutMs({ PA_VOICE_TRANSCRIBE_TIMEOUT_MS: 'nope' }), 600000);
    assert.equal(voiceMaxFileBytes({ PA_VOICE_MAX_FILE_BYTES: 'nope' }), 20 * 1024 * 1024);
  });

  it('honors overrides', () => {
    assert.equal(voiceMaxDurationS({ PA_VOICE_MAX_DURATION_S: '60' }), 60);
    assert.equal(voiceTimeoutMs({ PA_VOICE_TRANSCRIBE_TIMEOUT_MS: '1000' }), 1000);
    assert.equal(voiceMaxFileBytes({ PA_VOICE_MAX_FILE_BYTES: '1000' }), 1000);
  });

  it('asserts the D7 default value 600000 exactly (tied to blackboard.ts HEARTBEAT_STALE_MS)', () => {
    assert.equal(voiceTimeoutMs({}), 600000);
  });
});

describe('extractAudioAttachment', () => {
  it('precedence: voice > audio > video_note', () => {
    const voiceMedia = makeVoice();
    const audioMedia: TelegramAudioLike = { file_id: 'a', file_unique_id: 'a1', duration: 5 };
    const videoNoteMedia: TelegramAudioLike = { file_id: 'v', file_unique_id: 'v1', duration: 5 };

    assert.deepEqual(extractAudioAttachment({ voice: voiceMedia, audio: audioMedia, video_note: videoNoteMedia }), {
      kind: 'voice',
      media: voiceMedia,
    });
    assert.deepEqual(extractAudioAttachment({ audio: audioMedia, video_note: videoNoteMedia }), {
      kind: 'audio',
      media: audioMedia,
    });
    assert.deepEqual(extractAudioAttachment({ video_note: videoNoteMedia }), {
      kind: 'video_note',
      media: videoNoteMedia,
    });
    assert.equal(extractAudioAttachment({}), undefined);
  });
});

describe('extensionForAttachment', () => {
  it('voice is always .oga, video_note is always .mp4, regardless of media fields', () => {
    assert.equal(extensionForAttachment('voice', { file_id: 'f', file_unique_id: 'u', duration: 1, mime_type: 'audio/mp4', file_name: 'x.wav' }), 'oga');
    assert.equal(extensionForAttachment('video_note', { file_id: 'f', file_unique_id: 'u', duration: 1 }), 'mp4');
  });

  it('audio prefers file_name over mime_type', () => {
    const ext = extensionForAttachment('audio', { file_id: 'f', file_unique_id: 'u', duration: 1, file_name: 'song.mp3', mime_type: 'audio/wav' });
    assert.equal(ext, 'mp3');
  });

  it('audio falls back to mime_type when file_name is absent or unrecognized', () => {
    assert.equal(extensionForAttachment('audio', { file_id: 'f', file_unique_id: 'u', duration: 1, mime_type: 'audio/flac' }), 'flac');
    assert.equal(
      extensionForAttachment('audio', { file_id: 'f', file_unique_id: 'u', duration: 1, file_name: 'noext', mime_type: 'audio/aac' }),
      'aac'
    );
  });

  it('audio falls back to .bin when neither is recognized', () => {
    assert.equal(extensionForAttachment('audio', { file_id: 'f', file_unique_id: 'u', duration: 1 }), 'bin');
    assert.equal(
      extensionForAttachment('audio', { file_id: 'f', file_unique_id: 'u', duration: 1, mime_type: 'application/octet-stream' }),
      'bin'
    );
  });

  it('WP4<->WP8 drift guard: every non-.bin extension it can produce is matched by VOICE_ATTACHMENT_FILE_RE', () => {
    const cases: Array<[AudioAttachmentKind, TelegramAudioLike]> = [
      ['voice', { file_id: 'f', file_unique_id: 'u', duration: 1 }],
      ['video_note', { file_id: 'f', file_unique_id: 'u', duration: 1 }],
      ...Object.keys({
        'audio/ogg': 1, 'audio/opus': 1, 'audio/mpeg': 1, 'audio/mp4': 1, 'audio/wav': 1,
        'audio/webm': 1, 'audio/flac': 1, 'audio/aac': 1, 'audio/amr': 1,
      }).map((mime) => ['audio', { file_id: 'f', file_unique_id: 'u', duration: 1, mime_type: mime }] as [AudioAttachmentKind, TelegramAudioLike]),
    ];
    for (const [kind, media] of cases) {
      const ext = extensionForAttachment(kind, media);
      assert.ok(VOICE_ATTACHMENT_FILE_RE.test(`AgADdQADq6cxG.${ext}`), `expected ${ext} (kind=${kind}) to match VOICE_ATTACHMENT_FILE_RE`);
    }
  });
});

describe('findCachedAudio', () => {
  it('finds a previously-downloaded attachment across dated directories', async () => {
    const dir = join(tempDir, 'attachments', String(CHAT_ID), '2026-07-20');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'findme-1.oga'), 'fake audio');
    const found = await findCachedAudio(CHAT_ID, 'findme-1');
    assert.equal(found, join(dir, 'findme-1.oga'));
  });

  it('matches a failed note whose audio is otherwise an untouched orphan (same lookup, no special-casing)', async () => {
    const dir = join(tempDir, 'attachments', String(CHAT_ID), '2026-07-21');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'orphan-1.mp3'), 'fake audio');
    const found = await findCachedAudio(CHAT_ID, 'orphan-1');
    assert.equal(found, join(dir, 'orphan-1.mp3'));
  });

  it('returns undefined when nothing matches', async () => {
    const found = await findCachedAudio(CHAT_ID, 'does-not-exist-anywhere');
    assert.equal(found, undefined);
  });

  it('returns undefined when the chat has no attachment directory at all', async () => {
    const found = await findCachedAudio(-999999, 'whatever');
    assert.equal(found, undefined);
  });
});

describe('configuredCloudProviders / persistentModeApplies', () => {
  const order = ['groq', 'openai', 'deepgram'];

  it('configuredCloudProviders: trimmed, non-blank keys only (mirrors transcribe_voice.py _key_for)', () => {
    assert.deepEqual(configuredCloudProviders({ GROQ_API_KEY: ' key ' }, order), ['groq']);
    assert.deepEqual(configuredCloudProviders({ GROQ_API_KEY: '   ' }, order), []);
    assert.deepEqual(configuredCloudProviders({}, order), []);
    assert.deepEqual(configuredCloudProviders({ GROQ_API_KEY: 'g', DEEPGRAM_API_KEY: 'd' }, order), ['groq', 'deepgram']);
  });

  it('the full 5-row persistentModeApplies table', () => {
    const localCfg = resolveTranscriptionConfig({ engine_preference: 'local' });
    const autoCfg = resolveTranscriptionConfig({ engine_preference: 'auto' });
    const cloudCfg = resolveTranscriptionConfig({ engine_preference: 'cloud' });

    assert.equal(persistentModeApplies(localCfg, {}), true, 'local, no key -> always true');
    assert.equal(persistentModeApplies(localCfg, { GROQ_API_KEY: 'x' }), true, 'local, with key -> always true');
    assert.equal(persistentModeApplies(autoCfg, {}), true, 'auto, no key -> true (local leads)');
    assert.equal(persistentModeApplies(autoCfg, { GROQ_API_KEY: 'x' }), false, 'auto, with key -> false (cloud leads)');
    assert.equal(persistentModeApplies(cloudCfg, {}), false, 'cloud, no key -> false either way');
    assert.equal(persistentModeApplies(cloudCfg, { GROQ_API_KEY: 'x' }), false, 'cloud, with key -> false either way');
  });
});

describe('buildBridgeArgs', () => {
  it('emits --engine auto, --engine-preference and --cloud-order from cfg', () => {
    const cfg = resolveTranscriptionConfig({ engine_preference: 'cloud', cloud_order: ['groq', 'openai'] });
    const args = buildBridgeArgs('script.py', 'audio.oga', cfg);
    assert.deepEqual(args, [
      'script.py',
      'audio.oga',
      '--engine',
      'auto',
      '--engine-preference',
      'cloud',
      '--cloud-order',
      'groq,openai',
    ]);
  });

  it('defaults engine_preference/cloud_order via resolveTranscriptionConfig when cfg came from undefined', () => {
    const cfg = resolveTranscriptionConfig(undefined);
    const args = buildBridgeArgs('script.py', 'audio.oga', cfg);
    assert.deepEqual(args, [
      'script.py',
      'audio.oga',
      '--engine',
      'auto',
      '--engine-preference',
      'auto',
      '--cloud-order',
      'groq,openai,deepgram',
    ]);
  });

  it('omits --max-chars when maxChars is not passed (D11)', () => {
    const cfg = resolveTranscriptionConfig(undefined);
    const args = buildBridgeArgs('script.py', 'audio.oga', cfg);
    assert.ok(!args.includes('--max-chars'));
  });

  it('includes --max-chars only when explicitly passed', () => {
    const cfg = resolveTranscriptionConfig(undefined);
    const args = buildBridgeArgs('script.py', 'audio.oga', cfg, 123);
    assert.deepEqual(args.slice(-2), ['--max-chars', '123']);
  });

  it('omits --language when cfg.language is unset', () => {
    const cfg = resolveTranscriptionConfig(undefined);
    const args = buildBridgeArgs('script.py', 'audio.oga', cfg);
    assert.ok(!args.includes('--language'));
  });

  it('emits --language when cfg.language is set', () => {
    const cfg = resolveTranscriptionConfig({ language: 'es' });
    const args = buildBridgeArgs('script.py', 'audio.oga', cfg);
    assert.ok(args.includes('--language'));
    assert.equal(args[args.indexOf('--language') + 1], 'es');
  });

  it('honors an engineOverride in place of the default "auto"', () => {
    const cfg = resolveTranscriptionConfig(undefined);
    const args = buildBridgeArgs('script.py', 'audio.oga', cfg, undefined, 'groq');
    assert.equal(args[args.indexOf('--engine') + 1], 'groq');
  });
});

describe('parseVoiceEnvelope', () => {
  it('parses a clean single-line envelope', () => {
    const parsed = parseVoiceEnvelope('{"ok":true,"text":"hi"}\n');
    assert.deepEqual(parsed, { ok: true, text: 'hi' });
  });

  it('takes the last non-empty line when stray output precedes the envelope', () => {
    const parsed = parseVoiceEnvelope('loading model...\n{"ok":true,"text":"hi"}\n');
    assert.deepEqual(parsed, { ok: true, text: 'hi' });
  });

  it('returns null for unparseable stdout', () => {
    assert.equal(parseVoiceEnvelope('not json at all'), null);
  });

  it('returns null for empty stdout', () => {
    assert.equal(parseVoiceEnvelope(''), null);
    assert.equal(parseVoiceEnvelope('\n\n'), null);
  });
});

describe('reasonForErrorCode', () => {
  it('maps the closed vocabulary table', () => {
    assert.equal(reasonForErrorCode('no-engine'), 'no-engine');
    assert.equal(reasonForErrorCode('cloud-auth'), 'cloud-auth');
    assert.equal(reasonForErrorCode('ffmpeg-missing'), 'ffmpeg-missing');
    for (const code of ['oversize', 'missing-file', 'other', '', undefined, 'made-up-code']) {
      assert.equal(reasonForErrorCode(code as any), 'transcribe-failed');
    }
  });
});

describe('formatTranscriptUserText', () => {
  it('HARD GATE: with no options set, output is byte-identical to the historical "[Voice message] <trimmed text>" (docs/BOT_GUIDE.md documents this exact string)', () => {
    assert.equal(formatTranscriptUserText('  hello  '), '[Voice message] hello');
  });

  it('appends the truncation notice only when opts.truncated is true', () => {
    const withTruncation = formatTranscriptUserText('hello', { truncated: true });
    assert.ok(withTruncation.includes('cut off at the length limit'));
    const withoutTruncation = formatTranscriptUserText('hello', { truncated: false });
    assert.ok(!withoutTruncation.includes('cut off at the length limit'));
    const omitted = formatTranscriptUserText('hello');
    assert.ok(!omitted.includes('cut off at the length limit'));
  });

  it('truncation suffix stays at the true end even with other descriptor fields set', () => {
    const text = formatTranscriptUserText('hello', { truncated: true, caption: 'cap' });
    assert.ok(text.endsWith('follow-up message.]'));
  });

  it('uses the audio/video_note base labels', () => {
    assert.ok(formatTranscriptUserText('hi', { kind: 'audio' }).startsWith('[Audio file]'));
    assert.ok(formatTranscriptUserText('hi', { kind: 'video_note' }).startsWith('[Video note]'));
  });

  it('an audio file with a fileName includes it in the label', () => {
    const text = formatTranscriptUserText('hi', { kind: 'audio', fileName: 'song.mp3' });
    assert.ok(text.startsWith('[Audio file: song.mp3]'));
  });

  it('composes forwardedFrom, speakers, and caption in the documented order', () => {
    const text = formatTranscriptUserText('hi', {
      forwardedFrom: 'Alice',
      speakers: 3,
      caption: 'look at this',
    });
    assert.equal(text, '[Voice message, forwarded from Alice, 3 speakers, caption: "look at this"] hi');
  });

  it('omits the speaker count when speakers <= 1', () => {
    assert.equal(formatTranscriptUserText('hi', { speakers: 1 }), '[Voice message] hi');
    assert.equal(formatTranscriptUserText('hi', { speakers: 0 }), '[Voice message] hi');
  });

  it('sanitizes the caption: collapses whitespace and rewrites double quotes to single quotes', () => {
    const text = formatTranscriptUserText('hi', { caption: 'a   weird\n\ncaption "here"' });
    assert.equal(text, '[Voice message, caption: "a weird caption \'here\'"] hi');
  });

  it('omits the caption clause entirely when caption sanitizes to empty', () => {
    const text = formatTranscriptUserText('hi', { caption: '   ' });
    assert.equal(text, '[Voice message] hi');
  });
});

describe('formatFailedTranscriptUserText', () => {
  it('produces a fixed phrase per reason, with no free-form provider text', () => {
    assert.equal(
      formatFailedTranscriptUserText('voice', 'timeout'),
      '[Voice message — transcription failed: timed out while transcribing]'
    );
  });

  it('covers every VoiceFailureReason value', () => {
    const reasons: VoiceFailureReason[] = [
      'too-long', 'too-large', 'download-failed', 'transcribe-failed',
      'empty-transcript', 'timeout', 'no-engine', 'cloud-auth', 'ffmpeg-missing',
    ];
    for (const reason of reasons) {
      const text = formatFailedTranscriptUserText('voice', reason);
      assert.ok(text.startsWith('[Voice message — transcription failed:'), `missing phrase for ${reason}`);
      assert.ok(text.endsWith(']'));
    }
  });

  it('uses the kind label', () => {
    assert.ok(formatFailedTranscriptUserText('audio', 'no-engine').startsWith('[Audio file —'));
    assert.ok(formatFailedTranscriptUserText('video_note', 'no-engine').startsWith('[Video note —'));
  });

  it('appends a sanitized caption when given', () => {
    const text = formatFailedTranscriptUserText('audio', 'no-engine', { caption: 'hi "there"' });
    assert.ok(text.includes('caption: "hi \'there\'"'));
  });
});

describe('voiceErrorMessage', () => {
  it('the no-engine message is the first-run message it claims to be (D10)', () => {
    const msg = voiceErrorMessage({ ok: false, reason: 'no-engine', message: 'diagnostic text' });
    assert.ok(msg.includes('console.groq.com/keys'));
    assert.ok(msg.includes('GROQ_API_KEY'));
    assert.ok(msg.includes('pa bot restart'));
    assert.ok(!msg.includes('pip install'));
    assert.ok(msg.includes('docs/TROUBLESHOOTING.md'));
  });

  it('no purpose-built message is ever truncated or cut mid-sentence', () => {
    const reasons: Array<Exclude<VoiceResult, { ok: true }>['reason']> = [
      'no-engine',
      'cloud-auth',
      'ffmpeg-missing',
      'download-failed',
      'timeout',
      'empty-transcript',
    ];
    for (const reason of reasons) {
      const msg = voiceErrorMessage({ ok: false, reason, message: 'irrelevant' });
      assert.ok(msg.length < 900, `${reason} message too long: ${msg.length}`);
      assert.ok(msg.endsWith('.') || msg.endsWith('"'), `${reason} message does not end cleanly: ${JSON.stringify(msg.slice(-20))}`);
      assert.ok(!msg.includes('…'), `${reason} message contains an ellipsis character`);
      assert.ok(!msg.includes('...'), `${reason} message contains a literal ellipsis`);
    }
  });

  it('transcribe-failed still truncates a long forwarded message', () => {
    const long = 'x'.repeat(2000);
    const msg = voiceErrorMessage({ ok: false, reason: 'transcribe-failed', message: long });
    assert.ok(msg.length <= 350, `expected a bounded length, got ${msg.length}`);
  });

  it('too-long and too-large return the builder-composed sentence verbatim', () => {
    const composedLong = '🎙 That voice note is 2000s — longer than the 1800s limit for transcription. Please send a shorter one or type your message.';
    assert.equal(voiceErrorMessage({ ok: false, reason: 'too-long', message: composedLong }), composedLong);

    const composedLarge = '🎙 That file is 99999 bytes — larger than the 1000-byte limit for transcription. Please send a smaller one or type your message.';
    assert.equal(voiceErrorMessage({ ok: false, reason: 'too-large', message: composedLarge }), composedLarge);
  });

  describe('/retranscribe hint', () => {
    it('is appended only when audioPath is set, for transcribe-failed/timeout/empty-transcript', () => {
      for (const reason of ['transcribe-failed', 'timeout', 'empty-transcript'] as const) {
        const withPath = voiceErrorMessage({ ok: false, reason, message: 'x', audioPath: '/tmp/a.oga' });
        assert.ok(withPath.includes('/retranscribe'), `expected hint for ${reason} with audioPath`);
        const withoutPath = voiceErrorMessage({ ok: false, reason, message: 'x' });
        assert.ok(!withoutPath.includes('/retranscribe'), `unexpected hint for ${reason} without audioPath`);
      }
    });

    it('is never appended for no-engine/cloud-auth/ffmpeg-missing/download-failed/too-long/too-large even with audioPath set', () => {
      const noHintReasons: Array<[VoiceFailureReason, string]> = [
        ['no-engine', 'x'],
        ['cloud-auth', 'x'],
        ['ffmpeg-missing', 'x'],
        ['download-failed', 'x'],
        ['too-long', 'composed sentence.'],
        ['too-large', 'composed sentence.'],
      ];
      for (const [reason, message] of noHintReasons) {
        const msg = voiceErrorMessage({ ok: false, reason, message, audioPath: '/tmp/a.oga' });
        assert.ok(!msg.includes('/retranscribe'), `unexpected hint for ${reason}`);
      }
    });
  });
});

describe('fail() logging', () => {
  it('includes audioPath in the structured log payload', async () => {
    const { logger } = await import('../../../../pa/dist/src/lib/log.js');
    const original = logger.warn;
    let captured: any[] | undefined;
    (logger as any).warn = (...args: any[]) => {
      captured = args;
    };
    try {
      const deps = makeDeps({ downloadFileFn: async () => false });
      await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    } finally {
      (logger as any).warn = original;
    }
    assert.ok(captured, 'expected logger.warn to have been called');
    assert.equal(captured![0], 'voice');
    assert.ok(captured![2] && typeof captured![2] === 'object' && 'audioPath' in captured![2]);
    assert.equal(typeof captured![2].audioPath, 'string');
  });
});

describe('transcribeVoiceMessage', () => {
  it('duration guard: rejects before downloading or executing anything', async () => {
    let downloadCalls = 0;
    let execCalls = 0;
    const deps = makeDeps({
      env: { PA_HOME: tempDir, PA_VOICE_MAX_DURATION_S: '10' },
      downloadFileFn: async () => {
        downloadCalls++;
        return true;
      },
      execFn: async () => {
        execCalls++;
        return okExec();
      },
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice({ duration: 20 }), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'too-long');
    assert.equal(downloadCalls, 0);
    assert.equal(execCalls, 0);
  });

  it('size guard: rejects before downloading or executing anything', async () => {
    let downloadCalls = 0;
    const deps = makeDeps({
      env: { PA_HOME: tempDir, PA_VOICE_MAX_FILE_BYTES: '1000' },
      downloadFileFn: async () => {
        downloadCalls++;
        return true;
      },
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice({ file_size: 2000 }), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'too-large');
    assert.equal(downloadCalls, 0);
  });

  it('size guard: allows a file at or under the limit', async () => {
    const deps = makeDeps({ env: { PA_HOME: tempDir, PA_VOICE_MAX_FILE_BYTES: '1000' } });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice({ file_size: 1000 }), deps);
    assert.equal(result.ok, true);
  });

  it('size guard: skipped when file_size is absent', async () => {
    const deps = makeDeps({ env: { PA_HOME: tempDir, PA_VOICE_MAX_FILE_BYTES: '1000' } });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
  });

  it('creates the parent directory before calling downloadFileFn', async () => {
    let dirExistedDuringDownload = false;
    const deps = makeDeps({
      downloadFileFn: async (_token: string, _fileId: string, destPath: string) => {
        dirExistedDuringDownload = existsSync(dirname(destPath));
        return true;
      },
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal(dirExistedDuringDownload, true);
  });

  it('happy path (spawn): parses the envelope and returns the transcript', async () => {
    const deps = makeDeps({
      execFn: async () => okExec({ text: 'hello there', engine: 'whisper_local', truncated: false }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.deepEqual(
      { ok: result.ok, text: (result as any).text, engine: (result as any).engine, mode: (result as any).mode, truncated: (result as any).truncated },
      { ok: true, text: 'hello there', engine: 'whisper_local', mode: 'spawn', truncated: false }
    );
  });

  it('stray stdout before the envelope still parses (last-non-empty-line rule)', async () => {
    const deps = makeDeps({
      execFn: async () => ({
        stdout: 'loading model...\n' + JSON.stringify({ ok: true, text: 'hi', engine: 'whisper_local', truncated: false }) + '\n',
        stderr: '',
        code: 0,
        timedOut: false,
      }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal((result as any).text, 'hi');
  });

  it('unparseable stdout maps to transcribe-failed with the stderr in the message', async () => {
    const deps = makeDeps({
      execFn: async () => ({ stdout: 'not json', stderr: 'Traceback: boom', code: 1, timedOut: false }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'transcribe-failed');
    assert.ok((result as any).message.includes('Traceback: boom'));
  });

  it('timedOut execResult maps to reason: timeout', async () => {
    const deps = makeDeps({
      execFn: async () => ({ stdout: '', stderr: '', code: null, timedOut: true }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'timeout');
  });

  it('ok:true with blank text maps to empty-transcript', async () => {
    const deps = makeDeps({ execFn: async () => okExec({ text: '   ' }) });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'empty-transcript');
  });

  it('downloadFileFn returning false maps to download-failed and never calls execFn', async () => {
    let execCalls = 0;
    const deps = makeDeps({
      downloadFileFn: async () => false,
      execFn: async () => {
        execCalls++;
        return okExec();
      },
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'download-failed');
    assert.equal(execCalls, 0);
  });

  it('buildBridgeArgs is used with the resolved config and never includes --max-chars on the real call path', async () => {
    let capturedArgs: string[] = [];
    const deps = makeDeps({
      execFn: async (_cmd: string, args: string[]) => {
        capturedArgs = args;
        return okExec();
      },
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.ok(capturedArgs.includes('--engine-preference'));
    assert.ok(capturedArgs.includes('auto'));
    assert.ok(capturedArgs.includes('--cloud-order'));
    assert.ok(capturedArgs.includes('groq,openai,deepgram'));
    assert.ok(!capturedArgs.includes('--max-chars'));
  });

  it('typing keep-alive fires repeatedly during a slow transcription and stops once it resolves', async (t: any) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let typingCalls = 0;
    let resolveExec!: (v: ExecResult) => void;
    const execPromise = new Promise<ExecResult>((resolve) => {
      resolveExec = resolve;
    });
    const deps = makeDeps({
      sendTypingFn: async () => {
        typingCalls++;
      },
      execFn: async () => execPromise,
    });

    const resultPromise = transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);

    // Let the promise chain progress past mkdir/download so the typing
    // interval has actually been registered before we advance mock time.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const callsAfterImmediate = typingCalls;
    assert.ok(callsAfterImmediate >= 1, 'expected the immediate typing call to have fired');

    t.mock.timers.tick(VOICE_TYPING_INTERVAL_MS);
    t.mock.timers.tick(VOICE_TYPING_INTERVAL_MS);
    assert.ok(typingCalls > callsAfterImmediate, 'expected the interval to fire more than once');

    resolveExec(okExec());
    const result = await resultPromise;
    assert.equal(result.ok, true);

    const callsAfterResolve = typingCalls;
    t.mock.timers.tick(VOICE_TYPING_INTERVAL_MS * 3);
    assert.equal(typingCalls, callsAfterResolve, 'the finally must clear the interval once transcription resolves');
  });

  it('never throws when execFn rejects', async () => {
    const deps = makeDeps({
      execFn: async () => {
        throw new Error('spawn exploded');
      },
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'transcribe-failed');
  });

  it('persistent mode happy path: uses persistentFn and never calls execFn', async () => {
    let execCalls = 0;
    const deps = makeDeps({
      transcription: { worker_mode: 'persistent', engine_preference: 'local' },
      execFn: async () => {
        execCalls++;
        return okExec();
      },
      persistentFn: async (_req: VoiceWorkerRequest, _clientDeps: VoiceWorkerClientDeps): Promise<VoiceWorkerOutcome> => ({
        kind: 'envelope',
        envelope: { ok: true, text: 'from worker', engine: 'groq', truncated: false },
      }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal((result as any).mode, 'persistent');
    assert.equal((result as any).text, 'from worker');
    assert.equal(execCalls, 0);
  });

  it('persistent-unavailable falls back to spawn for this note', async () => {
    const deps = makeDeps({
      transcription: { worker_mode: 'persistent', engine_preference: 'local' },
      persistentFn: async (): Promise<VoiceWorkerOutcome> => ({ kind: 'unavailable', message: 'worker could not be started' }),
      execFn: async () => okExec({ text: 'spawned instead' }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal((result as any).mode, 'spawn');
    assert.equal((result as any).fallback, 'persistent-unavailable');
    assert.equal((result as any).text, 'spawned instead');
  });

  it('a genuine persistent transcription failure does NOT fall back to spawn', async () => {
    let execCalls = 0;
    const deps = makeDeps({
      transcription: { worker_mode: 'persistent', engine_preference: 'local' },
      persistentFn: async (): Promise<VoiceWorkerOutcome> => ({
        kind: 'envelope',
        envelope: { ok: false, error_code: 'cloud-auth', error: 'bad key' },
      }),
      execFn: async () => {
        execCalls++;
        return okExec();
      },
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'cloud-auth');
    assert.equal(execCalls, 0);
  });

  it('a persistent-leg timeout resolves reason "timeout" directly and does NOT fall back to spawn (no doubled wait)', async () => {
    let execCalls = 0;
    const deps = makeDeps({
      transcription: { worker_mode: 'persistent', engine_preference: 'local' },
      persistentFn: async (): Promise<VoiceWorkerOutcome> => ({ kind: 'timeout', message: 'voice worker transcribe request timed out' }),
      execFn: async () => {
        execCalls++;
        return okExec();
      },
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'timeout');
    assert.equal(execCalls, 0);
  });

  it('a throw from persistentFn itself still falls through to the spawn fallback', async () => {
    const deps = makeDeps({
      transcription: { worker_mode: 'persistent', engine_preference: 'local' },
      persistentFn: async (): Promise<VoiceWorkerOutcome> => {
        throw new Error('unexpected persistentFn crash');
      },
      execFn: async () => okExec({ text: 'spawned after throw' }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal((result as any).text, 'spawned after throw');
  });

  it('worker_mode "persistent" is skipped (never calls persistentFn) when a cloud engine leads the resolved plan', async () => {
    let persistentCalls = 0;
    const deps = makeDeps({
      transcription: { worker_mode: 'persistent', engine_preference: 'auto' },
      env: { PA_HOME: tempDir, GROQ_API_KEY: 'configured-key' },
      persistentFn: async (): Promise<VoiceWorkerOutcome> => {
        persistentCalls++;
        return { kind: 'unavailable', message: 'should never be called' };
      },
      execFn: async () => okExec({ text: 'via cloud spawn' }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal((result as any).mode, 'spawn');
    assert.equal(persistentCalls, 0);
  });

  it('worker_mode "spawn" (the default) never calls persistentFn', async () => {
    let persistentCalls = 0;
    const deps = makeDeps({
      persistentFn: async (): Promise<VoiceWorkerOutcome> => {
        persistentCalls++;
        return { kind: 'unavailable', message: 'should never be called' };
      },
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal(persistentCalls, 0);
  });

  it('error_code reaches the user through both modes (spawn envelope)', async () => {
    const deps = makeDeps({
      execFn: async () => ({
        stdout: JSON.stringify({ ok: false, error_code: 'no-engine', error: 'guidance text' }) + '\n',
        stderr: '',
        code: 1,
        timedOut: false,
      }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'no-engine');
  });

  it('error_code reaches the user through both modes (persistent envelope)', async () => {
    const deps = makeDeps({
      transcription: { worker_mode: 'persistent', engine_preference: 'local' },
      persistentFn: async (): Promise<VoiceWorkerOutcome> => ({
        kind: 'envelope',
        envelope: { ok: false, error_code: 'no-engine', error: 'guidance text' },
      }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'no-engine');
  });

  it('truncated:true on the envelope reaches VoiceResult and the dispatched text (spawn)', async () => {
    const deps = makeDeps({
      execFn: async () => okExec({ text: 'partial words', truncated: true }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal((result as any).truncated, true);
    const dispatched = formatTranscriptUserText((result as any).text, { truncated: (result as any).truncated });
    assert.ok(dispatched.includes('cut off at the length limit'));
  });

  it('truncated:true on the envelope reaches VoiceResult and the dispatched text (persistent)', async () => {
    const deps = makeDeps({
      transcription: { worker_mode: 'persistent', engine_preference: 'local' },
      persistentFn: async (): Promise<VoiceWorkerOutcome> => ({
        kind: 'envelope',
        envelope: { ok: true, text: 'partial words', engine: 'groq', truncated: true },
      }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal((result as any).truncated, true);
    const dispatched = formatTranscriptUserText((result as any).text, { truncated: (result as any).truncated });
    assert.ok(dispatched.includes('cut off at the length limit'));
  });

  it('speakers:N on the envelope reaches VoiceResult', async () => {
    const deps = makeDeps({
      execFn: async () => okExec({ text: 'multi speaker text', speakers: 2 }),
    });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal((result as any).speakers, 2);
  });

  it('speakers is undefined on the result when the envelope omits it', async () => {
    const deps = makeDeps({ execFn: async () => okExec({ text: 'plain' }) });
    const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
    assert.equal(result.ok, true);
    assert.equal((result as any).speakers, undefined);
  });

  describe('language plumbing', () => {
    it('the persistent request sends cfg.language, not a hardcoded null', async () => {
      let capturedReq: VoiceWorkerRequest | undefined;
      const deps = makeDeps({
        transcription: { worker_mode: 'persistent', engine_preference: 'local', language: 'fr' },
        persistentFn: async (req: VoiceWorkerRequest): Promise<VoiceWorkerOutcome> => {
          capturedReq = req;
          return { kind: 'envelope', envelope: { ok: true, text: 'bonjour', engine: 'whisper_local', truncated: false } };
        },
      });
      await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
      assert.equal(capturedReq?.language, 'fr');
    });

    it('the persistent request sends null when cfg.language is unset', async () => {
      let capturedReq: VoiceWorkerRequest | undefined;
      const deps = makeDeps({
        transcription: { worker_mode: 'persistent', engine_preference: 'local' },
        persistentFn: async (req: VoiceWorkerRequest): Promise<VoiceWorkerOutcome> => {
          capturedReq = req;
          return { kind: 'envelope', envelope: { ok: true, text: 'hi', engine: 'whisper_local', truncated: false } };
        },
      });
      await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
      assert.equal(capturedReq?.language, null);
    });

    it('the spawn path emits --language via buildBridgeArgs', async () => {
      let capturedArgs: string[] = [];
      const deps = makeDeps({
        transcription: { language: 'de' },
        execFn: async (_cmd: string, args: string[]) => {
          capturedArgs = args;
          return okExec();
        },
      });
      await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
      assert.ok(capturedArgs.includes('--language'));
      assert.equal(capturedArgs[capturedArgs.indexOf('--language') + 1], 'de');
    });
  });

  describe('engineOverride', () => {
    it('reaches buildBridgeArgs on the spawn path', async () => {
      let capturedArgs: string[] = [];
      const deps = makeDeps({
        engineOverride: 'groq',
        execFn: async (_cmd: string, args: string[]) => {
          capturedArgs = args;
          return okExec();
        },
      });
      await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
      assert.equal(capturedArgs[capturedArgs.indexOf('--engine') + 1], 'groq');
    });

    it('reaches the persistent request engine field', async () => {
      let capturedReq: VoiceWorkerRequest | undefined;
      const deps = makeDeps({
        transcription: { worker_mode: 'persistent', engine_preference: 'local' },
        engineOverride: 'openai',
        persistentFn: async (req: VoiceWorkerRequest): Promise<VoiceWorkerOutcome> => {
          capturedReq = req;
          return { kind: 'envelope', envelope: { ok: true, text: 'hi', engine: 'openai', truncated: false } };
        },
      });
      await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
      assert.equal(capturedReq?.engine, 'openai');
    });
  });

  describe('deps.cachedPath', () => {
    it('skips download and mkdir, transcribing the given path directly', async () => {
      let downloadCalls = 0;
      const cachedFile = join(tempDir, 'attachments', String(CHAT_ID), '2026-08-01', 'cached-1.oga');
      const deps = makeDeps({
        cachedPath: cachedFile,
        downloadFileFn: async () => {
          downloadCalls++;
          return true;
        },
        execFn: async () => okExec({ text: 'from cache' }),
      });
      const result = await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
      assert.equal(result.ok, true);
      assert.equal(downloadCalls, 0);
      assert.equal((result as any).audioPath, cachedFile);
      assert.equal((result as any).text, 'from cache');
    });
  });

  describe('kind parameter (ext-aware attachment path)', () => {
    it('defaults to "voice" and produces a .oga path', async () => {
      let capturedArgs: string[] = [];
      const deps = makeDeps({
        execFn: async (_cmd: string, args: string[]) => {
          capturedArgs = args;
          return okExec();
        },
      });
      await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps);
      const audioPathArg = capturedArgs[1];
      assert.ok(audioPathArg.endsWith('.oga'));
    });

    it('an audio attachment with a recognizable file_name produces a matching extension', async () => {
      let capturedArgs: string[] = [];
      const deps = makeDeps({
        execFn: async (_cmd: string, args: string[]) => {
          capturedArgs = args;
          return okExec();
        },
      });
      await transcribeVoiceMessage(
        TOKEN,
        CHAT_ID,
        makeVoice({ file_name: 'song.flac', mime_type: 'audio/flac' }),
        deps,
        'audio'
      );
      const audioPathArg = capturedArgs[1];
      assert.ok(audioPathArg.endsWith('.flac'), audioPathArg);
    });

    it('a video_note attachment produces a .mp4 path', async () => {
      let capturedArgs: string[] = [];
      const deps = makeDeps({
        execFn: async (_cmd: string, args: string[]) => {
          capturedArgs = args;
          return okExec();
        },
      });
      await transcribeVoiceMessage(TOKEN, CHAT_ID, makeVoice(), deps, 'video_note');
      const audioPathArg = capturedArgs[1];
      assert.ok(audioPathArg.endsWith('.mp4'), audioPathArg);
    });
  });
});
