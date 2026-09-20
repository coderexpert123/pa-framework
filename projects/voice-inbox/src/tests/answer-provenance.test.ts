/**
 * Answer-provenance tests (WS3, 2026-09-18; router-metadata wave, 2026-09-20):
 * the PWA's quiet provenance chip + the default-visible routing line on
 * answered cards — answerProvenanceRow and answerRoutingLine sliced from
 * public/app.js and run against a stubbed DOM (the structured-answer.test.ts
 * idiom: execute the REAL function source, never a hand copy).
 *
 * Pins the operator-locked behaviour:
 *   - all three worker fields NULL (pre-v15 / unstamped rows) → no chip at
 *     all, so legacy rows render byte-identically;
 *   - decision 33 (2026-09-20): the collapsed chip label is the plain
 *     `How this was answered` — never the raw model/CLI name; the technical
 *     layer (model / effort / worker / the v16 router_* routing rows) lives
 *     ONLY in the expanded details; a continued-here or NULL placement adds
 *     no routing UI anywhere;
 *   - the ONE default-visible exception: a placement CHANGE (diverted /
 *     new-conversation / split) renders one plain `answer-routing` sentence,
 *     linked to the origin conversation when the target is a ledger id.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function sliceFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in public/app.js`);
  const rest = src.slice(start);
  const m = /\nfunction \w+\(/.exec(rest.slice(1));
  const end = m ? 1 + m.index : rest.length;
  return rest.slice(0, end);
}

interface FakeEl {
  tag: string;
  attrs: Record<string, unknown>;
  children: FakeEl[];
  attrsMap: Map<string, string>;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  handlers: Record<string, ((e?: unknown) => void)[]>;
  addEventListener: (k: string, fn: (e?: unknown) => void) => void;
}

function makeH() {
  const el = (tag: string, attrs: Record<string, unknown> | null, ...children: unknown[]): FakeEl => {
    const node: FakeEl = {
      tag,
      attrs: attrs ?? {},
      children: children.flat(Infinity) as FakeEl[],
      attrsMap: new Map(),
      handlers: {},
      setAttribute(k: string, v: string) { node.attrsMap.set(k, String(v)); },
      getAttribute(k: string) { return node.attrsMap.has(k) ? String(node.attrsMap.get(k)) : null; },
      addEventListener(k: string, fn: (e?: unknown) => void) { (node.handlers[k] ??= []).push(fn); },
    };
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as (e?: unknown) => void);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    return node;
  };
  return el;
}

/** Renders both sliced functions: h + a strokeIcon stub + a navigate stub
 *  that records every conversation-open call. */
function provenanceApi() {
  const src = readFileSync(join(PKG_ROOT, 'public', 'app.js'), 'utf8');
  const routingSlice = sliceFn(src, 'answerRoutingLine');
  const provSlice = sliceFn(src, 'answerProvenanceRow');
  assert.ok(routingSlice.includes('function answerRoutingLine('), 'slice missing answerRoutingLine');
  assert.ok(provSlice.includes('function answerProvenanceRow('), 'slice missing answerProvenanceRow');
  const factory = new Function(
    'h', 'strokeIcon', 'navigate',
    `${routingSlice}\n${provSlice}\n; return { answerProvenanceRow, answerRoutingLine };`
  );
  // strokeIcon stands in for the real glyph builder — the chip is the unit
  // under test, not the icon's path data.
  const strokeIconStub = () => ({ tag: 'svg', icon: true });
  const navCalls: [string, string][] = [];
  const navigate = (view: string, id: string) => { navCalls.push([view, id]); };
  const api = factory(makeH(), strokeIconStub, navigate) as {
    answerProvenanceRow: (t: unknown) => FakeEl | null;
    answerRoutingLine: (t: unknown) => FakeEl | null;
  };
  return { ...api, navCalls };
}

function chipOf(row: FakeEl): FakeEl {
  return row.children[0] as FakeEl;
}
function detailsOf(row: FakeEl): FakeEl {
  return row.children[1] as FakeEl;
}
function rowText(node: FakeEl): string {
  let out = '';
  const walk = (n: FakeEl) => {
    for (const c of n.children) {
      if (c && (c as FakeEl).tag !== undefined && Array.isArray((c as FakeEl).children)) walk(c as FakeEl);
      else out += String(c);
    }
  };
  walk(node);
  return out;
}

/** Text that is VISIBLE while the disclosure is collapsed: the whole row
 *  MINUS the hidden details subtree (the details node sits in the DOM but
 *  `hidden`). The decision-33 negative gates run against this. */
function collapsedText(row: FakeEl): string {
  return rowText({ ...row, children: [chipOf(row)] } as FakeEl);
}

/** Serializable projection for the explicit deepEqual legacy-layout pin:
 *  tag + non-function attrs + children (function-valued attrs are wiring,
 *  asserted separately via `handlers`, not layout). */
function project(node: unknown): unknown {
  const n = node as FakeEl;
  if (!n || typeof n !== 'object' || n.tag === undefined || !Array.isArray(n.children)) return n;
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.attrs)) {
    if (typeof v !== 'function') attrs[k] = v;
  }
  return { tag: n.tag, attrs, children: n.children.map(project) };
}

/** The projection of one details paragraph (label + strong value). */
function detailP(label: string, value: string): unknown {
  return {
    tag: 'p', attrs: {},
    children: [
      { tag: 'span', attrs: { class: 'ap-label' }, children: [label + ': '] },
      { tag: 'strong', attrs: {}, children: [value] },
    ],
  };
}

describe('answerProvenanceRow (WS3)', () => {
  const api = provenanceApi();

  it('returns null when every worker provenance field is NULL (fail-open)', () => {
    assert.equal(api.answerProvenanceRow({ worker_cli: null, worker_model: null, worker_effort: null }), null);
    assert.equal(api.answerProvenanceRow({}), null);
  });

  it('renders chip + disclosure with values, labelled in plain language', () => {
    const row = api.answerProvenanceRow({
      task_id: 'tk-123', worker_model: 'claude-opus-5', worker_cli: 'claude',
      worker_effort: 'high', source: 'voice',
    }) as FakeEl;
    assert.ok(row, 'row rendered');
    assert.equal(row.tag, 'div');
    assert.equal(String(row.attrs.class), 'answer-provenance');
    const chip = chipOf(row);
    assert.equal(chip.tag, 'button');
    assert.equal(chip.getAttribute('aria-expanded'), 'false');
    assert.ok(String(chip.getAttribute('aria-controls')).length > 0);
    assert.ok(String(chip.attrs['aria-controls']).length > 0);
    assert.ok(String(chip.attrs.class).includes('answer-provenance-chip'));
    // Decision 33: the collapsed label is the plain inspect phrase — never
    // the model or CLI name.
    assert.ok(rowText(chip).includes('How this was answered'), `collapsed label must be the plain phrase — got: ${rowText(chip)}`);
    const details = detailsOf(row);
    assert.ok(details.attrsMap.has('hidden'), 'details start collapsed (hidden attribute present)');
    assert.equal(details.attrs.id, String(chip.attrs['aria-controls']));
    const text = rowText(details);
    for (const label of ['Model:', 'Effort:', 'Ran on:', 'How it was asked:', 'Reference:']) {
      assert.ok(text.includes(label), `details missing "${label}" — got: ${text}`);
    }
    assert.ok(text.includes('claude-opus-5') && text.includes('high') && text.includes('spoken') && text.includes('tk-123'));
  });

  it('omits the how-asked line when source is null; the collapsed label never names the CLI', () => {
    const row = api.answerProvenanceRow({
      task_id: 'tk-456', worker_model: null, worker_cli: 'zclaude', worker_effort: null, source: null,
    }) as FakeEl;
    assert.ok(row, 'row rendered (fail-open gate is model OR cli present)');
    const text = rowText(detailsOf(row));
    assert.ok(!text.includes('How it was asked'), 'source line must be omitted when source is null');
    assert.ok(!text.includes('Effort:'), 'NULL effort must be omitted');
    assert.ok(text.includes('zclaude') && text.includes('tk-456'));
    const chip = chipOf(row);
    // Decision 33: the CLI name is technical noise — it lives in the expanded
    // details only, never as the collapsed chip label.
    assert.ok(!rowText(chip).includes('zclaude'), 'collapsed label must NOT be the CLI name');
    assert.ok(rowText(chip).includes('How this was answered'));
  });

  it('tap toggles the disclosure; Escape collapses it', () => {
    const row = api.answerProvenanceRow({
      task_id: 'tk-789', worker_model: 'claude-opus-5', worker_cli: null, worker_effort: 'low', source: 'text',
    }) as FakeEl;
    const chip = chipOf(row);
    const details = detailsOf(row);
    const toggle = chip.handlers.click?.[0];
    assert.ok(typeof toggle === 'function', 'chip wired a click handler');
    toggle!();
    assert.equal(chip.getAttribute('aria-expanded'), 'true');
    assert.equal((details as unknown as { hidden: boolean }).hidden, false);
    toggle!();
    assert.equal(chip.getAttribute('aria-expanded'), 'false');
    assert.equal((details as unknown as { hidden: boolean }).hidden, true);
    toggle!();
    const escape = chip.handlers.keydown?.[0];
    assert.ok(typeof escape === 'function', 'chip wired an Escape handler');
    escape!({ key: 'Escape' });
    assert.equal(chip.getAttribute('aria-expanded'), 'false');
    assert.equal((details as unknown as { hidden: boolean }).hidden, true);
  });
});

describe('routing rows (v16 router_*, expanded view only — decision 33)', () => {
  const api = provenanceApi();

  it('the collapsed label is exactly "How this was answered" (the superseded WS3 pin)', () => {
    const row = api.answerProvenanceRow({
      task_id: 'tk-1', worker_model: 'claude-opus-5', worker_cli: 'claude', worker_effort: 'high',
    }) as FakeEl;
    // The strokeIcon stub stringifies as "[object Object]" in rowText — strip
    // it; what must remain is EXACTLY the plain phrase, nothing else.
    const chipText = rowText(chipOf(row)).replace(/\[object Object\]/g, '').trim();
    assert.equal(chipText, 'How this was answered');
  });

  it('Chosen by renders only for a set router_decision, with its pinned plain value', () => {
    for (const [decision, phrase] of [
      ['router', 'automatic routing'],
      ['ladder', 'standard selection'],
      ['command', 'your instruction'],
    ] as const) {
      const row = api.answerProvenanceRow({
        task_id: 'tk-2', worker_model: 'm', worker_cli: 'c', router_decision: decision,
      }) as FakeEl;
      const text = rowText(detailsOf(row));
      assert.ok(text.includes('Chosen by:'), `decision ${decision} → "Chosen by" row`);
      assert.ok(text.includes(phrase), `decision ${decision} → "${phrase}"`);
    }
    const none = api.answerProvenanceRow({
      task_id: 'tk-3', worker_model: 'm', worker_cli: 'c', router_decision: null,
    }) as FakeEl;
    assert.ok(!rowText(detailsOf(none)).includes('Chosen by'), 'NULL decision → no Chosen-by row');
  });

  it('steer renders Correction / Timing per value; the router-decided steer adds NO Decided-by row', () => {
    const steer = api.answerProvenanceRow({
      task_id: 'tk-4', worker_model: 'm', worker_cli: 'c',
      router_steer: 'steer', router_steer_by: 'router',
    }) as FakeEl;
    const steerText = rowText(detailsOf(steer));
    assert.ok(steerText.includes('Correction:') && steerText.includes('sent to the task already running'));
    assert.ok(!steerText.includes('Decided by'), 'steer_by=router adds no Decided-by row (Chosen by already names it)');

    const wait = api.answerProvenanceRow({
      task_id: 'tk-5', worker_model: 'm', worker_cli: 'c',
      router_steer: 'wait', router_steer_by: 'router',
    }) as FakeEl;
    const waitText = rowText(detailsOf(wait));
    assert.ok(waitText.includes('Timing:') && waitText.includes('waited for the running task to finish'));
    assert.ok(!waitText.includes('Correction'), 'wait does not render the Correction row');

    const none = api.answerProvenanceRow({
      task_id: 'tk-6', worker_model: 'm', worker_cli: 'c', router_steer: null,
    }) as FakeEl;
    const noneText = rowText(detailsOf(none));
    assert.ok(!noneText.includes('Correction') && !noneText.includes('Timing'), 'NULL steer → neither row');
  });

  it('Decided by renders "you did" ONLY for the operator case, only alongside a steer', () => {
    const operator = api.answerProvenanceRow({
      task_id: 'tk-7', worker_model: 'm', worker_cli: 'c',
      router_steer: 'steer', router_steer_by: 'operator',
    }) as FakeEl;
    const text = rowText(detailsOf(operator));
    assert.ok(text.includes('Decided by:') && text.includes('you did'), 'operator steer → "Decided by: you did"');

    // Renders only alongside router_steer (stamped together or not at all).
    const orphan = api.answerProvenanceRow({
      task_id: 'tk-8', worker_model: 'm', worker_cli: 'c',
      router_steer: null, router_steer_by: 'operator',
    }) as FakeEl;
    assert.ok(!rowText(detailsOf(orphan)).includes('Decided by'), 'steer_by without steer renders no row');
  });

  it('Effort note renders per router_effort_proj; applied adds none', () => {
    const nearest = api.answerProvenanceRow({
      task_id: 'tk-9', worker_model: 'm', worker_cli: 'c', router_effort_proj: 'nearest',
    }) as FakeEl;
    const nearestText = rowText(detailsOf(nearest));
    assert.ok(nearestText.includes('Effort note:') && nearestText.includes('adjusted to the closest setting'));

    const recat = api.answerProvenanceRow({
      task_id: 'tk-10', worker_model: 'm', worker_cli: 'c', router_effort_proj: 'recategorize',
    }) as FakeEl;
    const recatText = rowText(detailsOf(recat));
    assert.ok(recatText.includes('Effort note:') && recatText.includes('this assistant has no effort control'));

    const applied = api.answerProvenanceRow({
      task_id: 'tk-11', worker_model: 'm', worker_cli: 'c', router_effort_proj: 'applied',
    }) as FakeEl;
    assert.ok(!rowText(detailsOf(applied)).includes('Effort note'), 'applied → no Effort-note row');
  });

  it('Attempts renders only at >= 1 failover, pluralized', () => {
    const one = api.answerProvenanceRow({
      task_id: 'tk-12', worker_model: 'm', worker_cli: 'c', router_failovers: 1,
    }) as FakeEl;
    const oneText = rowText(detailsOf(one));
    assert.ok(oneText.includes('Attempts:') && oneText.includes('tried 1 other assistant first'));

    const two = api.answerProvenanceRow({
      task_id: 'tk-13', worker_model: 'm', worker_cli: 'c', router_failovers: 2,
    }) as FakeEl;
    const twoText = rowText(detailsOf(two));
    assert.ok(twoText.includes('Attempts:') && twoText.includes('tried 2 other assistants first'));

    for (const failovers of [0, null]) {
      const none = api.answerProvenanceRow({
        task_id: 'tk-14', worker_model: 'm', worker_cli: 'c', router_failovers: failovers,
      }) as FakeEl;
      assert.ok(!rowText(detailsOf(none)).includes('Attempts'), `failovers=${failovers} → no Attempts row`);
    }
  });

  it('continued-here adds no row anywhere', () => {
    const row = api.answerProvenanceRow({
      task_id: 'tk-15', worker_model: 'm', worker_cli: 'c', router_placement: 'continued-here',
    }) as FakeEl;
    const text = rowText(detailsOf(row));
    assert.ok(!text.includes('continued'), 'continued-here never appears in any row');
    assert.ok(!text.includes('placement'), 'no placement row exists');
  });
});

describe('collapsed-state negative gate (decision 33)', () => {
  const api = provenanceApi();

  it('default view: continued-here or NULL placement shows NO routing text and NO model/effort/worker text', () => {
    for (const placement of ['continued-here', null]) {
      const row = api.answerProvenanceRow({
        task_id: 'tk-20', worker_model: 'claude-opus-5', worker_cli: 'claude', worker_effort: 'high',
        router_placement: placement,
      }) as FakeEl;
      const visible = collapsedText(row);
      assert.ok(visible.includes('How this was answered'), 'the plain affordance is present');
      for (const banned of ['claude-opus-5', 'claude', 'high', 'Chosen by', 'Correction', 'Timing', 'Decided by', 'Effort note', 'Attempts', 'automatic routing', 'standard selection', 'your instruction']) {
        assert.ok(!visible.includes(banned), `placement=${placement}: "${banned}" must not be visible collapsed — got: ${visible}`);
      }
      const details = detailsOf(row);
      assert.ok(details.attrsMap.has('hidden'), 'details node exists and starts hidden');
      assert.equal(chipOf(row).getAttribute('aria-expanded'), 'false');
    }
  });

  it('with EVERY routing field set, nothing technical is visible while aria-expanded=false', () => {
    const row = api.answerProvenanceRow({
      task_id: 'tk-21', worker_model: 'claude-opus-5', worker_cli: 'zclaude', worker_effort: 'xhigh',
      source: 'voice', router_decision: 'router', router_placement: 'diverted',
      router_target: 'vi-0123456789ab', router_steer: 'wait', router_steer_by: 'router',
      router_effort_proj: 'nearest', router_failovers: 2,
    }) as FakeEl;
    const chip = chipOf(row);
    assert.equal(chip.getAttribute('aria-expanded'), 'false');
    const details = detailsOf(row);
    assert.ok(details.attrsMap.has('hidden'), 'the technical layer exists only in the hidden details node');
    const visible = collapsedText(row);
    for (const banned of ['Chosen by', 'Correction', 'Timing', 'Decided by', 'Effort note', 'Attempts',
      'automatic routing', 'standard selection', 'your instruction',
      'sent to the task already running', 'waited for the running task to finish', 'you did',
      'adjusted to the closest setting', 'tried 2 other assistants first',
      'claude-opus-5', 'zclaude', 'xhigh', 'spoken']) {
      assert.ok(!visible.includes(banned), `"${banned}" must not be visible collapsed — got: ${visible}`);
    }
    // And the expanded layer DOES carry it all.
    const expanded = rowText(details);
    for (const present of ['Chosen by', 'automatic routing', 'Timing', 'waited for the running task to finish',
      'Decided by' /* absent: router-steer */, 'Effort note', 'Attempts', 'tried 2 other assistants first']) {
      if (present === 'Decided by') {
        assert.ok(!expanded.includes(present), 'router-decided turn adds no Decided-by row');
      } else {
        assert.ok(expanded.includes(present), `expanded details carry "${present}"`);
      }
    }
  });
});

describe('answerRoutingLine (the default-visible placement change)', () => {
  const api = provenanceApi();

  it('returns null for continued-here and NULL placement (default view stays routing-free)', () => {
    assert.equal(api.answerRoutingLine({ router_placement: 'continued-here' }), null);
    assert.equal(api.answerRoutingLine({ router_placement: null }), null);
    assert.equal(api.answerRoutingLine({}), null);
  });

  it('diverted + vi-id target: plain sentence with "another conversation" as a real link', () => {
    const line = api.answerRoutingLine({
      router_placement: 'diverted', router_target: 'vi-0123456789ab',
    }) as FakeEl;
    assert.ok(line, 'line rendered');
    assert.equal(line.tag, 'p');
    assert.equal(String(line.attrs.class), 'answer-routing');
    const link = line.children.find((c) => (c as FakeEl).tag === 'a') as FakeEl | undefined;
    assert.ok(link, 'the origin conversation is a real <a>');
    assert.equal(rowText(line), 'Moved here from another conversation');
    // The link opens the ORIGIN conversation through the app's own navigation.
    const click = link.handlers.click?.[0];
    assert.ok(typeof click === 'function', 'link wired a click handler');
    click!({ preventDefault() {} });
    assert.deepStrictEqual(api.navCalls, [['conversation', 'vi-0123456789ab']]);
  });

  it('diverted with a non-vi or NULL target: same plain text, no link (honest fail-open)', () => {
    for (const target of ['telegram-topic-999', 'not-an-id', null]) {
      const line = api.answerRoutingLine({
        router_placement: 'diverted', router_target: target,
      }) as FakeEl;
      assert.ok(line, 'line rendered');
      assert.equal(rowText(line), 'Moved here from another conversation');
      assert.ok(!line.children.some((c) => (c as FakeEl).tag === 'a'), 'no link without a ledger target');
      assert.ok(!rowText(line).includes('vi-'), 'the raw id is never rendered');
    }
  });

  it('new-conversation and split render their pinned plain sentences, no link, no count', () => {
    const fresh = api.answerRoutingLine({ router_placement: 'new-conversation' }) as FakeEl;
    assert.equal(rowText(fresh), 'This work started a new conversation');
    assert.ok(!fresh.children.some((c) => (c as FakeEl).tag === 'a'));

    const split = api.answerRoutingLine({ router_placement: 'split' }) as FakeEl;
    assert.equal(rowText(split), 'Split across conversations');
    assert.ok(!split.children.some((c) => (c as FakeEl).tag === 'a'));
    assert.ok(!rowText(split).match(/\d/), 'no count is rendered (not recorded)');
  });

  it('no default-visible string carries routing vocabulary', () => {
    const lines = [
      api.answerRoutingLine({ router_placement: 'diverted', router_target: 'vi-0123456789ab' }),
      api.answerRoutingLine({ router_placement: 'diverted', router_target: null }),
      api.answerRoutingLine({ router_placement: 'new-conversation' }),
      api.answerRoutingLine({ router_placement: 'split' }),
    ];
    const row = api.answerProvenanceRow({
      task_id: 'tk-30', worker_model: 'm', worker_cli: 'c', router_decision: 'router',
      router_placement: 'diverted', router_steer: 'steer', router_steer_by: 'operator',
      router_effort_proj: 'recategorize', router_failovers: 3,
    }) as FakeEl;
    const collapsed = collapsedText(row);
    for (const node of [...lines, { children: [collapsed] } as unknown as FakeEl]) {
      const text = rowText(node as FakeEl);
      assert.ok(!/router|placement|steer|worker/i.test(text), `routing vocabulary leaked: "${text}"`);
    }
  });
});

describe('legacy layout (all router_* NULL)', () => {
  const api = provenanceApi();

  it('renders no routing nodes and keeps the v15 layout byte-identical (explicit deepEqual)', () => {
    const row = api.answerProvenanceRow({
      task_id: 'tk-99', worker_model: 'claude-opus-5', worker_cli: 'claude',
      worker_effort: 'high', source: 'voice',
      router_decision: null, router_placement: null, router_target: null,
      router_steer: null, router_steer_by: null, router_effort_proj: null, router_failovers: null,
    }) as FakeEl;
    assert.ok(row, 'the chip still renders');
    const detailsId = 'answer-provenance-tk-99';
    assert.deepStrictEqual(project(row), {
      tag: 'div',
      attrs: { class: 'answer-provenance' },
      children: [
        {
          tag: 'button',
          attrs: {
            class: 'answer-provenance-chip', type: 'button',
            'aria-expanded': 'false', 'aria-controls': detailsId,
          },
          children: [
            { tag: 'svg', icon: true }, // the strokeIcon stub
            'How this was answered',
          ],
        },
        {
          tag: 'div',
          attrs: { class: 'answer-provenance-details', id: detailsId, hidden: true },
          children: [
            detailP('Model', 'claude-opus-5'),
            detailP('Effort', 'high'),
            detailP('Ran on', 'claude'),
            detailP('How it was asked', 'spoken'),
            detailP('Reference', 'tk-99'),
          ],
        },
      ],
    });
  });

  it('exposes both exports on the test api', () => {
    assert.equal(typeof api.answerProvenanceRow, 'function');
    assert.equal(typeof api.answerRoutingLine, 'function');
  });
});
