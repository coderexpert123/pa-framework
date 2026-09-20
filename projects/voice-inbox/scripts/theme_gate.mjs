#!/usr/bin/env node
/**
 * Light/dark theme gate (2026-09-16). Serves a public/ directory over a local
 * HTTP server, stubs the API with fixture data, and drives the REAL app.js /
 * share.js in headless Chromium under both prefers-color-scheme emulations.
 * Every assertion reads COMPUTED styles — never CSS text — because an
 * equal-specificity rule later in the file can override any declaration a
 * text check would see.
 *
 *   G1  every rendered element's colours are in that scheme's palette
 *       (tokens + the browser's own system colours + transparent)
 *   G1b each token resolves to the value the spec fixes for that scheme
 *   G2  flipping the scheme on an open page (no reload) repaints already
 *       rendered nodes, icons included; no svg carries a resolved colour
 *   G3  :root computed color-scheme equals the emulated scheme
 *   G4  canvas readback of --ground and --accent-ink equals the fixed hex
 *   G5  the theme-color meta matching the scheme equals the body background
 *   G6  the raw-html frame's text colour follows the scheme
 *   G7  a section-chip tap flashes its target with --accent-tint-hover
 *
 * Usage (from projects/voice-inbox):
 *   PLAYWRIGHT_CORE_PATH=<dir of playwright-core> node scripts/theme_gate.mjs \
 *     [--public <dir>] [--shots <dir>] [--only <view,...>]
 * Output: one PASS/FAIL line per check, then exactly one summary line:
 *   THEME GATE: PASS (<n> checks)   exit 0
 *   THEME GATE: FAIL (<k> of <n> checks)   exit 1
 *   THEME GATE: SKIPPED — <reason>   exit 2 (never a silent pass)
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const PUBLIC = resolve(argVal('--public') || join(pkgRoot, 'public'));
const SHOTS = argVal('--shots') ? resolve(argVal('--shots')) : null;
// --only <view[,view]> narrows the render matrix for debugging; a narrowed run
// always ends FAIL so it can never stand in for the full gate.
const ONLY = argVal('--only') ? argVal('--only').split(',') : null;

function skip(reason) {
  console.log(`THEME GATE: SKIPPED — ${reason}`);
  process.exit(2);
}

let chromium;
try {
  const require = createRequire(import.meta.url);
  const modPath = process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core';
  ({ chromium } = require(modPath));
} catch (e) {
  skip(`playwright-core not loadable (set PLAYWRIGHT_CORE_PATH): ${e.message}`);
}
if (!existsSync(join(PUBLIC, 'index.html'))) skip(`no index.html under ${PUBLIC}`);

// ---------------------------------------------------------------- palette --
// The values the spec fixes. Opaque tokens as [r,g,b]; tints as [r,g,b,a].
const EXPECTED = {
  dark: {
    '--ground': [14, 18, 23], '--raised': [25, 31, 37], '--raised-hover': [37, 43, 49],
    '--ink': [235, 239, 244], '--dim': [187, 194, 201], '--faint': [156, 162, 169],
    '--ring': [110, 117, 125], '--hairline': [49, 54, 59],
    '--accent': [236, 179, 60], '--on-accent': [30, 20, 6],
    '--accent-ink': [238, 192, 91], '--on-accent-ink': [14, 18, 23],
    '--accent-tint-soft': [236, 179, 60, 0.07], '--accent-tint': [236, 179, 60, 0.2],
    '--accent-tint-hover': [236, 179, 60, 0.14], '--accent-tint-active': [236, 179, 60, 0.24],
    '--accent-glow': [236, 179, 60, 0.3], '--scrim': [14, 18, 23],
  },
  light: {
    '--ground': [251, 252, 253], '--raised': [232, 235, 239], '--raised-hover': [218, 222, 227],
    '--ink': [21, 27, 33], '--dim': [66, 72, 80], '--faint': [91, 97, 104],
    '--ring': [117, 123, 130], '--hairline': [212, 216, 221],
    '--accent': [241, 177, 43], '--on-accent': [43, 28, 8],
    '--accent-ink': [134, 84, 3], '--on-accent-ink': [251, 252, 253],
    '--accent-tint-soft': [241, 177, 43, 0.1], '--accent-tint': [241, 177, 43, 0.22],
    '--accent-tint-hover': [241, 177, 43, 0.26], '--accent-tint-active': [241, 177, 43, 0.32],
    '--accent-glow': [241, 177, 43, 0.55], '--scrim': [21, 27, 33],
  },
};
const THEME_COLOR = { dark: '#0e1217', light: '#fbfcfd' };

// ---------------------------------------------------------------- fixtures --
const NOW = '2026-09-16T10:00:00.000Z';
const OLD = '2026-09-10T10:00:00.000Z';
const LONG_MD = [
  '### What I found',
  'The **short version**: the second option is cheaper and closer. See [the listing](https://example.com/a).',
  '',
  '### Details',
  '- First point with a link https://example.com/b',
  '- Second point',
  '- Third point',
  '',
  '| Option | Price | Distance |',
  '|---|---|---|',
  '| North | 120 | 4 km |',
  '| South | 95 | 2 km |',
  '',
  '### Code',
  '```',
  'npm run build',
  '```',
  '',
  '### Custom view',
  ':::raw-html',
  '<div><b>Hello</b> from a custom answer.</div>',
  ':::',
  '',
  '### Next',
  '1) Book the south option',
  '2) Confirm the date',
].join('\n');

const actions = [
  { label: 'Open store', kind: 'link', url: 'https://example.com/store' },
  { label: 'Call shop', kind: 'call', value: '+811234567890' },
  { label: 'Save', kind: 'save' },
];
const STRUCTURED = {
  comparison: { type: 'comparison', title: 'Three phones', recommendation: 'The second phone wins on camera.',
    items: ['Phone one', 'Phone two', 'Phone three'].map((name, i) => ({ name, attributes: { Price: `${50 + i * 10}k`, Camera: ['Good', 'Best', 'Fine'][i], Battery: ['Two days', 'One day', 'One day'][i] }, actions })) },
  listing: { type: 'listing', title: 'Nearby clinics',
    items: ['North clinic', 'South clinic', 'East clinic'].map((name) => ({ name, summary: 'Open until 8 pm, walk-ins welcome.', actions })) },
  guide: { type: 'guide', title: 'Renew the passport',
    items: [{ name: 'Fill the form', done: true, points: ['Use black ink', 'Sign on page two'] }, { name: 'Book the slot', summary: 'Pick the nearest centre.' }, { name: 'Attend with papers', actions }] },
  summary: { type: 'summary', title: 'Week in review',
    items: [{ name: 'Work', points: ['Shipped the theme', 'Planned the next wave'] }, { name: 'Home', attributes: { Groceries: 'Done', Repairs: 'Pending' } }] },
  'form-set': { type: 'form-set', title: 'Plan the trip',
    steps: [{ id: 'when', prompt: 'When do you want to go?', type: 'choice', options: ['This weekend', 'Next month'] }, { id: 'notes', prompt: 'Anything else?', type: 'text' }] },
};

function task(id, state, opts = {}) {
  return {
    task_id: id, tenant_id: 't1', source: 'voice', transcript: opts.text || 'A request',
    request_text: opts.text || 'A request', state, routed_to: '-100_1', routing_reason: null,
    result_summary: opts.summary ?? null, result_short: opts.short ?? null,
    result_structured: opts.structured ? JSON.stringify(opts.structured) : null,
    created_at: OLD, updated_at: opts.updated || NOW, conversation_id: id, steer_mode: null,
    feedback_about: null, surface: null, attachments: opts.attachments || [],
    events: [{ event_id: 'e1', task_id: id, kind: state === 'done' ? 'task.completed' : 'task.progress', payload: {}, created_at: NOW }],
    input_requests: opts.inputs || [],
  };
}
/** The server-derived thread status each fixture conversation shows (thread
 *  lifecycle, 2026-09-17), so the gate paints every tone. */
const STATUS_OF = { 'c-md': 'needs_you', 'c-ready': 'ready', 'c-run': 'running', 'c-wait': 'recorded', 'c-cancel': 'cancelled' };
const RANK_OF = { recorded: 1, needs_you: 2, ready: 3, failed: 4, running: 5, viewed: 6, concluded: 7, cancelled: 8 };
function conv(id, t, title) {
  const status = STATUS_OF[id] ?? 'viewed';
  return {
    conversation_id: id, task_count: 1, request_text: t.request_text, latest_request_text: t.request_text,
    result_summary: t.result_summary, state: t.state, routed_to: t.routed_to, created_at: t.created_at,
    updated_at: t.updated_at, latest_task_id: t.task_id, pending_input_count: (t.input_requests || []).filter((r) => r.status === 'pending').length,
    title, recap: 'Where it stands in one plain sentence.', next_action: null, latest_step: null,
    telegram_link: null, tasks: [t], share: { active: false },
    status, status_rank: RANK_OF[status], band: RANK_OF[status] <= 5 ? 'live' : 'history',
    viewed_at: status === 'viewed' ? NOW : null, answer_landed_at: t.state === 'done' ? NOW : null, failed_unresolved: 0,
  };
}
const longSummary = (lead) => `${lead}\n\n${LONG_MD}`;
const CONVS = {
  'c-md': conv('c-md', task('c-md', 'done', { text: 'Find me a flat', summary: LONG_MD, short: 'The south option is cheaper and closer.',
    attachments: ['photo.png'],
    inputs: [{ request_id: 'ir-1', task_id: 'c-md', kind: 'choice', prompt: 'Which one should I book?', params_json: JSON.stringify({ options: ['North', 'South'] }), status: 'pending', created_at: NOW }] }), 'Flat search'),
  'c-cmp': conv('c-cmp', task('c-cmp', 'done', { text: 'Compare phones', summary: longSummary('Three phones compared.'), short: 'Phone two wins.', structured: STRUCTURED.comparison }), 'Phone comparison'),
  'c-lst': conv('c-lst', task('c-lst', 'done', { text: 'Clinics near me', summary: longSummary('Three clinics.'), short: 'North clinic is closest.', structured: STRUCTURED.listing }), 'Nearby clinics'),
  'c-gde': conv('c-gde', task('c-gde', 'done', { text: 'Passport steps', summary: longSummary('Three steps.'), short: 'Three steps, one done.', structured: STRUCTURED.guide }), 'Passport renewal'),
  'c-sum': conv('c-sum', task('c-sum', 'done', { text: 'Summarise my week', summary: longSummary('Two areas.'), short: 'A good week.', structured: STRUCTURED.summary }), 'Week in review'),
  'c-fs': conv('c-fs', task('c-fs', 'done', { text: 'Plan a trip', summary: 'Answer two questions.', short: 'Two quick questions.', structured: STRUCTURED['form-set'] }), 'Trip planning'),
  'c-ready': conv('c-ready', task('c-ready', 'done', { text: 'What time is the dentist', summary: 'Your dentist visit is at 4 pm on Friday.', short: 'Friday at 4 pm.' }), 'Dentist time'),
  'c-run': conv('c-run', task('c-run', 'running', { text: 'Draft the note' }), 'Weekly note'),
  'c-wait': conv('c-wait', task('c-wait', 'received', { text: 'Still arriving' }), 'New request'),
  'c-cancel': conv('c-cancel', task('c-cancel', 'cancelled', { text: 'Never mind' }), 'Cancelled ask'),
};
// c-ready is Ready (the ring), c-md Needs You, c-run Running, c-wait Recorded, c-cancel Cancelled; the structured ones are Viewed (history band).
const SHARE = { ok: true, conversation: { summary: { request_text: 'Compare phones', state: 'done', result_summary: 'Three phones compared.' },
  meta: { title: 'Phone comparison', recap: 'Phone two wins on camera.', next_action: 'Pick one' },
  turns: [task('c-share', 'done', { text: 'Compare phones', summary: LONG_MD, short: 'Phone two wins.', structured: STRUCTURED.comparison })] } };

// ------------------------------------------------------------------ server --
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(PUBLIC, decodeURIComponent(p));
  if (!file.startsWith(PUBLIC) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ----------------------------------------------------------------- results --
const results = [];
function record(ok, name, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ------------------------------------------------------------ in-page code --
// Injected into every page (and the raw frame) as a string: colour parsing +
// palette collection + the element scan. Runs in the browser.
const PAGE_LIB = `
window.__theme = (() => {
  function oklchToRgb(L, C, H) {
    const a = C * Math.cos(H * Math.PI / 180), b = C * Math.sin(H * Math.PI / 180);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
    return lin.map((v) => enc(Math.min(1, Math.max(0, v))) * 255);
  }
  function oklabToRgb(L, a, b) { return oklchToRgb(L, Math.hypot(a, b), Math.atan2(b, a) * 180 / Math.PI); }
  const num = (s) => s === 'none' ? 0 : (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s));
  function parse(str) {
    if (!str) return null;
    str = str.trim().toLowerCase();
    if (str === 'transparent') return [0, 0, 0, 0];
    let m = /^rgba?\\(([^)]*)\\)$/.exec(str);
    if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = /^oklch\\(([^)]*)\\)$/.exec(str);
    if (m) { const [c, al] = m[1].split('/'); const p = c.trim().split(/\\s+/); return [...oklchToRgb(num(p[0]), num(p[1]), num(p[2])), al ? num(al.trim()) : 1]; }
    m = /^oklab\\(([^)]*)\\)$/.exec(str);
    if (m) { const [c, al] = m[1].split('/'); const p = c.trim().split(/\\s+/); return [...oklabToRgb(num(p[0]), num(p[1]), num(p[2])), al ? num(al.trim()) : 1]; }
    m = /^color\\(srgb ([^)]*)\\)$/.exec(str);
    if (m) { const [c, al] = m[1].split('/'); const p = c.trim().split(/\\s+/).map(num); return [p[0] * 255, p[1] * 255, p[2] * 255, al ? num(al.trim()) : 1]; }
    return null;
  }
  const TOKENS = ${JSON.stringify(Object.keys(EXPECTED.dark))};
  const SYSTEM = ['canvas', 'canvastext', 'buttonface', 'buttontext', 'buttonborder', 'field', 'fieldtext', 'linktext', 'visitedtext', 'activetext', 'graytext', 'highlight', 'highlighttext', 'mark', 'marktext', 'selecteditem', 'selecteditemtext', 'accentcolor', 'accentcolortext'];
  function probe(value) {
    const d = document.createElement('div');
    d.style.color = value;
    document.body.appendChild(d);
    const out = getComputedStyle(d).color;
    d.remove();
    return out;
  }
  function palette() {
    const tokens = {};
    for (const t of TOKENS) tokens[t] = parse(probe('var(' + t + ')'));
    const system = SYSTEM.map((s) => parse(probe(s))).filter(Boolean);
    return { tokens, system };
  }
  const close = (a, b) => Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2 && Math.abs((a[3] ?? 1) - (b[3] ?? 1)) <= 0.011;
  function colours(el, pseudo) {
    const cs = getComputedStyle(el, pseudo);
    const out = [];
    if (pseudo && (cs.content === 'none' || cs.content === 'normal')) return out;
    out.push(['color', cs.color]);
    out.push(['background-color', cs.backgroundColor]);
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (cs['border' + side + 'Style'] !== 'none' && parseFloat(cs['border' + side + 'Width']) > 0) out.push(['border-' + side.toLowerCase() + '-color', cs['border' + side + 'Color']]);
    }
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) out.push(['outline-color', cs.outlineColor]);
    if (cs.boxShadow && cs.boxShadow !== 'none') for (const m of cs.boxShadow.matchAll(/(rgba?\\([^)]*\\)|oklch\\([^)]*\\)|oklab\\([^)]*\\)|color\\([^)]*\\))/g)) out.push(['box-shadow', m[1]]);
    if (cs.accentColor && cs.accentColor !== 'auto') out.push(['accent-color', cs.accentColor]);
    if (el instanceof SVGElement && !pseudo) {
      if (cs.stroke && cs.stroke !== 'none') out.push(['stroke', cs.stroke]);
      if (cs.fill && cs.fill !== 'none') out.push(['fill', cs.fill]);
    }
    return out;
  }
  function rendered(el) { return el.getClientRects().length > 0; }
  function scan(pal) {
    const allowed = [...Object.values(pal.tokens).filter(Boolean), ...pal.system];
    const bad = [];
    let count = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (!rendered(el) || el.closest('.theme-probe')) continue;
      for (const pseudo of [null, '::before', '::after']) {
        for (const [prop, value] of colours(el, pseudo)) {
          count++;
          const c = parse(value);
          if (!c) { bad.push(describe(el) + (pseudo || '') + ' ' + prop + ' unparsed ' + value); continue; }
          if (c[3] === 0) continue;
          if (!allowed.some((a) => close(a, c))) bad.push(describe(el) + (pseudo || '') + ' ' + prop + ' = ' + value);
        }
      }
    }
    return { count, bad };
  }
  function describe(el) {
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    return el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\\s+/).join('.') : '');
  }
  function svgAttrViolations() {
    const bad = [];
    for (const el of document.querySelectorAll('svg, svg *')) {
      for (const attr of ['stroke', 'fill', 'color']) {
        const v = el.getAttribute(attr);
        if (v !== null && v !== 'none' && v !== 'currentColor') bad.push(describe(el) + ' ' + attr + '="' + v + '"');
      }
    }
    return bad;
  }
  return { parse, palette, scan, close, svgAttrViolations, describe };
})();
`;

// ------------------------------------------------------------------ driver --
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

async function openPage(scheme, width, { loggedIn = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 700 ? 844 : 900 },
    colorScheme: scheme, serviceWorkers: 'block', reducedMotion: 'reduce',
  });
  await ctx.grantPermissions(['microphone'], { origin: ORIGIN });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  // The raw-html frame is sandboxed without same-origin, so init scripts that
  // touch storage throw inside it — expected, not an app error.
  page.on('pageerror', (e) => { if (!/sandboxed/.test(e.message)) console.log(`  page error: ${e.message}`); });
  await page.route('**/api/v1/**', (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname.replace('/api/v1/', '');
    const j = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (path === 'me') return j({ ok: true, tenant: { tenant_id: 't1', display_name: 'Test' } });
    if (path === 'conversations') return j({ ok: true, conversations: Object.values(CONVS), total: Object.keys(CONVS).length });
    if (path.startsWith('conversations/')) {
      const id = decodeURIComponent(path.split('/')[1]);
      if (CONVS[id]) return j({ ok: true, conversation: CONVS[id] });
    }
    if (path === 'share/tok-theme') return j(SHARE);
    if (path === 'kb') return j({ ok: true, kb: { topics: [], domains: [] } });
    return j({ ok: true });
  });
  await page.route('**/frames/raw**', (route) => {
    const d = new URL(route.request().url()).searchParams.get('d') || '';
    route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" }, body: Buffer.from(d, 'base64url').toString('utf8') });
  });
  await page.route('**/s/tok-theme', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: readFileSync(join(PUBLIC, 'share.html'), 'utf8') }));
  if (loggedIn) {
    await page.addInitScript(`try{localStorage.setItem('vi.session_token','test-token');localStorage.setItem('vi.tenant_id','t1');}catch(e){}`);
  }
  await page.addInitScript(PAGE_LIB);
  return { ctx, page };
}

// Two frames, then every FINITE running animation/transition finishes (capped at
// 2 s): a colour transition mid-flight computes an interpolated value that is
// in no palette. Infinite animations (pulses) are excluded — they never finish.
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(async () => {
  const finite = document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity);
  await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => {}))), new Promise((t) => setTimeout(t, 2000))]);
  setTimeout(r, 50);
}))));

async function openAllToggles(page) {
  for (let i = 0; i < 10; i++) {
    const t = page.locator('.answer-toggle[aria-expanded="false"]').first();
    if (!(await t.count())) break;
    await t.click();
    await settle(page);
  }
}

// Each view: how to reach it, and the selectors that prove it really rendered
// (a scan of an empty page would pass vacuously).
const VIEWS = [
  { name: 'login', loggedIn: false, go: async (p) => { await p.goto(ORIGIN + '/index.html'); await p.waitForSelector('.login'); }, expect: ['.login', '.act-primary'] },
  { name: 'list', go: async (p) => { await p.goto(ORIGIN + '/index.html'); await p.waitForSelector('.row-ready'); }, expect: ['.row-ready', '.row-wrap', '.mic-btn'] },
  ...['c-md', 'c-cmp', 'c-lst', 'c-gde', 'c-sum', 'c-fs'].map((id) => ({
    name: 'conversation-' + id.slice(2),
    go: async (p) => {
      await p.goto(ORIGIN + '/index.html'); await p.waitForSelector('.row-wrap');
      await p.evaluate((cid) => navigate('conversation', cid), id);
      await p.waitForSelector('.turn-assistant'); await settle(p); await openAllToggles(p);
    },
    expect: { 'c-md': ['.chip', '.answer-table', '.answer-raw-frame', '.widget .option', '.attach-chip'], 'c-cmp': ['.cmp-card', '.act.cmp-act'], 'c-lst': ['.lst-item', '.act.cmp-act'], 'c-gde': ['.gde-step', '.gde-check[aria-checked="true"]'], 'c-sum': ['.sum-card'], 'c-fs': ['.formset', '.formset-option'] }[id],
  })),
  { name: 'sheet-more-actions', go: async (p) => {
      await p.goto(ORIGIN + '/index.html'); await p.waitForSelector('.row-wrap');
      await p.evaluate(() => navigate('conversation', 'c-cmp')); await p.waitForSelector('.turn-assistant');
      await p.locator('button[aria-label="More actions"]').first().click(); await p.waitForSelector('.sheet .menu-row'); await settle(p);
    }, expect: ['.scrim', '.sheet', '.menu-row'] },
  { name: 'sheet-recording', go: async (p) => {
      await p.goto(ORIGIN + '/index.html'); await p.waitForSelector('.mic-btn');
      await p.locator('.mic-btn').first().click(); await p.waitForSelector('.halo-core', { timeout: 8000 }); await settle(p);
    }, expect: ['.sheet', '.halo-core', '.halo-stop'] },
  { name: 'share', loggedIn: false, go: async (p) => { await p.goto(ORIGIN + '/s/tok-theme'); await p.waitForSelector('#share-turns > *'); await settle(p); await openAllToggles(p); }, expect: ['#share-turns > *', '.title'] },
];

const WIDTHS = [390, 1280];
const SCHEMES = ['dark', 'light'];
const shotIndex = [];

for (const scheme of SCHEMES) {
  for (const width of WIDTHS) {
    for (const view of VIEWS) {
      if (ONLY && !ONLY.includes(view.name)) continue;
      const label = `${view.name} ${scheme} ${width}`;
      const { ctx, page } = await openPage(scheme, width, { loggedIn: view.loggedIn !== false });
      try {
        await view.go(page);
        const missing = [];
        for (const sel of view.expect) if (!(await page.locator(sel).count())) missing.push(sel);
        record(missing.length === 0, `render ${label}`, missing.length ? 'missing ' + missing.join(', ') : '');
        // Review screenshots come first, before G6/G7 flip the scheme or flash a
        // card. Viewport-sized (a full-page capture smears the fixed footer and
        // sticky bars across the page); conversation views add a second shot
        // scrolled to the answer.
        if (SHOTS) {
          mkdirSync(SHOTS, { recursive: true });
          const top = `${scheme}-${width}-${view.name}.png`;
          await page.screenshot({ path: join(SHOTS, top) });
          shotIndex.push({ scheme, width, view: view.name, file: top });
          if (view.name.startsWith('conversation-')) {
            await page.locator(view.expect[0]).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
            await settle(page);
            const answer = `${scheme}-${width}-${view.name}-answer.png`;
            await page.screenshot({ path: join(SHOTS, answer) });
            shotIndex.push({ scheme, width, view: view.name + '-answer', file: answer });
            await page.evaluate(() => window.scrollTo(0, 0));
          }
        }
        const pal = await page.evaluate(() => window.__theme.palette());
        const scan = await page.evaluate((p) => window.__theme.scan(p), pal);
        record(scan.bad.length === 0 && scan.count > 20, `G1 palette ${label}`, `${scan.count} colours` + (scan.bad.length ? `; ${scan.bad.length} off-palette: ${scan.bad.slice(0, 6).join(' | ')}` : ''));
        const svgBad = await page.evaluate(() => window.__theme.svgAttrViolations());
        record(svgBad.length === 0, `G2a svg attributes ${label}`, svgBad.slice(0, 4).join(' | '));
        const scheme2 = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
        record(scheme2 === scheme, `G3 color-scheme ${label}`, `computed "${scheme2}"`);
        if (view.name === 'list' || view.name === 'share') {
          const off = [];
          for (const [tok, exp] of Object.entries(EXPECTED[scheme])) {
            const got = pal.tokens[tok];
            const want = exp.length === 4 ? exp : [...exp, 1];
            if (!got || !(await page.evaluate(([a, b]) => window.__theme.close(a, b), [got, want]))) off.push(`${tok} got ${got && got.map((v) => +(+v).toFixed(2)).join(',')} want ${want.join(',')}`);
          }
          record(off.length === 0, `G1b token values ${label}`, off.slice(0, 5).join(' | '));
          const canvas = await page.evaluate(() => {
            const read = (t) => { const d = document.createElement('div'); d.style.color = `var(${t})`; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove();
              const cv = document.createElement('canvas'); cv.width = cv.height = 1; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 1, 1); return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3); };
            return { ground: read('--ground'), accentInk: read('--accent-ink') };
          });
          const g4 = ['ground', 'accentInk'].every((k) => {
            const want = EXPECTED[scheme][k === 'ground' ? '--ground' : '--accent-ink'];
            return canvas[k].every((v, i) => Math.abs(v - want[i]) <= 1);
          });
          record(g4, `G4 canvas readback ${label}`, JSON.stringify(canvas));
          const meta = await page.evaluate(() => {
            const metas = [...document.querySelectorAll('meta[name="theme-color"]')].filter((m) => !m.media || matchMedia(m.media).matches);
            const body = window.__theme.parse(getComputedStyle(document.body).backgroundColor);
            return { contents: metas.map((m) => m.content), body: body && body.slice(0, 3).map(Math.round) };
          });
          const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
          const g5 = meta.contents.length === 1 && meta.contents[0].toLowerCase() === THEME_COLOR[scheme] && meta.body && hexToRgb(meta.contents[0]).every((v, i) => Math.abs(v - meta.body[i]) <= 2);
          record(g5, `G5 theme-color ${label}`, JSON.stringify(meta));
        }
        if (view.name === 'conversation-md' && width === 390) {
          const frame = page.frames().find((f) => f.url().includes('/frames/raw'));
          let g6 = false; let detail = 'no raw frame';
          if (frame) {
            await frame.waitForLoadState();
            const read = () => frame.evaluate(() => getComputedStyle(document.body).color);
            const before = await read();
            const other = scheme === 'dark' ? 'light' : 'dark';
            await page.emulateMedia({ colorScheme: other }); await settle(page);
            const after = await read();
            await page.emulateMedia({ colorScheme: scheme }); await settle(page);
            g6 = before !== after; detail = `${scheme}: ${before} -> ${other}: ${after}`;
          }
          record(g6, `G6 raw frame follows scheme ${label}`, detail);
        }
        if ((view.name === 'conversation-md' || view.name === 'conversation-cmp') && width === 390) {
          // G7: tap a section chip; 850 ms later (the 0.8 s transition has run,
          // the 1.1 s removal has not) the target carries the flash tint. The
          // click and the read happen inside one page task so Playwright's own
          // actionability waits cannot push the read past the removal.
          const flash = await page.evaluate(() => new Promise((done) => {
            const chip = document.querySelector('.chip-row .chip');
            if (!chip) return done({ found: false, reason: 'no section chip' });
            chip.click();
            setTimeout(() => {
              const el = document.querySelector('.chip-flash');
              if (!el) return done({ found: false, reason: 'no .chip-flash element' });
              const d = document.createElement('div'); d.style.color = 'var(--accent-tint-hover)'; document.body.appendChild(d);
              const want = window.__theme.parse(getComputedStyle(d).color); d.remove();
              done({ found: true, bg: window.__theme.parse(getComputedStyle(el).backgroundColor), want });
            }, 850);
          }));
          const g7 = flash.found && flash.bg && flash.want && (await page.evaluate(([a, b]) => window.__theme.close(a, b), [flash.bg, flash.want]));
          record(!!g7, `G7 chip flash ${label}`, JSON.stringify(flash));
        }
      } catch (e) {
        record(false, `render ${label}`, e.message.split('\n')[0]);
      } finally {
        await ctx.close();
      }
    }
  }
}

// G2: live switch — render in dark, stamp every node, flip to light with no
// reload, and require (a) the same nodes are still there, (b) every tone-classed
// icon changed colour, (c) the whole scan passes against the LIGHT palette.
for (const viewName of ['list', 'conversation-md', 'conversation-cmp']) {
  if (ONLY && !ONLY.includes(viewName)) continue;
  const view = VIEWS.find((v) => v.name === viewName);
  const { ctx, page } = await openPage('dark', 390);
  const label = `${viewName} dark->light 390`;
  try {
    await view.go(page);
    let ok = false; let detail = '';
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const before = await page.evaluate(() => {
        let n = 0; const icons = [];
        for (const el of document.body.querySelectorAll('*')) el.__themeStamp = ++n;
        for (const svg of document.querySelectorAll('svg[class*="tone-"]')) icons.push([svg.__themeStamp, getComputedStyle(svg).stroke]);
        return { n, icons };
      });
      await page.emulateMedia({ colorScheme: 'light' }); await settle(page);
      const after = await page.evaluate((icons) => {
        const all = [...document.body.querySelectorAll('*')];
        const stamped = all.filter((el) => el.__themeStamp).length;
        const byStamp = new Map(all.map((el) => [el.__themeStamp, el]));
        const unchanged = icons.filter(([s, stroke]) => byStamp.get(s) && getComputedStyle(byStamp.get(s)).stroke === stroke).length;
        const pal = window.__theme.palette();
        return { stamped, total: all.length, unchanged, iconCount: icons.length, scan: window.__theme.scan(pal) };
      }, before.icons);
      ok = after.stamped === before.n && after.iconCount > 0 && after.unchanged === 0 && after.scan.bad.length === 0;
      detail = `stamped ${after.stamped}/${before.n}, tone icons ${after.iconCount}, unchanged ${after.unchanged}, off-palette ${after.scan.bad.length}${after.scan.bad.length ? ': ' + after.scan.bad.slice(0, 4).join(' | ') : ''}`;
      if (!ok && after.stamped !== before.n) { await page.emulateMedia({ colorScheme: 'dark' }); await settle(page); continue; }
      break;
    }
    record(ok, `G2 live switch ${label}`, detail);
  } catch (e) {
    record(false, `G2 live switch ${label}`, e.message.split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

await browser.close();
server.close();

if (SHOTS) {
  const rows = [...new Set(shotIndex.map((s) => s.view))].map((v) => `<tr><th>${v}</th>${['dark', 'light'].flatMap((sc) => WIDTHS.map((w) => {
    const s = shotIndex.find((x) => x.view === v && x.scheme === sc && x.width === w);
    return `<td>${s ? `<a href="${s.file}"><img src="${s.file}" loading="lazy"></a>` : ''}<br>${sc} ${w}</td>`;
  })).join('')}</tr>`).join('\n');
  writeFileSync(join(SHOTS, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Theme review</title><style>body{font:14px system-ui;margin:16px}img{width:220px;border:1px solid #888}td,th{vertical-align:top;padding:6px}</style><table>${rows}</table>`);
}

if (ONLY) record(false, 'narrowed run (--only) is never a full gate');
const failed = results.filter((r) => !r).length;
if (failed) { console.log(`THEME GATE: FAIL (${failed} of ${results.length} checks)`); process.exit(1); }
console.log(`THEME GATE: PASS (${results.length} checks)`);
process.exit(0);
