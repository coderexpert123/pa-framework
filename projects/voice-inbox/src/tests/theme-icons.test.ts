/**
 * Light/dark theme — script side (2026-09-16).
 *
 * An OS light/dark flip repaints only what reads its colour from CSS at paint
 * time. A colour that script resolved once (getComputedStyle → an svg stroke
 * attribute or an inline style) is frozen at the scheme the page loaded in —
 * the "stale dark icon" defect this wave removed from 11 icon call sites and
 * the section-chip flash. These tests pin the rule over every call site in the
 * shell scripts (not a checklist of known sites — the wire-it-at-every-call-site
 * class):
 *
 *   T4a every icon helper call passes the literal 'currentColor'
 *   T4b no script resolves or embeds a colour (state.tone, getPropertyValue('--…'),
 *       inline colour styles, colour setAttribute, colour functions, hex strings)
 *   T4c every tone-* class a script uses is defined in styles.css, and the
 *       chip flash is a class the stylesheet defines LAST
 *
 * THEME_PUBLIC points the file-reading tests at a different public/ directory
 * (relative to the package root, or absolute) — run against the pre-theme HEAD
 * export they fail with 11 icon sites.
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function publicDir(): string {
  return process.env.THEME_PUBLIC ? resolve(PKG_ROOT, process.env.THEME_PUBLIC) : join(PKG_ROOT, 'public');
}
function readPublic(name: string): string {
  return readFileSync(join(publicDir(), name), 'utf8');
}

/** Block and line comments out; a `//` preceded by `:` (a URL) is kept. */
function stripJsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

const ICON_CALL = /\b(micMark|chevron|chevronSvg|strokeIcon|[a-z][A-Za-z]*Icon)\(\s*\d+\s*,\s*([^,)]+?)\s*[,)]/g;

function iconToneViolations(src: string): { total: number; bad: string[] } {
  const bad: string[] = [];
  let total = 0;
  for (const m of stripJsComments(src).matchAll(ICON_CALL)) {
    total++;
    if (m[2] !== "'currentColor'") bad.push(`${m[1]}(…, ${m[2]})`);
  }
  return { total, bad };
}

const RESOLVED_COLOUR_PATTERNS: Array<[RegExp, string]> = [
  [/\bstate\.tone\b/, 'state.tone'],
  [/\btone:\s*null/, 'a state tone field'],
  [/getPropertyValue\(\s*['"`]--/, "getPropertyValue('--"],
  [/\.style\.(backgroundColor|color|background|borderColor|fill|stroke)\s*=\s*['"`][^'"`]+['"`]/, 'an inline colour style'],
  [/setAttribute\(\s*['"`](fill|stroke|color)['"`]\s*,(?!\s*['"`](currentColor|none)['"`])/, 'a colour setAttribute'],
  [/\b(oklch|oklab|lab|lch|rgba?|hsla?|hwb|color|color-mix)\(/, 'a colour function'],
  [/['"`]#[0-9a-fA-F]{3,8}['"`]/, 'a hex colour string'],
];

function resolvedColourViolations(src: string): string[] {
  const body = stripJsComments(src);
  const bad: string[] = [];
  for (const [re, label] of RESOLVED_COLOUR_PATTERNS) {
    const m = re.exec(body);
    if (m) bad.push(`${label}: ${m[0]}`);
  }
  return bad;
}

const SCRIPTS = ['app.js', 'share.js', 'live-pane.js', 'answer-shapes.js'];

describe('theme script detectors fail on known-bad input (the checks can fail)', () => {
  it('T4a flags a resolved tone and a local tone variable, and ignores a commented call', () => {
    const src = [
      "micMark(14, state.tone.dim, 4);",
      "const tone = x ? state.tone.faint : state.tone.dim;",
      "micMark(14, tone, 3);",
      "chevron(12, 'currentColor', 'M9 6l6 6-6 6', 'recap-chevron tone-faint');",
      "// micMark(16, state.tone.accent, 0);",
    ].join('\n');
    const r = iconToneViolations(src);
    assert.equal(r.total, 3);
    assert.deepEqual(r.bad, ['micMark(…, state.tone.dim)', 'micMark(…, tone)']);
  });

  it('T4b flags each way a script can freeze a colour', () => {
    const cases = [
      "state.tone = {};",
      "const s = { tone: null };",
      "rootStyle.getPropertyValue('--dim')",
      "target.style.backgroundColor = 'oklch(0.78 0.15 85 / 0.14)';",
      "el.setAttribute('stroke', tone);",
      "const c = 'rgba(0, 0, 0, 0.5)';",
      "const c = '#101419';",
    ];
    for (const c of cases) assert.ok(resolvedColourViolations(c).length > 0, c);
    assert.deepEqual(resolvedColourViolations("el.setAttribute('stroke', 'currentColor'); target.style.backgroundColor = '';"), []);
  });
});

describe('theme: shell scripts', () => {
  it('T4a every icon helper call in app.js and share.js passes currentColor', () => {
    const app = iconToneViolations(readPublic('app.js'));
    // Without a floor the check could pass by matching nothing.
    assert.ok(app.total >= 60, `expected >= 60 icon calls in app.js, matched ${app.total}`);
    assert.deepEqual(app.bad, []);
    const share = iconToneViolations(readPublic('share.js'));
    assert.ok(share.total >= 1, 'share.js chevronSvg call not matched');
    assert.deepEqual(share.bad, []);
  });

  for (const file of SCRIPTS) {
    it(`T4b ${file} never resolves or embeds a colour`, () => {
      assert.deepEqual(resolvedColourViolations(readPublic(file)), []);
    });
  }

  it('T4c every tone-* class the scripts use is defined in styles.css', () => {
    const css = readPublic('styles.css');
    const used = new Set<string>();
    for (const file of ['app.js', 'share.js']) {
      for (const m of stripJsComments(readPublic(file)).matchAll(/\btone-[a-z]+\b/g)) used.add(m[0]);
    }
    assert.ok(used.size >= 3, `expected tone-accent/tone-dim/tone-faint in use, found ${[...used].join(', ')}`);
    for (const cls of used) assert.match(css, new RegExp('\\.' + cls + '\\s*\\{[^}]*color:\\s*var\\(--'), `${cls} is not defined`);
  });

  it('T4c both chip rows flash by class, and .chip-flash is the last rule in styles.css', () => {
    for (const file of ['app.js', 'share.js']) {
      const src = readPublic(file);
      assert.ok(src.includes("target.classList.add('chip-flash');"), `${file} must add the chip-flash class`);
      assert.ok(src.includes("target.classList.remove('chip-flash');"), `${file} must remove the chip-flash class`);
    }
    const css = readPublic('styles.css').replace(/\/\*[\s\S]*?\*\//g, '').trimEnd();
    assert.ok(css.endsWith('.chip-flash { background-color: var(--accent-tint-hover); }'),
      '.chip-flash must be the final rule — it beats the equal-specificity card backgrounds on source order');
  });
});
