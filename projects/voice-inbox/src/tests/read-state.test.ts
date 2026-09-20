/**
 * Read state and the thread list (thread lifecycle, schema v14, 2026-09-17):
 * the PWA holds NO read marks and derives NO thread status. The server derives
 * the status token (src/thread-status.ts) and records the view time; the client
 * maps the token to a word and a tone, posts a view when it opens an unviewed
 * answer while visible, uploads a device's pre-v14 read marks once, and holds
 * a list re-render while the operator is touching or scrolling. These execute
 * the REAL functions sliced out of public/app.js (the slice-execute idiom)
 * against stubbed document / localStorage / api / window / h, plus source pins
 * for the retired client state.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox
const APP_SRC = readFileSync(join(PKG_ROOT, 'public', 'app.js'), 'utf8');

type AnyFn = (...args: any[]) => any;

/** A top-level `function <name>(` (or `async function`) through the first column-0 `}`. */
function sliceFunction(name: string): string {
  const plain = APP_SRC.indexOf(`\nfunction ${name}(`);
  const asyncAt = APP_SRC.indexOf(`\nasync function ${name}(`);
  const at = plain !== -1 ? plain : asyncAt;
  assert.notEqual(at, -1, `function ${name} not found in public/app.js`);
  const end = APP_SRC.indexOf('\n}', at + 1);
  assert.notEqual(end, -1, `function ${name} has no closing brace`);
  return APP_SRC.slice(at + 1, end + 2);
}

/** A top-level `const <name> = …;` statement (single- or multi-line). */
function sliceConst(name: string): string {
  const match = new RegExp(`\\n(const ${name} = [\\s\\S]*?;)\\n`).exec(APP_SRC);
  assert.ok(match, `const ${name} not found in public/app.js`);
  return match[1];
}

function uploadHarness(apiImpl: AnyFn): { store: Map<string, string>; uploadLegacyReadMarks: AnyFn } {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    removeItem: (k: string) => { store.delete(k); },
  };
  const factory = new Function(
    'localStorage', 'api',
    sliceConst('legacyMarks') + '\n' + sliceFunction('uploadLegacyReadMarks') + '\n; return { uploadLegacyReadMarks };'
  );
  const { uploadLegacyReadMarks } = factory(localStorage, apiImpl) as { uploadLegacyReadMarks: AnyFn };
  return { store, uploadLegacyReadMarks };
}

describe('thread list: the server status token, no client derivation (app.js)', () => {
  it('statusToneClass sorts the eleven tokens into the four tones', () => {
    const { statusToneClass } = new Function(sliceFunction('statusToneClass') + '\n; return { statusToneClass };')() as {
      statusToneClass: AnyFn;
    };
    for (const t of ['needs_you', 'ready']) assert.equal(statusToneClass(t), 'status-attention', t);
    assert.equal(statusToneClass('failed'), 'status-problem');
    for (const t of ['recorded', 'transcribing', 'routed', 'running']) assert.equal(statusToneClass(t), 'status-neutral', t);
    for (const t of ['viewed', 'concluded', 'cancelled', 'done']) assert.equal(statusToneClass(t), 'status-muted', t);
  });

  it('threadStatusWord reads the server token, and the retired read-mark state is gone', () => {
    const slices = [
      sliceConst('STATE_TEXT'),
      sliceConst('UNKNOWN_STATE_TEXT'),
      sliceConst('WAITING_SUBSTATE_TEXT'),
      sliceConst('THREAD_STATUS_TEXT'),
      sliceFunction('phaseFromStep'),
      sliceFunction('stateWord'),
      sliceFunction('threadStatusWord'),
    ].join('\n');
    const { threadStatusWord } = new Function(slices + '\n; return { threadStatusWord };')() as { threadStatusWord: AnyFn };
    assert.equal(threadStatusWord({ status: 'needs_you', state: 'done' }), 'Needs You');
    assert.equal(threadStatusWord({ status: 'ready', state: 'awaiting_input' }), 'Ready', 'the token wins over the newest task state');
    assert.equal(threadStatusWord({ status: null, state: 'running' }), 'Running', 'no token: the newest task word');
    for (const retired of ['\nfunction readMarks(', '\nfunction markRead(', '\nfunction isUnread(', '\nfunction viewedAtMs(',
      '\nfunction donePhase(', '\nconst VIEWED_MS', '\nconst FINISHED_CAP', '\nconst LS_READ', '\nfunction triageEntryRow(', 'finishedOpen']) {
      assert.equal(APP_SRC.includes(retired), false, `retired client state still present: ${retired.trim()}`);
    }
  });

  it('listSignature changes when only the status token, the band or the failure count changes', () => {
    const { listSignature } = new Function('Date', sliceFunction('listSignature') + '\n; return { listSignature };')(
      { now: () => 0 }
    ) as { listSignature: AnyFn };
    const base = {
      conversation_id: 'vi-a1b2c3d4e5f6', state: 'done', updated_at: '2026-09-17T10:00:00.000Z', task_count: 1,
      pending_input_count: 0, result_summary: 'ok', title: 't', recap: 'r', next_action: null, latest_step: null,
      request_text: 'q', latest_request_text: 'q', status: 'viewed', band: 'history', failed_unresolved: 0,
    };
    const sig = listSignature([base]);
    assert.notEqual(listSignature([{ ...base, status: 'concluded' }]), sig);
    assert.notEqual(listSignature([{ ...base, band: 'live' }]), sig);
    assert.notEqual(listSignature([{ ...base, failed_unresolved: 1 }]), sig);
    assert.equal(listSignature([{ ...base }]), sig);
  });

  it('a poll re-render is held only while the operator touched or scrolled recently away from the top', () => {
    const win = { scrollY: 300 };
    const factory = new Function(
      'window',
      [sliceConst('LIST_IDLE_MS'), sliceConst('listHold'), sliceFunction('markListInteraction'), sliceFunction('listRenderHeld')].join('\n') +
        '\n; return { LIST_IDLE_MS, listHold, markListInteraction, listRenderHeld };'
    );
    const held = factory(win) as {
      LIST_IDLE_MS: number;
      listHold: { lastInteractionAt: number };
      markListInteraction: AnyFn;
      listRenderHeld: AnyFn;
    };
    assert.equal(held.LIST_IDLE_MS, 2500);
    assert.equal(held.listRenderHeld(), false, 'no interaction yet');
    held.markListInteraction();
    assert.equal(held.listRenderHeld(), true, 'touched a moment ago, scrolled down');
    win.scrollY = 0;
    assert.equal(held.listRenderHeld(), false, 'at the top a re-render cannot move rows under the finger');
    win.scrollY = 300;
    held.listHold.lastInteractionAt = Date.now() - held.LIST_IDLE_MS - 1;
    assert.equal(held.listRenderHeld(), false, 'idle past LIST_IDLE_MS');
  });

  it('refreshConversations reads the recent view and hands a held render to the idle flush', () => {
    const body = sliceFunction('refreshConversations');
    assert.ok(body.includes("api('/conversations?view=recent')"), body);
    assert.ok(body.includes('listRenderHeld()'), body);
    assert.ok(body.includes('flushHeldListRender()'), body);
    assert.equal(body.includes('too_short'), false, 'the server hides too_short threads');
  });

  it('opening a conversation posts the view and never writes a local read mark', () => {
    const body = sliceFunction('refreshConversation');
    assert.ok(body.includes('postConversationViewed(conv);'), body);
    assert.equal(body.includes('markRead('), false, body);
  });

  it('postConversationViewed posts once per answer, only while visible, only for an unviewed answer', () => {
    const doc = { hidden: false };
    const calls: string[] = [];
    const apiStub = (path: string) => { calls.push(path); return Promise.resolve({ ok: true, changed: true }); };
    const { postConversationViewed } = new Function(
      'document', 'api',
      sliceConst('viewPosts') + '\n' + sliceFunction('postConversationViewed') + '\n; return { postConversationViewed };'
    )(doc, apiStub) as { postConversationViewed: AnyFn };
    const conv = { conversation_id: 'vi-a1b2c3d4e5f6', answer_landed_at: '2026-09-17T10:00:00.000Z', viewed_at: null };
    postConversationViewed(conv);
    postConversationViewed(conv);
    assert.deepEqual(calls, ['/conversations/vi-a1b2c3d4e5f6/viewed']);
    doc.hidden = true;
    postConversationViewed({ ...conv, answer_landed_at: '2026-09-17T11:00:00.000Z' });
    assert.equal(calls.length, 1, 'a hidden page never marks anything');
    doc.hidden = false;
    postConversationViewed({ ...conv, conversation_id: 'vi-000000000002', viewed_at: '2026-09-17T10:30:00.000Z' });
    postConversationViewed({ ...conv, conversation_id: 'vi-000000000003', answer_landed_at: null });
    assert.equal(calls.length, 1, 'already viewed for this answer, or no answer yet');
    postConversationViewed({ ...conv, answer_landed_at: '2026-09-17T11:00:00.000Z' });
    assert.equal(calls.length, 2, 'a new answer posts again');
  });

  it('uploadLegacyReadMarks posts old marks for unviewed answers with the stored open time, then removes the store', async () => {
    const calls: Array<[string, unknown]> = [];
    const harness = uploadHarness(async (path: string, opts: { body: string }) => {
      calls.push([path, JSON.parse(opts.body)]);
      return { ok: true };
    });
    harness.store.set('vi.read', JSON.stringify({
      'vi-000000000001': { seen: '2026-09-16T09:00:00.000Z', at: Date.parse('2026-09-16T09:05:00.000Z') },
      'vi-000000000002': '2026-09-16T08:00:00.000Z',
      'vi-000000000003': { seen: '2026-09-16T07:00:00.000Z', at: Date.parse('2026-09-16T07:10:00.000Z') },
    }));
    await harness.uploadLegacyReadMarks([
      { conversation_id: 'vi-000000000001', answer_landed_at: '2026-09-16T09:00:00.000Z', viewed_at: null },
      { conversation_id: 'vi-000000000002', answer_landed_at: '2026-09-16T07:00:00.000Z', viewed_at: null },
      { conversation_id: 'vi-000000000003', answer_landed_at: '2026-09-16T07:00:00.000Z', viewed_at: '2026-09-16T07:30:00.000Z' },
      { conversation_id: 'vi-000000000004', answer_landed_at: '2026-09-16T07:00:00.000Z', viewed_at: null },
    ]);
    assert.deepEqual(calls, [
      ['/conversations/vi-000000000001/viewed', { at: '2026-09-16T09:05:00.000Z' }],
      ['/conversations/vi-000000000002/viewed', { at: '2026-09-16T08:00:00.000Z' }],
    ]);
    assert.equal(harness.store.has('vi.read'), false);
  });

  it('uploadLegacyReadMarks keeps the store when the network is down', async () => {
    let attempts = 0;
    const harness = uploadHarness(async () => {
      attempts += 1;
      throw Object.assign(new Error('Could not reach the server.'), { status: 0 });
    });
    harness.store.set('vi.read', JSON.stringify({
      'vi-000000000001': { seen: '2026-09-16T09:00:00.000Z', at: Date.parse('2026-09-16T09:05:00.000Z') },
    }));
    await harness.uploadLegacyReadMarks([
      { conversation_id: 'vi-000000000001', answer_landed_at: '2026-09-16T09:00:00.000Z', viewed_at: null },
    ]);
    assert.equal(attempts, 1);
    assert.equal(harness.store.has('vi.read'), true, 'offline: the marks wait for the next load');
  });

  it('failedBulkBar offers Retry all, Cancel all and Select, and names the selection while selecting', () => {
    type Node = { tag: string; attrs: Record<string, any>; children: any[] };
    const el = (tag: string, attrs: Record<string, unknown> | null, ...children: unknown[]): Node =>
      ({ tag, attrs: attrs || {}, children: children.flat() });
    const appState: { failedSelect: Set<string> | null } = { failedSelect: null };
    const retried: string[][] = [];
    const cancelled: string[][] = [];
    let rendered = 0;
    const { failedBulkBar } = new Function(
      'h', 'state', 'retryConversations', 'openCancelThreadsSheet', 'renderListBody',
      sliceConst('TERMINAL_STATUSES') + '\n' + sliceFunction('failedBulkBar') + '\n; return { failedBulkBar };'
    )(
      el, appState,
      (ids: string[]) => { retried.push(ids); },
      (ids: string[]) => { cancelled.push(ids); },
      () => { rendered += 1; }
    ) as { failedBulkBar: AnyFn };
    const labels = (bar: Node): unknown[] => bar.children.map((c: Node) => c.children[0]);
    const bar = failedBulkBar(['vi-a', 'vi-b']) as Node;
    assert.deepEqual(labels(bar), ['2 failed', 'Retry all', 'Cancel all', 'Select']);
    bar.children[1].attrs.onclick();
    bar.children[2].attrs.onclick();
    assert.deepEqual(retried, [['vi-a', 'vi-b']]);
    assert.deepEqual(cancelled, [['vi-a', 'vi-b']]);
    bar.children[3].attrs.onclick();
    assert.ok(appState.failedSelect instanceof Set);
    assert.equal(rendered, 1);
    appState.failedSelect?.add('vi-b');
    const selecting = failedBulkBar(['vi-a', 'vi-b']) as Node;
    assert.deepEqual(labels(selecting), ['1 selected', 'Retry selected', 'Cancel selected', 'Done']);
    selecting.children[1].attrs.onclick();
    assert.deepEqual(retried[1], ['vi-b']);
  });
});
