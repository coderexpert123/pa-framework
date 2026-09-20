/**
 * Cleaned request_text display (voice transcription latency wave, WP-3b,
 * 2026-09-16): the operator's turn shows the routing worker's cleaned
 * request_text (task_request.py clean) over the raw transcript, with the raw
 * words reachable behind a "Your exact words" disclosure when the two
 * differ. Both render-signature guards must include request_text so a
 * cleanup-only write (no other field change) still re-renders.
 *
 * No DOM harness in this suite: turnText/hasDistinctOriginal/
 * conversationSignature/listSignature are sliced verbatim out of
 * public/app.js with the read-state.test.ts slice-execute idiom and executed
 * directly. The disclosure-ordering check reads the renderTurnContent source
 * slice as text — no functions in the real app are duplicated in this file.
 *
 * The escaping test below additionally slices the real h() and
 * hasDistinctOriginal alongside originalWordsNodes and runs them against a
 * minimal createElement/setAttribute/innerHTML recorder — the
 * answer-shapes.test.ts renderRawHtmlBlock pattern — so a future change that
 * routes the transcript through innerHTML instead of a text-node child is
 * caught here rather than only visually.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} not found in public/app.js`);
  const end = src.indexOf('\n}', start);
  assert.ok(end !== -1, `function ${name}'s closing brace not found in public/app.js`);
  return src.slice(start, end + 2);
}

function makeHarness() {
  const appSrc = readFileSync(join(PKG_ROOT, 'public', 'app.js'), 'utf8');
  const slices = ['turnText', 'hasDistinctOriginal', 'conversationSignature', 'listSignature']
    .map((name) => sliceFunction(appSrc, name))
    .join('\n');
  const factory = new Function(
    slices + '\n; return { turnText, hasDistinctOriginal, conversationSignature, listSignature };'
  );
  return factory() as {
    turnText: (task: unknown) => string;
    hasDistinctOriginal: (task: unknown) => boolean;
    conversationSignature: (conv: unknown) => string;
    listSignature: (conversations: unknown[]) => string;
  };
}

function renderTurnContentSlice(): string {
  const appSrc = readFileSync(join(PKG_ROOT, 'public', 'app.js'), 'utf8');
  return sliceFunction(appSrc, 'renderTurnContent');
}

interface RecorderNode {
  tagName?: string;
  nodeType?: number;
  data?: string;
  attrs: Record<string, string>;
  className: string;
  children: RecorderNode[];
  listeners: Record<string, (...args: unknown[]) => unknown>;
  setAttribute(k: string, v: string): void;
  addEventListener(type: string, fn: (...args: unknown[]) => unknown): void;
  append(...nodes: RecorderNode[]): void;
  innerHTML: string;
  hidden: boolean;
}

/** Builds originalWordsNodes' real output against a fake document that
 *  records exactly what DOM mutation happened — an element/text-node tree
 *  via append(), or a raw innerHTML assignment. h() and hasDistinctOriginal
 *  are sliced alongside it (both are free variables inside
 *  originalWordsNodes); state is faked with a real Set so the toggle button
 *  wires the same way it does in the app. */
function buildOriginalWordsNodes(task: Record<string, unknown>): { nodes: RecorderNode[]; innerHTMLWrites: number } {
  const appSrc = readFileSync(join(PKG_ROOT, 'public', 'app.js'), 'utf8');
  const slice = ['h', 'hasDistinctOriginal', 'originalWordsNodes']
    .map((name) => sliceFunction(appSrc, name))
    .join('\n');
  assert.ok(slice.includes('function originalWordsNodes'), 'slice extraction grabbed the wrong region');
  let innerHTMLWrites = 0;
  function makeNode(tag: string): RecorderNode {
    const node = {
      tagName: tag,
      attrs: {} as Record<string, string>,
      className: '',
      children: [] as RecorderNode[],
      listeners: {} as Record<string, (...args: unknown[]) => unknown>,
      setAttribute(k: string, v: string) { this.attrs[k] = String(v); },
      addEventListener(type: string, fn: (...args: unknown[]) => unknown) { this.listeners[type] = fn; },
      append(...nodes: RecorderNode[]) { this.children.push(...nodes); },
    } as RecorderNode;
    let innerHTMLValue = '';
    let hiddenValue = false;
    Object.defineProperty(node, 'innerHTML', {
      get: () => innerHTMLValue,
      set: (v: string) => { innerHTMLWrites += 1; innerHTMLValue = v; },
    });
    Object.defineProperty(node, 'hidden', {
      get: () => hiddenValue,
      set: (v: boolean) => { hiddenValue = v; },
    });
    return node;
  }
  const fakeDocument = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, data: String(text), attrs: {}, className: '', children: [], listeners: {} } as unknown as RecorderNode),
  };
  const fakeState = { expandedOriginals: new Set<string>() };
  const factory = new Function(
    'document', 'state', slice + '\n; return originalWordsNodes;'
  );
  const originalWordsNodesFn = factory(fakeDocument, fakeState) as (t: unknown) => RecorderNode[];
  const nodes = originalWordsNodesFn(task);
  return { nodes, innerHTMLWrites };
}

describe('request-text-display: cleaned request_text over raw transcript (app.js)', () => {

  it('turnText prefers the cleaned request_text over the raw transcript', () => {
    const api = makeHarness();
    assert.equal(
      api.turnText({ source: 'voice', transcript: 'umm book the uh dentist', request_text: 'Book the dentist' }),
      'Book the dentist'
    );
  });

  it('turnText falls back to the transcript, then the transcribing notice, while the placeholder stands', () => {
    const api = makeHarness();
    assert.equal(
      api.turnText({ transcript: 'raw words', request_text: '(voice recording)' }),
      'raw words'
    );
    assert.equal(
      api.turnText({ transcript: null, request_text: '(voice recording)' }),
      'Transcribing your recording…'
    );
  });

  it('hasDistinctOriginal is true only for a voice task whose request_text differs from its transcript', () => {
    const api = makeHarness();
    assert.equal(
      api.hasDistinctOriginal({ source: 'voice', transcript: 'umm book the uh dentist', request_text: 'Book the dentist' }),
      true
    );
    assert.equal(
      api.hasDistinctOriginal({ source: 'voice', transcript: 'Book the dentist', request_text: 'Book the dentist' }),
      false
    );
    assert.equal(
      api.hasDistinctOriginal({ source: 'text', transcript: 'umm book the uh dentist', request_text: 'Book the dentist' }),
      false
    );
    assert.equal(
      api.hasDistinctOriginal({ source: 'voice', transcript: 'umm book the uh dentist', request_text: '(voice recording)' }),
      false
    );
    assert.equal(
      api.hasDistinctOriginal({ source: 'voice', transcript: null, request_text: 'Book the dentist' }),
      false
    );
  });

  it('a request_text change alone changes the conversation signature', () => {
    const api = makeHarness();
    const base = () => ({
      conversation_id: 'vi-a1b2c3d4e5f6',
      state: 'running',
      updated_at: '2026-09-16T10:00:00.000Z',
      task_count: 1,
      result_summary: null,
      pending_input_count: 0,
      telegram_link: '',
      title: null,
      recap: null,
      next_action: null,
      share: null,
      tasks: [{
        task_id: 't-a1b2c3d4e5f6',
        state: 'running',
        updated_at: '2026-09-16T10:00:00.000Z',
        request_text: '(voice recording)',
        events: [],
        input_requests: [],
      }],
    });
    const before = base();
    const after = base();
    after.tasks[0].request_text = 'Book the dentist';
    assert.notEqual(api.conversationSignature(before), api.conversationSignature(after));
  });

  it('a request_text change alone changes the list signature', () => {
    const api = makeHarness();
    const base = () => [{
      conversation_id: 'vi-a1b2c3d4e5f6',
      state: 'running',
      updated_at: '2026-09-16T10:00:00.000Z',
      request_text: '(voice recording)',
      latest_request_text: 'Book the dentist',
      task_count: 1,
      pending_input_count: 0,
      result_summary: null,
      title: null,
      recap: null,
      next_action: null,
      latest_step: null,
    }];
    const before = base();
    const after = base();
    after[0].request_text = 'Book the dentist'; // latest_request_text unchanged
    assert.notEqual(api.listSignature(before), api.listSignature(after));
  });

  it('a latest_request_text change alone changes the list signature', () => {
    const api = makeHarness();
    const base = () => [{
      conversation_id: 'vi-a1b2c3d4e5f6',
      state: 'running',
      updated_at: '2026-09-16T10:00:00.000Z',
      request_text: 'Book the dentist',
      latest_request_text: '(voice recording)',
      task_count: 1,
      pending_input_count: 0,
      result_summary: null,
      title: null,
      recap: null,
      next_action: null,
      latest_step: null,
    }];
    const before = base();
    const after = base();
    after[0].latest_request_text = 'Book the dentist'; // request_text unchanged
    assert.notEqual(api.listSignature(before), api.listSignature(after));
  });

  it('originalWordsNodes renders the transcript as a plain text node, never via innerHTML', () => {
    const { nodes, innerHTMLWrites } = buildOriginalWordsNodes({
      source: 'voice',
      task_id: 't-a1b2c3d4e5f6',
      transcript: '<img src=x onerror=alert(1)>',
      request_text: 'Book the dentist',
    });
    assert.equal(nodes.length, 2, 'originalWordsNodes must push [toggle, detail]');
    const detail = nodes[1];
    assert.equal(detail.children.length, 1, 'the transcript must land as exactly one child');
    assert.equal(detail.children[0].nodeType, 3, 'the transcript child must be a text node');
    assert.equal(detail.children[0].data, '<img src=x onerror=alert(1)>', 'the text node must carry the raw transcript verbatim, unescaped and unexecuted');
    assert.equal(innerHTMLWrites, 0, 'nothing may assign innerHTML with the transcript');
  });

  it('renderTurnContent places the exact-words disclosure right after the spoken turn', () => {
    const slice = renderTurnContentSlice();
    const saidIdx = slice.indexOf('nodes.push(said);');
    const originalIdx = slice.indexOf('originalWordsNodes(task)');
    const voiceIdx = slice.indexOf("task.source === 'voice'");
    assert.ok(saidIdx >= 0, 'nodes.push(said); not found');
    assert.ok(originalIdx >= 0, 'originalWordsNodes(task) not found');
    assert.ok(voiceIdx >= 0, "task.source === 'voice' not found");
    assert.ok(saidIdx < originalIdx, 'said must be pushed before originalWordsNodes');
    assert.ok(originalIdx < voiceIdx, 'originalWordsNodes must come before the audio-player voice check');
  });
});
