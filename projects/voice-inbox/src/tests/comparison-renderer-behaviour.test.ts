/**
 * Comparison renderer BEHAVIOUR tests (answer presentation P2 stage-4,
 * 2026-09-15): execute the REAL comparison renderer sources — sliced out of
 * public/app.js (the structured-answer.test.ts idiom) against a stubbed h() —
 * and assert the element tree the renderer builds. The structural suite
 * (comparison-renderer.test.ts) pins source shapes: that the right call
 * expressions appear in the file. This suite pins what those calls PRODUCE:
 * the card tree, the shared attribute order, the swipe modifier, the action
 * controls and the empty fall-through.
 *
 * Promoted from scratch/p2-render-check.mjs — a check proven to discriminate
 * (all 4 mutations in scratch/mutate-render.mjs fail it; the real file
 * passes).
 *
 * APP_JS env var points the source reader at a different app.js — used by the
 * mutation proof (scratch/mutate-render.mjs writes scratch/app-mutated.js),
 * inert otherwise. Node runs each test file in its own subprocess, so a set
 * APP_JS cannot bleed into sibling files.
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function appSrc(): string {
  const env = process.env.APP_JS;
  const path = env ? resolve(PKG_ROOT, env) : join(PKG_ROOT, 'public', 'app.js');
  return readFileSync(path, 'utf8');
}

/** Extract [functionName, …next top-level `function`) — the function source.
 *  Asserts the anchor resolved: a rename surfaces as a clear failure here,
 *  never a silently-empty slice. */
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
  children: unknown[];
  appended: unknown[];
  append: (...kids: unknown[]) => void;
  /** P3 wires action buttons with addEventListener (the handler needs the
   *  control itself, which an h() onclick attr closure cannot see) — the stub
   *  records each listener so a test can find and invoke it. */
  listeners: Record<string, Array<(...a: unknown[]) => void>>;
  addEventListener: (type: string, fn: (...a: unknown[]) => void) => void;
}
interface Anchor { text: string; node: FakeEl }
interface CardsResult { node: FakeEl | null; anchors: Anchor[] }

function makeH() {
  const h = (tag: string, attrs: Record<string, unknown> | null, ...children: unknown[]): FakeEl => ({
    tag,
    attrs: attrs ?? {},
    children: children.flat(Infinity),
    appended: [],
    append(this: FakeEl, ...kids: unknown[]) { this.appended.push(...kids); },
    listeners: {},
    addEventListener(this: FakeEl, type: string, fn: (...a: unknown[]) => void) {
      (this.listeners[type] ??= []).push(fn);
    },
  });
  return h;
}

/** The stubbed element's full child list: renderLines output is passed
 *  through h(), but dl rows arrive via .append() — both must be walked. */
function kids(el: FakeEl): unknown[] {
  return [...el.children, ...el.appended];
}

/** The [dt, dd] value pairs one card's attribute list renders, in order. */
function dlPairs(card: FakeEl): Array<[unknown, unknown]> {
  const dl = (kids(card) as FakeEl[]).find((c) => c && c.attrs && c.attrs['class'] === 'cmp-attrs');
  assert.ok(dl, 'card must carry a .cmp-attrs list');
  const els = kids(dl) as FakeEl[];
  assert.equal(els.length % 2, 0, 'a cmp-attrs list must be whole dt/dd pairs');
  const pairs: Array<[unknown, unknown]> = [];
  for (let i = 0; i + 1 < els.length; i += 2) {
    assert.equal(els[i].tag, 'dt', 'cmp-attrs children must alternate dt/dd');
    assert.equal(els[i + 1].tag, 'dd', 'cmp-attrs children must alternate dt/dd');
    pairs.push([els[i].children[0], els[i + 1].children[0]]);
  }
  return pairs;
}

function comparisonFns() {
  const src = appSrc();
  // Wired buttons register their click through addEventListener (a closure
  // over runStructuredAction — an h() onclick attr cannot see the element it
  // sits on), so the dispatcher and the save path's store chain are sliced
  // too: renderActionButton calls isItemSaved() on every save action, and the
  // notice test executes a listener for real. sliceFn's `\nfunction ` boundary
  // misses `async function`, which is load-bearing here — the
  // runStructuredAction slice swallows async runTaskAction and the
  // runSaveAction slice swallows async runShareAction, so the whole dispatch
  // table lands lexically. The LS_SAVED/SAVED_LABEL/NAME_STORE_MAX_TASKS
  // consts ride the tail of the renderActionButtons slice (P5 generalized
  // the store to nameStore/nameStoreList/nameStoreHas/toggleNameInStore —
  // the vi.saved wrappers keep the save action's contract). localStorage needs
  // no stub: node has none, and both store accesses sit inside try/catch (the
  // read yields {}, the write null) — the intended fail-closed path.
  const names = [
    'structuredLeadText', 'comparisonAttributeKeys', 'renderActionButton',
    'renderActionButtons', 'nameStore', 'nameStoreList', 'nameStoreHas',
    'toggleNameInStore', 'isItemSaved', 'toggleSavedItem',
    'runStructuredAction', 'runSaveAction',
    // P6: comparisonCards calls surfaceLayoutClass for the asking-device
    // modifier — omit it and every call here ReferenceErrors lexically.
    'surfaceLayoutClass', 'comparisonCards', 'renderComparison',
  ];
  const slice = names.map((n) => sliceFn(src, n)).join('');
  for (const n of names) assert.ok(slice.includes(`function ${n}(`), `slice missing ${n}`);
  const notices: string[] = [];
  const factory = new Function(
    'h', 'renderLines', 'stripAnswerMarkers', 'showNotice', 'state', 'navigator',
    `${slice}\n; return { structuredLeadText, comparisonAttributeKeys, renderActionButton, renderActionButtons, comparisonCards, renderComparison };`
  );
  const api = factory(
    makeH(),
    (t: unknown) => [String(t)], // renderLines stub: one text node per value
    (t: unknown) => t,           // stripAnswerMarkers stub (lives in answer-shapes.js)
    (msg: unknown) => { notices.push(String(msg)); }, // showNotice spy
    {},
    { share: () => Promise.resolve() }, // navigator stub: node's navigator has
                                        // no .share — the share control must
                                        // still render
  ) as {
    structuredLeadText: (d: Record<string, unknown>) => string;
    comparisonAttributeKeys: (items: unknown[]) => string[];
    renderActionButton: (a: unknown, t: unknown, label: string) => FakeEl | null;
    renderActionButtons: (a: unknown, t: unknown, label: string) => FakeEl[];
    comparisonCards: (d: Record<string, unknown>, t: unknown) => CardsResult;
    renderComparison: (d: Record<string, unknown>, t: unknown) => FakeEl[];
  };
  return { api, notices };
}

// 3 cars, shared attribute keys, mixed actions — the fixture the stage-4
// check proved itself on. XL6 declares its keys in a DIFFERENT order
// (Mileage, Seats, Price); Innova carries only Price.
const DATA = {
  type: 'comparison',
  title: 'Used 7-seater shortlist',
  recommendation: 'The Ertiga wins on running cost.',
  items: [
    {
      name: 'Maruti Ertiga',
      attributes: { Price: '12 lakh', Mileage: '18 km/l', Seats: '7' },
      actions: [
        { label: 'Call seller', kind: 'call', value: '+819000000001' },
        { label: 'View listing', kind: 'link', url: 'https://example.com/ertiga' },
        { label: 'Compare these two', kind: 'task', prompt: 'Compare the Ertiga and the XL6' },
      ],
    },
    {
      name: 'Mahindra XL6',
      attributes: { Mileage: '16 km/l', Seats: '6', Price: '14 lakh' },
      actions: [
        { label: 'Save', kind: 'save' },
        { label: 'Share it', kind: 'share' },
      ],
    },
    {
      name: 'Toyota Innova',
      attributes: { Price: '19 lakh' },
    },
  ],
};

describe('comparisonCards — the card tree', () => {
  const { api } = comparisonFns();

  it('builds one .cmp-card per item, in order, inside a .cmp-cards container', () => {
    const cards = api.comparisonCards(DATA, { task_id: 'vi-test' });
    assert.ok(cards.node, 'a 3-item comparison must produce a container node');
    assert.equal(kids(cards.node).length, 3, 'one card per item');
    for (const card of kids(cards.node) as FakeEl[]) {
      assert.equal(card.attrs['class'], 'cmp-card');
    }
    assert.equal(cards.anchors.length, 3, 'one chip anchor per item');
    assert.deepEqual(
      cards.anchors.map((a) => a.text),
      ['Maruti Ertiga', 'Mahindra XL6', 'Toyota Innova'],
      'chip anchors carry the item names in order'
    );
    // a chip lands on the item it names — the anchor's node IS the card
    const cardEls = kids(cards.node);
    for (let i = 0; i < cards.anchors.length; i++) {
      assert.ok(cards.anchors[i].node === cardEls[i], `anchor ${i} must point at its card element`);
    }
  });

  it('lays each card out as name → attribute list → action row', () => {
    const cards = api.comparisonCards(DATA, {});
    assert.ok(cards.node);
    const [c1] = kids(cards.node) as FakeEl[];
    const c1kids = kids(c1) as FakeEl[];
    assert.equal(c1kids[0].attrs['class'], 'cmp-name', 'the name leads the card');
    const strong = c1kids[0].children[0] as FakeEl;
    assert.equal(strong.tag, 'strong', 'the item name is bolded');
    assert.equal(strong.children[0], 'Maruti Ertiga');
    assert.equal(c1kids[1].attrs['class'], 'cmp-attrs', 'the attribute list follows the name');
    assert.equal(c1kids[2].attrs['class'], 'cmp-actions', 'the action row is last');
    assert.equal(kids(c1kids[2]).length, 3, 'all three of Ertiga’s action kinds render');
  });
});

describe('comparisonCards — shared attribute key order', () => {
  const { api } = comparisonFns();

  it('renders every card’s rows in the first-seen union order, not its own declaration order', () => {
    const cards = api.comparisonCards(DATA, {});
    assert.ok(cards.node);
    const [c1, c2, c3] = kids(cards.node) as FakeEl[];
    assert.deepEqual(dlPairs(c1), [
      ['Price', '12 lakh'],
      ['Mileage', '18 km/l'],
      ['Seats', '7'],
    ]);
    // XL6 declares Mileage, Seats, Price — the SHARED order re-sorts it so the
    // desktop grid scans column-to-column, and each dd stays under its own dt.
    assert.deepEqual(dlPairs(c2), [
      ['Price', '14 lakh'],
      ['Mileage', '16 km/l'],
      ['Seats', '6'],
    ], 'an item declaring keys in a different order must render the shared order');
    // Innova carries only Price — the keys it lacks are skipped, never
    // rendered as empty cells.
    assert.deepEqual(dlPairs(c3), [['Price', '19 lakh']],
      'an item missing keys must skip them, never render empty cells');
  });
});

describe('comparisonCards — hostile attribute shapes (P3 recheck)', () => {
  const { api } = comparisonFns();

  it('a prototype-named key on one item does not leak Object.prototype source into siblings', () => {
    // 'toString' on Object.prototype satisfies `key in attrs` for EVERY item —
    // the `in` operator walks the chain, so one card declaring it would render
    // 'function toString() { [native code] }' on every OTHER card.
    const cards = api.comparisonCards({
      type: 'comparison',
      items: [
        { name: 'Declares it', attributes: { Price: '12', toString: 'n/a' } },
        { name: 'Innocent', attributes: { Price: '14', Mileage: '16' } },
      ],
    }, {});
    assert.ok(cards.node);
    const [declaring, innocent] = kids(cards.node) as FakeEl[];
    // The declaring card renders its own 'toString' row (own property);
    // the innocent card must skip it entirely — never a native-source value.
    assert.deepEqual(dlPairs(innocent), [['Price', '14'], ['Mileage', '16']],
      'a prototype-named key must not surface on a card that does not carry it');
    assert.deepEqual(dlPairs(declaring).map((p) => p[0]), ['Price', 'toString'],
      'the card that owns the key still renders it');
  });

  it('attributes given as an array render no dl at all (a dl needs an object)', () => {
    const cards = api.comparisonCards({
      type: 'comparison',
      items: [{ name: 'ArrayAttrs', attributes: ['12 lakh', '18 km/l'] }],
    }, {});
    assert.ok(cards.node);
    const [card] = kids(cards.node) as FakeEl[];
    assert.ok(
      !(kids(card) as FakeEl[]).some((k) => k.attrs && k.attrs['class'] === 'cmp-attrs'),
      'array attributes must not render index-number rows'
    );
  });
});

describe('comparisonCards — the cmp-swipe count modifier', () => {
  const { api } = comparisonFns();

  it('adds cmp-swipe only at 3+ cards (two stack on phone)', () => {
    const three = api.comparisonCards(DATA, {});
    assert.ok(three.node);
    assert.equal(three.node.attrs['class'], 'cmp-cards cmp-swipe', '3 items must add the swipe modifier');
    const two = api.comparisonCards({ ...DATA, items: DATA.items.slice(0, 2) }, {});
    assert.ok(two.node);
    assert.equal(two.node.attrs['class'], 'cmp-cards', '2 items must NOT get the swipe modifier');
    const one = api.comparisonCards({ ...DATA, items: DATA.items.slice(0, 1) }, {});
    assert.ok(one.node);
    assert.equal(one.node.attrs['class'], 'cmp-cards', '1 item must NOT get the swipe modifier');
  });
});

describe('comparisonCards — action controls', () => {
  const { api } = comparisonFns();
  const cardActions = (card: FakeEl): FakeEl[] => {
    const row = (kids(card) as FakeEl[]).find((c) => c && c.attrs && c.attrs['class'] === 'cmp-actions');
    assert.ok(row, 'card must carry a .cmp-actions row');
    return kids(row) as FakeEl[];
  };

  it('call and link render as anchors; task/save/share render as buttons', () => {
    const cards = api.comparisonCards(DATA, {});
    assert.ok(cards.node);
    const [c1, c2] = kids(cards.node) as FakeEl[];
    const [callA, linkA, taskB] = cardActions(c1);
    assert.equal(callA.tag, 'a', 'a call action must be an anchor (the platform dials)');
    assert.equal(callA.attrs['href'], 'tel:+819000000001');
    assert.equal(linkA.tag, 'a', 'a link action must be an anchor');
    assert.equal(linkA.attrs['href'], 'https://example.com/ertiga');
    assert.equal(linkA.attrs['target'], '_blank', 'a link action opens a new tab');
    assert.equal(linkA.attrs['rel'], 'noopener');
    assert.equal(taskB.tag, 'button', 'a task action must be a button (P3 wires it)');
    assert.equal(taskB.attrs['type'], 'button');
    const [saveB, shareB] = cardActions(c2);
    assert.equal(saveB.tag, 'button', 'a save action must be a button');
    assert.equal(shareB.tag, 'button', 'a share action must be a button');
  });

  it('every control’s aria-label carries the item name', () => {
    const cards = api.comparisonCards(DATA, {});
    assert.ok(cards.node);
    const [c1, c2] = kids(cards.node) as FakeEl[];
    assert.deepEqual(cardActions(c1).map((a) => a.attrs['aria-label']), [
      'Call seller, Maruti Ertiga',
      'View listing, Maruti Ertiga',
      'Compare these two, Maruti Ertiga',
    ], 'five cards of "View listing" are identical to a screen reader — the item name distinguishes them');
    assert.deepEqual(cardActions(c2).map((a) => a.attrs['aria-label']), [
      'Save, Mahindra XL6',
      'Share it, Mahindra XL6',
    ]);
  });

  it('a wired button’s click listener ends in feedback — a notice, never a silent no-op', () => {
    const { api, notices } = comparisonFns();
    const cards = api.comparisonCards(DATA, { task_id: 'vi-save-test' });
    assert.ok(cards.node);
    const [, c2] = kids(cards.node) as FakeEl[];
    const saveB = cardActions(c2)[0];
    const [click] = saveB.listeners['click'] ?? [];
    assert.equal(typeof click, 'function', 'a wired action must carry a live click listener');
    // save is the deterministic dispatch: node has no localStorage, so the
    // write inside toggleSavedItem's try/catch fails → null → the failure
    // notice — synchronous, unlike the task action's async runner.
    click();
    assert.equal(notices.length, 1, 'the tap must produce exactly one notice');
    assert.ok(notices[0].length > 0, 'the notice must carry a message');
  });

  it('an item with no actions has no .cmp-actions row', () => {
    const cards = api.comparisonCards(DATA, {});
    assert.ok(cards.node);
    const [, , c3] = kids(cards.node) as FakeEl[];
    const c3kids = kids(c3) as FakeEl[];
    assert.equal(c3kids.length, 2, 'name + attributes only — no empty action row');
    assert.ok(!c3kids.some((k) => k.attrs && k.attrs['class'] === 'cmp-actions'));
  });

  it('a link action with a non-http(s) url renders no anchor (P3 recheck scheme gate)', () => {
    // The server validator checks label+kind only — a javascript:/data: url in
    // the payload would otherwise become an executable anchor in the app's own
    // origin. The markdown renderer's rule applies: http(s) only.
    for (const scheme of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'notaurl']) {
      assert.equal(
        api.renderActionButton({ label: 'Open', kind: 'link', url: scheme }, { task_id: 'vi-t' }, 'Item'),
        null,
        `${scheme} must render no control`
      );
    }
    const ok = api.renderActionButton({ label: 'Open', kind: 'link', url: 'https://example.com/x' }, { task_id: 'vi-t' }, 'Item') as FakeEl | null;
    assert.equal(ok?.tag, 'a');
    assert.equal(ok?.attrs['href'], 'https://example.com/x');
    // Uppercase scheme still passes the case-insensitive gate.
    const upper = api.renderActionButton({ label: 'Open', kind: 'link', url: 'HTTPS://example.com/x' }, { task_id: 'vi-t' }, 'Item') as FakeEl | null;
    assert.equal(upper?.tag, 'a');
  });

  it('dead actions render no control — and no empty actions row', () => {
    const cards = api.comparisonCards({
      type: 'comparison',
      items: [{
        name: 'Solo',
        attributes: { K: 'v' },
        actions: [
          { label: '', kind: 'call', value: '+1' },  // label-less
          { label: 'Fax it', kind: 'fax' },          // unknown kind
          { label: 'Call', kind: 'call' },           // missing value → tel:undefined is worse than nothing
          { label: 'Go', kind: 'link' },             // missing url
          'not-an-action', 42,                        // non-object entries
        ],
      }],
    }, {});
    assert.ok(cards.node);
    const [card] = kids(cards.node) as FakeEl[];
    assert.ok(
      !(kids(card) as FakeEl[]).some((k) => k.attrs && k.attrs['class'] === 'cmp-actions'),
      'all-dead actions must produce no .cmp-actions row'
    );
  });
});

describe('comparisonCards — empty fall-through', () => {
  const { api } = comparisonFns();

  it('returns { node: null, anchors: [] } for empty, blank-name and non-object items', () => {
    for (const [label, items] of [
      ['empty items', []],
      ['blank names', [{ name: '   ' }]],
      ['non-object items', ['nope', null, 42]],
      ['missing items key', undefined],
      ['non-array items', 'nope'],
    ] as Array<[string, unknown]>) {
      const r = api.comparisonCards({ items }, {});
      assert.equal(r.node, null, `${label} must produce a null node`);
      assert.deepEqual(r.anchors, [], `${label} must produce no anchors`);
    }
  });
});

describe('renderComparison — the flat path', () => {
  const { api } = comparisonFns();

  it('leads with the recommendation as .cmp-lead when present', () => {
    const nodes = api.renderComparison(DATA, { task_id: 'vi-test' });
    assert.equal(nodes.length, 2, 'lead line + cards container');
    const [lead, container] = nodes;
    assert.equal(lead.tag, 'p');
    assert.equal(lead.attrs['class'], 'cmp-lead');
    assert.equal(lead.children[0], 'The Ertiga wins on running cost.');
    assert.equal(container.attrs['class'], 'cmp-cards cmp-swipe');
  });

  it('omits the lead line when the payload carries no recommendation', () => {
    const { recommendation, ...noRec } = DATA;
    const nodes = api.renderComparison(noRec, {});
    assert.equal(nodes.length, 1, 'no lead — just the cards');
    assert.equal(nodes[0].attrs['class'], 'cmp-cards cmp-swipe');
  });

  it('returns [] on an empty payload so the caller falls through to markdown', () => {
    assert.deepEqual(api.renderComparison({ type: 'comparison' }, {}), []);
  });
});
