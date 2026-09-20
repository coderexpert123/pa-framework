/**
 * Bridge-writer tests (AI-201 WP-B, §12 row B): the §7 route-queue.jsonl
 * byte shape (exact keys in the spec's order, id/ts formats) under concurrent
 * appends, and the two §7 injection texts verbatim.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendRouteEntry,
  buildAttachmentsSegment,
  buildAnswerPointerText,
  buildFeedbackFraming,
  buildInboxInjectionText,
  buildTargetInjectionText,
  buildVoiceInboxInjectionText,
  OFFER_LIST_MAX_CHARS,
  OFFER_SEGMENT_HEAD,
  type ConversationRef,
} from '../bridge-writer.js';

// dist/tests -> dist -> projects/voice-inbox (the package root, so
// scripts/task_request.py resolves the same way from the built test file).
const PKG_ROOT_FOR_SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Fixture {
  queuePath: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-bridge-'));
  return { queuePath: join(dir, 'route-queue.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readLines(queuePath: string): unknown[] {
  const raw = readFileSync(queuePath, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('appendRouteEntry', () => {
  it('writes the §7 shape: exact keys in spec order with fresh ids', async () => {
    const fx = makeFixture();
    try {
      const entry = await appendRouteEntry(fx.queuePath, {
        taskId: 'vi-0123456789ab',
        tenantId: 't-424242',
        chatId: -1001234567890,
        threadId: 1040,
        text: 'injection text',
      });
      // Object.keys order = insertion order = the §7 line's key order.
      assert.deepEqual(Object.keys(entry), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id',
      ]);
      assert.match(entry.q_id, /^rq-[0-9a-f]{12}$/);
      assert.match(entry.ref_id, /^s-[0-9a-f]{12}$/);
      assert.doesNotThrow(() => new Date(entry.ts).toISOString());
      assert.equal(entry.ts.endsWith('Z'), true);

      const lines = readLines(fx.queuePath);
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0], {
        q_id: entry.q_id,
        ts: entry.ts,
        task_id: 'vi-0123456789ab',
        tenant_id: 't-424242',
        chat_id: -1001234567890,
        thread_id: 1040,
        text: 'injection text',
        ref_id: entry.ref_id,
      });
    } finally {
      fx.cleanup();
    }
  });

  it('mints a fresh q_id and ref_id per line', async () => {
    const fx = makeFixture();
    try {
      const first = await appendRouteEntry(fx.queuePath, {
        taskId: 'vi-aaaaaaaaaaaa', tenantId: 't-1', chatId: -1, threadId: 1, text: 'one',
      });
      const second = await appendRouteEntry(fx.queuePath, {
        taskId: 'vi-bbbbbbbbbbbb', tenantId: 't-1', chatId: -1, threadId: 1, text: 'two',
      });
      assert.notEqual(first.q_id, second.q_id);
      assert.notEqual(first.ref_id, second.ref_id);
      assert.equal(readLines(fx.queuePath).length, 2);
    } finally {
      fx.cleanup();
    }
  });

  it('survives concurrent appends with no torn lines', async () => {
    const fx = makeFixture();
    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          appendRouteEntry(fx.queuePath, {
            taskId: `vi-${String(i).padStart(12, '0')}`,
            tenantId: 't-1',
            chatId: -1001,
            threadId: i,
            text: `concurrent ${i}`,
          })
        )
      );
      const lines = readLines(fx.queuePath);
      assert.equal(lines.length, 8);
      const ids = new Set(lines.map((l) => (l as { q_id: string }).q_id));
      assert.equal(ids.size, 8);
    } finally {
      fx.cleanup();
    }
  });

  it('survives a lock held externally past one retry budget (AI-237: ELOCKED flake)', async () => {
    const fx = makeFixture();
    try {
      // Simulate a cross-process holder: proper-lockfile's lock resource is
      // the `<file>.lock` DIRECTORY. Holding it makes every acquisition
      // attempt fail ELOCKED until it is removed. Hold it for 2.4s — past the
      // pre-AI-237 retry budget (5 retries ≈ 1.25s of backoff, the config that
      // produced 'Lock file is already being held' in 3 of 5 full-suite runs)
      // but inside the current serialized budget (~3.75s). Under the old code
      // all four appends exhausted retries and rejected with ELOCKED.
      const lockDir = `${fx.queuePath}.lock`;
      mkdirSync(lockDir);
      const appends = Array.from({ length: 4 }, (_, i) =>
        appendRouteEntry(fx.queuePath, {
          taskId: `vi-${String(i).padStart(12, '0')}`,
          tenantId: 't-1',
          chatId: -1001,
          threadId: i,
          text: `blocked ${i}`,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 2_400));
      rmdirSync(lockDir);
      // allSettled, not Promise.all: an early rejection must not leave the
      // sibling appends to reject unhandled after the test settles.
      const settled = await Promise.allSettled(appends);
      assert.deepEqual(
        settled.map((s) => s.status),
        ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
        settled.map((s) => (s.status === 'rejected' ? String(s.reason) : s.status)).join(',')
      );
      assert.equal(readLines(fx.queuePath).length, 4);
    } finally {
      fx.cleanup();
    }
  });
});

describe('§7 injection texts', () => {
  const REPO = '<repo>';

  it('inbox text carries the verbatim shape with the real topic list', () => {
    const text = buildInboxInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'Renew my passport appointment',
      topics: [
        { key: '-1001234567890_0', label: 'General' },
        { key: '-1001234567890_2002', label: 'Errands' },
      ],
      repoRoot: REPO,
    });
    assert.ok(
      text.includes('[Voice inbox task vi-0123456789ab] Request: Renew my passport appointment.'),
      text
    );
    assert.ok(
      text.includes(`python "${REPO}/projects/voice-inbox/scripts/route_task.py" --task vi-0123456789ab`),
      text
    );
    assert.ok(
      text.includes(
        '--topic <chatId>_<threadId> --reason "<one line>" --title "<short noun phrase naming ' +
          'what this is about, at most 60 characters>".'
      ),
      text
    );
    assert.ok(text.includes('Topics: -1001234567890_0=General;-1001234567890_2002=Errands.'));
    assert.ok(text.includes('Do not answer the request here; do not ask the operator anything here.'));
    // Routed-ask loopback (2026-09-14): the route stage must not close the
    // task it just routed — the destination's completion (or the sweep)
    // closes it with the outcome, so the operator's conversation ends with
    // the answer, never a routing receipt.
    assert.ok(
      text.includes(
        'Route it and stop — do not close the asking task: never run task_complete.py for it.'
      ),
      text
    );
    assert.ok(
      text.includes(
        "The operator's conversation must end with the answer, never a routing receipt."
      ),
      text
    );
    assert.ok(
      !text.includes('task_complete.py --task'),
      'the inbox text never teaches the completion verb for the task it routes'
    );
  });

  it('target text carries the verbatim worker-instruction shape', () => {
    const text = buildTargetInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'Renew my passport appointment',
      reason: 'operator reroute',
      repoRoot: REPO,
    });
    assert.ok(
      text.includes('[Voice task vi-0123456789ab routed from inbox — reason: operator reroute]'),
      text
    );
    assert.ok(text.includes('Renew my passport appointment.'));
    assert.ok(
      text.includes(`python "${REPO}/projects/voice-inbox/scripts/task_telemetry.py" start --task vi-0123456789ab`),
      text
    );
    assert.ok(
      text.includes(`python "${REPO}/projects/voice-inbox/scripts/task_input.py" create --help`),
      text
    );
    assert.ok(text.includes('a typed widget, never chat text, never HTML.'));
    assert.ok(
      text.includes(
        'Choose autonomously — never ask which topic (no choice widget, no chat question); ' +
          'if torn, route to the closest match and state the reason.'
      )
    );
    assert.ok(
      text.includes(`python "${REPO}/projects/voice-inbox/scripts/task_complete.py" --task vi-0123456789ab --summary "<the complete answer>"`),
      text
    );
    assert.ok(
      text.includes(
        'The summary is what the operator reads — every substantive detail of the answer, ' +
          'no length trimming; strip only technical narration ' +
          '(tool names, paths, commands, steps).'
      ),
      text
    );
    assert.ok(
      text.includes(
        'Also pass --short "<the verdict, not the reasoning>" — one or two plain ' +
          'sentences an average non-technical user understands, in the product\'s own ' +
          'terms. Never a truncated start; never capped.'
      ),
      text
    );
    assert.ok(
      text.includes(
        'Never narrate internal housekeeping (brain upkeep, claims, gates, telemetry, coordination) — do it silently, or page via pa ping only if the operator must act.'
      ),
      text
    );
    assert.ok(
      text.includes(
        'Format richly for the answer card (it renders markdown): blank line between points, ' +
          '### headings, **bold**, - or 1) lists, pipe tables with a |---| row, code fences, ' +
          '[text](url) or bare links.'
      ),
      text
    );
    // Light/dark theme (2026-09-16): the answer card follows the device's light
    // or dark setting, so a custom-HTML answer must not fix its own colours.
    // Pinned with its neighbours so the clause cannot drift out of the format
    // guidance.
    assert.ok(
      text.includes('[text](url) or bare links. Never hard-code colours in HTML. Keep the conversation'),
      text
    );
    // AI-234: the --suggest quick-reply-chip teaching sits in the
    // task_complete.py tail, byte-synced to route_task.py's
    // TARGET_INJECTION_TEMPLATE (the sync-twins test pins the pair).
    assert.ok(
      text.includes(
        'Pass --suggest "<plain follow-up>" repeatable (0..4), ≤40 chars each, ' +
          'plain words only; non-plain entries dropped. Omit when nothing natural follows.'
      ),
      text
    );
  });
});

describe('buildVoiceInboxInjectionText', () => {
  const REPO = '<repo>';
  // A backslashed Windows path — the text must render it forward-slashed.
  const BACKSLASH_AUDIO = 'C:\\Users\\user\\AppData\\Local\\Temp\\vi\\files\\vi-0123456789ab\\audio.webm';
  const SLASH_AUDIO = 'C:/Users/user/AppData/Local/Temp/vi/files/vi-0123456789ab/audio.webm';

  it('carries the read-clean-route instruction set with the forward-slashed audio path', () => {
    const text = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab',
      audioPath: BACKSLASH_AUDIO,
      topics: [
        { key: '-1001234567890_0', label: 'General' },
        { key: '-1001234567890_2002', label: 'Errands' },
      ],
      repoRoot: REPO,
    });
    assert.ok(
      text.includes(
        `[Voice inbox task vi-0123456789ab] A voice recording is saved at ${SLASH_AUDIO}.`
      ),
      text
    );
    assert.ok(text.includes('never transcribe it yourself and never run task_transcribe.py.'), text);
    assert.ok(
      text.includes(`python "${REPO}/projects/voice-inbox/scripts/task_request.py" show --task vi-0123456789ab `),
      text
    );
    assert.ok(
      text.includes(
        `python "${REPO}/projects/voice-inbox/scripts/task_request.py" clean --task vi-0123456789ab --text "<cleaned request>"`
      ),
      text
    );
    assert.ok(text.includes('If state is not received, stop here'), text);
    assert.ok(text.includes('cleanup, never authorship:'), text);
    assert.ok(text.includes('never add intent, never answer the request, never widen or narrow its scope'), text);
    assert.ok(text.includes('if clean fails, skip it and route anyway.'), text);
    assert.equal(text.includes('transcribe_voice.py'), false, text);
    assert.equal(text.includes('task_transcribe.py" --task'), false, text);
    assert.ok(text.indexOf(' show --task ') < text.indexOf(' clean --task '), text);
    assert.ok(text.indexOf(' clean --task ') < text.indexOf('route_task.py" --task'), text);
    assert.ok(
      text.includes(
        `python "${REPO}/projects/voice-inbox/scripts/route_task.py" --task vi-0123456789ab --topic <chatId>_<threadId> --reason "<one line>"`
      ),
      text
    );
    assert.ok(text.includes('Topics: -1001234567890_0=General;-1001234567890_2002=Errands.'), text);
    assert.ok(
      text.includes(
        'Choose autonomously — never ask which topic (no choice widget, no chat question); ' +
          'if torn, route to the closest match and state the reason.'
      ),
      text
    );
    // The autonomy rule must sit with the routing instruction, before the
    // do-not-answer closing line.
    assert.ok(
      text.indexOf('Choose autonomously') < text.indexOf('Do not answer the request here'),
      text
    );
    assert.ok(text.includes('Do not answer the request here; do not ask the operator anything here.'), text);
    // Routed-ask loopback (2026-09-14): same no-close teaching on the voice
    // path — the route stage leaves the task open for the destination.
    assert.ok(
      text.includes(
        'Route it and stop — do not close the asking task: never run task_complete.py for it.'
      ),
      text
    );
    assert.ok(
      text.includes(
        "The operator's conversation must end with the answer, never a routing receipt."
      ),
      text
    );
    assert.ok(
      !text.includes('task_complete.py --task'),
      'the inbox text never teaches the completion verb for the task it routes'
    );
  });

  it('the task_request.py subcommands the voice inbox text names exist in the script', () => {
    const py = readFileSync(join(PKG_ROOT_FOR_SCRIPTS, 'scripts', 'task_request.py'), 'utf8');
    assert.ok(py.includes('add_parser("show"'), 'task_request.py must define the show subcommand');
    assert.ok(py.includes('add_parser("clean"'), 'task_request.py must define the clean subcommand');
    assert.ok(py.includes('"--text"'), 'task_request.py must define --text');
  });
});

describe('conversation segments (§4 of the 2026-09-08 redesign spec)', () => {
  const REPO = '<repo>';

  it('continuationSegment: topic-known wording is verbatim and suppresses the open-conversations menu', () => {
    const text = buildInboxInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'follow up please',
      topics: [{ key: '-1001234567890_0', label: 'General' }],
      repoRoot: REPO,
      continuation: { conversationId: 'vi-aaaaaaaaaaaa', topicKey: '-1001234567890_2002' },
      openConversations: [{ taskId: 'vi-333333333333', snippet: 'should not appear' }],
    });
    assert.ok(
      text.includes(
        'This task continues conversation vi-aaaaaaaaaaaa. Route it to topic -1001234567890_2002 — ' +
          'pass --topic -1001234567890_2002 --continues vi-aaaaaaaaaaaa to route_task.py and pick no other topic. '
      ),
      text
    );
    assert.equal(text.includes(OFFER_SEGMENT_HEAD), false);
    assert.equal(text.includes('should not appear'), false);
  });

  it('continuationSegment: topic-unknown wording is verbatim', () => {
    const text = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab',
      audioPath: '/tmp/audio.webm',
      topics: [],
      repoRoot: REPO,
      continuation: { conversationId: 'vi-aaaaaaaaaaaa', topicKey: null },
    });
    assert.ok(
      text.includes(
        'This task continues conversation vi-aaaaaaaaaaaa — pass --continues vi-aaaaaaaaaaaa to route_task.py. '
      ),
      text
    );
    assert.equal(text.includes(OFFER_SEGMENT_HEAD), false);
  });

  it('conversationsSegment: an empty list renders no segment', () => {
    const text = buildInboxInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'a fresh request',
      topics: [],
      repoRoot: REPO,
      openConversations: [],
    });
    assert.equal(text.includes(OFFER_SEGMENT_HEAD), false);
  });

  it('conversationsSegment: renders id=snippet entries with the continue, cancelled and when-unsure rules', () => {
    const text = buildInboxInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'a fresh request',
      topics: [],
      repoRoot: REPO,
      openConversations: [
        { taskId: 'vi-111111111111', snippet: 'file the report (updated 2 minutes ago) [Running]' },
        { taskId: 'vi-222222222222', snippet: 'email finance (updated 3 hours ago) [Cancelled]' },
      ],
    });
    assert.ok(
      text.includes(
        OFFER_SEGMENT_HEAD +
          'vi-111111111111=file the report (updated 2 minutes ago) [Running];vi-222222222222=email finance (updated 3 hours ago) [Cancelled]. ' +
          'If this request clearly continues one of them, add --continues <that conversation id> ' +
          'to the route_task.py command; otherwise omit the flag. ' +
          'A conversation marked [Cancelled] is context only: never pass --continues for it. ' +
          'When unsure, omit --continues so the request starts a new conversation. '
      ),
      text
    );
    assert.equal(text.includes('more recent conversation'), false, text);
  });

  it('conversationsSegment: fills whole entries newest first under OFFER_LIST_MAX_CHARS and names the rest', () => {
    const entries: ConversationRef[] = Array.from({ length: 60 }, (_, i) => ({
      taskId: `vi-${String(i).padStart(12, '0')}`,
      snippet: `${'s'.repeat(60)} (updated 23 hours ago) [Transcribing]`,
    }));
    const text = buildInboxInjectionText({
      taskId: 'vi-0123456789ab', requestText: 'r', topics: [], repoRoot: REPO, openConversations: entries,
    });
    const start = text.indexOf(OFFER_SEGMENT_HEAD) + OFFER_SEGMENT_HEAD.length;
    const list = text.slice(start, text.indexOf('. ', start));
    assert.ok(list.length <= OFFER_LIST_MAX_CHARS, `offer list is ${list.length} chars`);
    const listed = list.split(';');
    assert.equal(listed.length, 34, 'measured: 34 maximum-length entries fit in 4,000 chars');
    assert.ok(listed.every((e, i) => e === `${entries[i].taskId}=${entries[i].snippet}`), 'whole entries, newest first, no gaps');
    assert.ok(text.includes('(and 26 more recent conversations are not listed) '), text);
  });
});

describe('appendRouteEntry — optional verb fields (§4)', () => {
  it('omits kind/worker_resource entirely when not supplied', async () => {
    const fx = makeFixture();
    try {
      const entry = await appendRouteEntry(fx.queuePath, {
        taskId: 'vi-0123456789ab',
        tenantId: 't-1',
        chatId: -1,
        threadId: 1,
        text: 'plain route',
      });
      assert.deepEqual(Object.keys(entry), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id',
      ]);
      assert.equal('kind' in entry, false);
      assert.equal('worker_resource' in entry, false);
      assert.equal('worker_dispatch_id' in entry, false);
    } finally {
      fx.cleanup();
    }
  });

  it('appends kind/worker_resource after ref_id, in that order, when supplied — never as null', async () => {
    const fx = makeFixture();
    try {
      const entry = await appendRouteEntry(fx.queuePath, {
        taskId: 'vi-0123456789ab',
        tenantId: 't-1',
        chatId: -1001234567890,
        threadId: 2002,
        text: '[Voice inbox task vi-0123456789ab cancelled by the operator]',
        kind: 'cancel',
        workerResource: 'topic--1001234567890_2002-th1',
      });
      assert.deepEqual(Object.keys(entry), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id', 'kind', 'worker_resource',
      ]);
      assert.equal(entry.kind, 'cancel');
      assert.equal(entry.worker_resource, 'topic--1001234567890_2002-th1');
      assert.equal('worker_dispatch_id' in entry, false);
      const lines = readLines(fx.queuePath);
      assert.deepEqual(Object.keys(lines[0] as Record<string, unknown>), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id', 'kind', 'worker_resource',
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it('appends worker_dispatch_id last when supplied alongside worker_resource (11-key order)', async () => {
    const fx = makeFixture();
    try {
      const entry = await appendRouteEntry(fx.queuePath, {
        taskId: 'vi-0123456789ab',
        tenantId: 't-1',
        chatId: -1001234567890,
        threadId: 2002,
        text: '[Voice inbox task vi-0123456789ab cancelled by the operator]',
        kind: 'cancel',
        workerResource: 'topic--1001234567890_2002-th1',
        workerDispatchId: 'a1b2c3d4e5f6',
      });
      assert.deepEqual(Object.keys(entry), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id',
        'kind', 'worker_resource', 'worker_dispatch_id',
      ]);
      assert.equal(entry.worker_dispatch_id, 'a1b2c3d4e5f6');
      const lines = readLines(fx.queuePath);
      assert.deepEqual(Object.keys(lines[0] as Record<string, unknown>), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id',
        'kind', 'worker_resource', 'worker_dispatch_id',
      ]);
    } finally {
      fx.cleanup();
    }
  });
});

describe('appendRouteEntry — steer entries (auth broker)', () => {
  const AUTH_SENTENCE =
    'If a tool needs authorization (a URL, code, key, password, or a yes/no you cannot ' +
    'answer): pa auth request with the shape, pa auth wait, then re-run non-interactively — ' +
    'never stall or ask in chat. ';

  it('a steer append yields exactly the 11 keys in order', async () => {
    const fx = makeFixture();
    try {
      const entry = await appendRouteEntry(fx.queuePath, {
        taskId: 'vi-0123456789ab',
        tenantId: 't-1',
        chatId: -1001234567890,
        threadId: 29,
        text: 'answer-resume steer text',
        kind: 'steer',
        steerMode: 'queue',
        steerConversation: 'vi-0123456789ab',
      });
      assert.deepEqual(Object.keys(entry), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id',
        'kind', 'steer_mode', 'steer_conversation',
      ]);
      assert.equal(entry.kind, 'steer');
      assert.equal(entry.steer_mode, 'queue');
      assert.equal(entry.steer_conversation, 'vi-0123456789ab');
      const lines = readLines(fx.queuePath);
      assert.deepEqual(Object.keys(lines[0] as Record<string, unknown>), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id',
        'kind', 'steer_mode', 'steer_conversation',
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it('buildTargetInjectionText contains the §3.7(a) authorization sentence exactly once', () => {
    const text = buildTargetInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'Renew my passport appointment',
      reason: 'operator reroute',
      repoRoot: '<repo>',
    });
    assert.ok(text.includes(AUTH_SENTENCE), text);
    const occurrences = text.split(AUTH_SENTENCE).length - 1;
    assert.equal(occurrences, 1);
  });

  it('buildAnswerPointerText renders the exact sentence', () => {
    const text = buildAnswerPointerText({ requestId: 'ir-0123456789ab', answerPointer: '/tmp/x/ir-0123456789ab.txt' });
    assert.equal(
      text,
      'Answer for ir-0123456789ab is at /tmp/x/ir-0123456789ab.txt — read it; never repeat its value in chat.'
    );
  });
});

describe('injection texts — conversation summary flags (AI-222)', () => {
  const REPO = '<repo>';
  const SUMMARY_SEGMENT =
    "Keep the conversation's three summary lines current: pass --title (a short noun phrase " +
    'for the conversation, at most 60 characters, never a transcription of ' +
    'the request), --recap (one or two plain sentences on what is happening and where it ' +
    "stands) and --next (one line for the operator's next step, omitted when there is " +
    'nothing) to task_complete.py, and the same three flags to task_input.py ' +
    'create whenever you ask a question.';
  const TITLE_FLAG =
    '--title "<short noun phrase naming what this is about, at most 60 characters>"';

  it('buildTargetInjectionText contains the AI-222 segment exactly once', () => {
    const text = buildTargetInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'Renew my passport appointment',
      reason: 'operator reroute',
      repoRoot: REPO,
    });
    assert.ok(text.includes(SUMMARY_SEGMENT), text);
    assert.equal(text.split(SUMMARY_SEGMENT).length - 1, 1, text);
    // AI-234: the --suggest teaching now trails the AI-222 segment; the
    // --structured teaching (P1) closes the text.
    assert.ok(text.includes('Omit when nothing natural follows.'), text);
    assert.ok(
      text.endsWith('For comparison/listing/guide/form-set/summary answers, pass --structured <json> (task_complete.py --help). '),
      text
    );
  });

  it('both inbox builders carry the --title flag exactly once each, byte-identical', () => {
    const topics = [{ key: '-1001234567890_0', label: 'General' }];
    const inboxText = buildInboxInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'a fresh request',
      topics,
      repoRoot: REPO,
    });
    const voiceText = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab',
      audioPath: '/tmp/audio.webm',
      topics,
      repoRoot: REPO,
    });
    for (const text of [inboxText, voiceText]) {
      assert.ok(text.includes(TITLE_FLAG), text);
      assert.equal(text.split(TITLE_FLAG).length - 1, 1, text);
    }
  });
});

describe('target injection text — conversation briefing slot (2026-09-10)', () => {
  const REPO = '<repo>';
  const BASE_INPUT = {
    taskId: 'vi-0123456789ab',
    requestText: 'Renew my passport appointment',
    reason: 'operator reroute',
    repoRoot: REPO,
  };

  it('superset invariant: an absent briefing renders byte-identically to an empty one', () => {
    const withoutField = buildTargetInjectionText(BASE_INPUT);
    const withEmpty = buildTargetInjectionText({ ...BASE_INPUT, conversationBriefing: '' });
    assert.equal(withoutField, withEmpty);
  });

  it('superset invariant: an absent feedback renders byte-identically to an undefined one', () => {
    const target = buildTargetInjectionText(BASE_INPUT);
    assert.equal(target, buildTargetInjectionText({ ...BASE_INPUT, feedback: undefined }));
    const topics = [{ key: '-1001234567890_0', label: 'General' }];
    const inbox = buildInboxInjectionText({
      taskId: 'vi-0123456789ab', requestText: 'Renew my passport appointment', topics, repoRoot: REPO,
    });
    assert.equal(
      inbox,
      buildInboxInjectionText({
        taskId: 'vi-0123456789ab', requestText: 'Renew my passport appointment', topics, repoRoot: REPO,
        feedback: undefined,
      })
    );
    const voice = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab', audioPath: '/tmp/audio.webm', topics, repoRoot: REPO,
    });
    assert.equal(
      voice,
      buildVoiceInboxInjectionText({
        taskId: 'vi-0123456789ab', audioPath: '/tmp/audio.webm', topics, repoRoot: REPO,
        feedback: undefined,
      })
    );
  });

  it('a supplied briefing renders once, between the routing header and the request text', () => {
    const text = buildTargetInjectionText({ ...BASE_INPUT, conversationBriefing: 'B\n' });
    const needle = '] B\nRenew my passport appointment. ';
    assert.ok(text.includes(needle), text);
    assert.equal(text.split(needle).length - 1, 1, text);
  });

  it('a briefing does not disturb the trailing --suggest sentence (AI-234)', () => {
    const text = buildTargetInjectionText({ ...BASE_INPUT, conversationBriefing: 'B\n' });
    assert.ok(text.includes('Omit when nothing natural follows.'), text);
    assert.ok(
      text.endsWith('For comparison/listing/guide/form-set/summary answers, pass --structured <json> (task_complete.py --help). '),
      text
    );
  });

  it('both inbox builders render a supplied conversationBriefing exactly once, and nothing extra when omitted', () => {
    const topics = [{ key: '-1001234567890_0', label: 'General' }];
    const inboxWithBriefing = buildInboxInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'a fresh request',
      topics,
      repoRoot: REPO,
      conversationBriefing: 'B\n',
    });
    const voiceWithBriefing = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab',
      audioPath: '/tmp/audio.webm',
      topics,
      repoRoot: REPO,
      conversationBriefing: 'B\n',
    });
    for (const text of [inboxWithBriefing, voiceWithBriefing]) {
      assert.ok(text.includes('B\n'), text);
      assert.equal(text.split('B\n').length - 1, 1, text);
    }

    const inboxWithout = buildInboxInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'a fresh request',
      topics,
      repoRoot: REPO,
    });
    const voiceWithout = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab',
      audioPath: '/tmp/audio.webm',
      topics,
      repoRoot: REPO,
    });
    assert.equal(inboxWithout.includes('B\n'), false, inboxWithout);
    assert.equal(voiceWithout.includes('B\n'), false, voiceWithout);
  });
});

describe('feedback framing (2026-09-13)', () => {
  const REPO = '<repo>';
  const SURFACE =
    'This task arrives from the voice-inbox app (our own PWA, fully ours — ' +
    'long-press menus, custom sheets and inline widgets all possible); design UI ' +
    "answers for that surface, not Telegram's Bot-API constraints. ";
  const topics = [{ key: '-1001234567890_0', label: 'General' }];
  const BASE_INPUT_ORIGINAL = {
    taskId: 'vi-0123456789ab',
    requestText: 'Renew my passport appointment',
    reason: 'operator reroute',
    repoRoot: REPO,
  };

  it('buildFeedbackFraming renders the pinned conversation/task/title vectors', () => {
    assert.equal(
      buildFeedbackFraming({ about: 'vi-abcdef123456', title: 'Strava caption', level: 'conversation', conversationId: 'vi-abcdef123456' }),
      '(operator feedback about voice-inbox conversation vi-abcdef123456, "Strava caption")'
    );
    assert.equal(
      buildFeedbackFraming({ about: 'vi-abcdef123456', title: null, level: 'conversation', conversationId: 'vi-abcdef123456' }),
      '(operator feedback about voice-inbox conversation vi-abcdef123456)'
    );
    assert.equal(
      buildFeedbackFraming({ about: 'vi-0123456789ab', title: 'Say "hi" <again>', level: 'task', conversationId: 'vi-fedcba987654' }),
      '(operator feedback about voice-inbox task vi-0123456789ab, "Say \'hi\' <again>")'
    );
  });

  it('buildTargetInjectionText renders the framing + one space between the routing header and the request', () => {
    const text = buildTargetInjectionText({
      ...BASE_INPUT_ORIGINAL,
      feedback: { about: 'vi-abcdef123456', title: 'Strava caption', level: 'task', conversationId: 'vi-fedcba987654' },
    });
    const needle =
      '] (operator feedback about voice-inbox task vi-abcdef123456, "Strava caption") ' +
      'Renew my passport appointment. This task arrives';
    assert.ok(text.includes(needle), text);
    assert.equal(text.split(SURFACE).length - 1, 1, text);
  });

  it('all four builders carry the surface sentence exactly once, unconditionally, with NO feedback', () => {
    const target = buildTargetInjectionText(BASE_INPUT_ORIGINAL);
    const inbox = buildInboxInjectionText({
      taskId: 'vi-0123456789ab', requestText: 'Renew my passport appointment', topics, repoRoot: REPO,
    });
    const voice = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab', audioPath: '/tmp/audio.webm', topics, repoRoot: REPO,
    });
    const targetWithBriefing = buildTargetInjectionText({
      ...BASE_INPUT_ORIGINAL, conversationBriefing: 'B\n',
    });
    for (const text of [target, inbox, voice, targetWithBriefing]) {
      assert.equal(text.split(SURFACE).length - 1, 1, text);
    }
  });

  it('a feedback inbox text with an empty open-conversations list renders no menu segment', () => {
    const text = buildInboxInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'the caption is too long',
      topics,
      repoRoot: REPO,
      openConversations: [],
      feedback: { about: 'vi-abcdef123456', title: 'Strava caption', level: 'conversation', conversationId: 'vi-abcdef123456' },
    });
    assert.equal(text.includes(OFFER_SEGMENT_HEAD), false, text);
    assert.ok(
      text.includes('(operator feedback about voice-inbox conversation vi-abcdef123456, "Strava caption") '),
      text
    );
  });

  it('known-bad: the bracketed-form regex discriminates a real framing render from a bracketed twin', () => {
    const text = buildTargetInjectionText({
      ...BASE_INPUT_ORIGINAL,
      feedback: { about: 'vi-abcdef123456', title: 'T', level: 'conversation', conversationId: 'vi-abcdef123456' },
    });
    const paren = '(operator feedback about voice-inbox conversation vi-abcdef123456, "T")';
    // The real render: parenthesized framing present, bracketed form absent.
    assert.ok(text.includes(paren), text);
    assert.equal(
      /\[Voice[^\]\n]*vi-[0-9a-f]{12}[^\]\n]*operator feedback/i.test(text),
      false,
      text
    );
    // The deliberately bracketed twin MUST match the same regex — proving the
    // negative assertion above can actually fail (a check seen to fail).
    const bracketed = text.replace(paren, '[Voice task vi-abcdef123456 operator feedback]');
    assert.equal(
      /\[Voice[^\]\n]*vi-[0-9a-f]{12}[^\]\n]*operator feedback/i.test(bracketed),
      true,
      bracketed
    );
  });
});

describe('attachments segment (task attachments, 2026-09-13)', () => {
  const REPO = '<repo>';
  const SEGMENT =
    'Attachments (2): D:/x/a.png; D:/x/b.mp4. Open them from disk when the task needs them; ' +
    'audio or video attachments can be transcribed with transcribe_voice.py. ';
  const topics = [{ key: '-1001234567890_0', label: 'General' }];

  it('target text carries the segment exactly once, after the request and before the surface line', () => {
    const text = buildTargetInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'Renew my passport appointment',
      reason: 'operator reroute',
      repoRoot: REPO,
      attachments: ['D:/x/a.png', 'D:/x/b.mp4'],
    });
    const needle = 'Renew my passport appointment. ' + SEGMENT + 'This task arrives';
    assert.ok(text.includes(needle), text);
    assert.equal(text.split(SEGMENT).length - 1, 1, text);
  });

  it('target text: absent attachments render byte-identically to an empty list', () => {
    const base = {
      taskId: 'vi-0123456789ab',
      requestText: 'Renew my passport appointment',
      reason: 'operator reroute',
      repoRoot: REPO,
    };
    assert.equal(
      buildTargetInjectionText(base),
      buildTargetInjectionText({ ...base, attachments: [] })
    );
    assert.equal(buildTargetInjectionText(base).includes('Attachments ('), false);
  });

  it('inbox text carries the segment right after the Request sentence', () => {
    const text = buildInboxInjectionText({
      taskId: 'vi-0123456789ab',
      requestText: 'a fresh request',
      topics,
      repoRoot: REPO,
      attachments: ['D:/x/a.png', 'D:/x/b.mp4'],
    });
    assert.ok(text.includes('Request: a fresh request. ' + SEGMENT), text);
  });

  it('voice inbox text carries the segment right after the saved-at sentence', () => {
    const text = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab',
      audioPath: 'C:\\tmp\\vi\\files\\vi-0123456789ab\\audio.webm',
      topics,
      repoRoot: REPO,
      attachments: ['D:/x/a.png'],
    });
    assert.ok(
      text.includes(
        'A voice recording is saved at C:/tmp/vi/files/vi-0123456789ab/audio.webm. ' +
          'Attachments (1): D:/x/a.png. Open them from disk'
      ),
      text
    );
  });

  it('both inbox builders render nothing extra when attachments are omitted', () => {
    const inbox = buildInboxInjectionText({
      taskId: 'vi-0123456789ab', requestText: 'a fresh request', topics, repoRoot: REPO,
    });
    const voice = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab', audioPath: '/tmp/audio.webm', topics, repoRoot: REPO,
    });
    assert.equal(inbox.includes('Attachments ('), false, inbox);
    assert.equal(voice.includes('Attachments ('), false, voice);
  });
});

// WP-3a routing-injection rule (A6, 2026-09-16): a routing thread that posts
// progress via task_telemetry.py before ever calling route_task.py locks
// itself out of routing (task_telemetry.py's first progress post moves
// received/routed -> running, and route_task.py refuses anything else) — the
// live incident is vi-d79c09c5eb37, a voice task that never routed. Both
// inbox builders now carry one mandatory-routing sentence, in the house
// voice, immediately after their route_task.py instruction.
describe('WP-3a routing-injection rule (A6)', () => {
  const REPO = '<repo>';
  const topics = [
    { key: '-1001234567890_0', label: 'General' },
    { key: '-1001234567890_2002', label: 'Errands' },
  ];

  it('the routing-is-mandatory sentence sits after the route_task.py instruction in both inbox builders', () => {
    const inbox = buildInboxInjectionText({
      taskId: 'vi-0123456789ab', requestText: 'a fresh request', topics, repoRoot: REPO,
    });
    assert.ok(inbox.includes('post no progress until the task is routed.'), inbox);
    assert.ok(
      inbox.indexOf('route_task.py" --task') < inbox.indexOf('Routing is mandatory before you end this turn'),
      inbox
    );
    // buildInboxInjectionText is the TYPED-task builder: it has no transcript
    // and no cleanup step, so the raw-transcript fallback clause (voice-only)
    // must not appear here — it would misdirect the model.
    assert.equal(inbox.includes('route with the raw transcript'), false, inbox);

    const voice = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab', audioPath: '/tmp/audio.webm', topics, repoRoot: REPO,
    });
    assert.ok(voice.includes('post no progress until the task is routed.'), voice);
    assert.ok(
      voice.indexOf('route_task.py" --task') < voice.indexOf('Routing is mandatory before you end this turn'),
      voice
    );
    // The raw-transcript fallback clause is voice-only: it belongs after the
    // route-before-progress clause and before the default-topic clause.
    assert.ok(
      voice.indexOf('Routing is mandatory before you end this turn') <
        voice.indexOf('route with the raw transcript'),
      voice
    );
    assert.ok(
      voice.indexOf('route with the raw transcript') < voice.indexOf('If you are unsure where to route'),
      voice
    );
  });

  // Budget evidence (2026-09-16): the bot's steer path (voice-inbox-steer.ts,
  // STEER_MESSAGE_MAX = 4000) gates only `kind:"steer"`/`kind:"cancel"`
  // route-queue entries via handleSteer (see voice-inbox-bridge.ts's steer
  // pass, which runs BEFORE the plain-entry injection loop and only touches
  // entries with entry.kind === 'steer'). Both inbox builders under test here
  // write PLAIN entries (no `kind` field): voice-inbox-bridge.ts's injection
  // loop (the `if (entry.kind === 'cancel') { ...; continue; }` branch,
  // immediately followed by the unconditional injectFn() call for every
  // remaining entry) injects entry.text verbatim into a synthetic Telegram
  // update and never calls handleSteer/orchestrator.ts/voice-inbox-steer.ts
  // for it. So STEER_MESSAGE_MAX does NOT gate the inbox delivery path —
  // confirmed empirically too: a realistic (not even extreme) render of
  // buildVoiceInboxInjectionText with 3 topics, 8 open conversations, 3
  // attachments and a 283-char request already measures 4037 chars, over
  // 4000, with no existing cap catching it. INBOX_STRESS_BUDGET below is
  // therefore a self-imposed regression guard against runaway growth, not
  // evidence of an enforced limit. With the stress inputs below (100
  // attachments — config.ts's maxTaskAttachments enforceable ceiling — a long
  // request, and a 60-entry maximum-length 24-hour offer list, 2026-09-17) the
  // real render measures 14,692 (typed) / 15,271 (voice) chars: the offer list
  // is bounded by its own OFFER_LIST_MAX_CHARS (4,000; 34 of the 60 entries
  // fit), without which the voice render would be ~18.2k. The budget keeps
  // headroom over that value so it still catches an accidental blow-up (e.g.
  // a duplicated segment) without flagging normal growth.
  const INBOX_STRESS_BUDGET = 16000;

  it('a stress render of both inbox builders (long request, max attachments, a 60-entry 24-hour offer list) stays under the self-imposed regression budget', () => {
    const longRequest = (
      'Please help me sort out the renewal for the car insurance policy, the home wifi router ' +
      'that keeps dropping connection every evening around dinner time, and also follow up with ' +
      'the contractor about the kitchen tiles delivery that was supposed to arrive last week but ' +
      'never showed up, and check whether the plumber ever confirmed the appointment for the ' +
      'leaking pipe under the kitchen sink, and remind me to call the insurance agent back too. '
    ).repeat(2);
    const attachments = Array.from(
      { length: 100 },
      (_, i) => `C:/Users/user/AppData/Local/Temp/vi/files/vi-0123456789ab/attachment-${String(i).padStart(3, '0')}-name.png`
    );
    const openConversations: ConversationRef[] = Array.from({ length: 60 }, (_, i) => ({
      taskId: `vi-${String(i).padStart(12, '0')}`,
      snippet: `${'Some open conversation about a household task number '.padEnd(60, 'x')} (updated 23 hours ago) [Transcribing]`,
    }));
    const inbox = buildInboxInjectionText({
      taskId: 'vi-0123456789ab', requestText: longRequest, topics, repoRoot: REPO, openConversations, attachments,
    });
    const voice = buildVoiceInboxInjectionText({
      taskId: 'vi-0123456789ab',
      audioPath: 'C:/Users/user/AppData/Local/Temp/vi/files/vi-0123456789ab/audio.webm',
      topics, repoRoot: REPO, openConversations, attachments,
    });
    assert.ok(
      inbox.length < INBOX_STRESS_BUDGET,
      `inbox stress render is ${inbox.length} chars, over the ${INBOX_STRESS_BUDGET}-char regression budget`
    );
    assert.ok(
      voice.length < INBOX_STRESS_BUDGET,
      `voice stress render is ${voice.length} chars, over the ${INBOX_STRESS_BUDGET}-char regression budget`
    );
  });
});
