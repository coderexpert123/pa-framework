/**
 * Light/dark theme token contract (2026-09-16).
 *
 * The PWA follows the device's light or dark setting in CSS alone: every
 * colour is a token declared in exactly two blocks of public/styles.css — the
 * dark `:root` default and the `@media (prefers-color-scheme: light)` override.
 * These tests pin that model from the source side:
 *
 *   T1  no colour literal outside the two token blocks (styles.css rules,
 *       keyframes included) and no reference to an undeclared token
 *   T2  both blocks declare exactly the same colour-token set, and that set
 *       is the one the theme spec fixes — a token missing from the light block
 *       would silently leak its dark value into the light scheme
 *   T3  every text/control pair meets its contrast floor in BOTH schemes,
 *       every opaque token is inside the sRGB gamut
 *   T5  the scheme metas (index.html, share.html), the manifest colours and
 *       the auth-callback pages agree with the tokens
 *   T6  the stylesheet header no longer claims a single scheme
 *
 * Each detector is proven able to fail on an inline known-bad fixture before
 * it is trusted on the real file (this program shipped three inert checks: a
 * regex matching its own comment, a literal version pin, and CSS-text
 * assertions a later equal-specificity rule overrode). Computed-style proof —
 * what the browser actually paints, and the live scheme flip — is the separate
 * scripts/theme_gate.mjs gate; these tests cannot see the cascade.
 *
 * THEME_PUBLIC points the file-reading tests at a different public/ directory
 * (relative to the package root, or absolute) — used to prove they fail on the
 * pre-theme HEAD export.
 */

import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_PAGE_FAIL, AUTH_PAGE_OK } from '../auth-callback.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function publicDir(): string {
  return process.env.THEME_PUBLIC ? resolve(PKG_ROOT, process.env.THEME_PUBLIC) : join(PKG_ROOT, 'public');
}
function readPublic(name: string): string {
  return readFileSync(join(publicDir(), name), 'utf8');
}

/** The colour-token set the theme spec fixes, in declaration order. */
const COLOUR_TOKENS = [
  '--ground', '--raised', '--raised-hover', '--ink', '--dim', '--faint',
  '--ring', '--hairline', '--accent', '--on-accent', '--accent-ink', '--on-accent-ink',
  '--accent-tint-soft', '--accent-tint', '--accent-tint-hover', '--accent-tint-active',
  '--accent-glow', '--select', '--select-glow', '--select-tint',
  '--scrim', '--scrim-alpha',
];

// ------------------------------------------------------------ CSS parsing --

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Index of the `}` closing the `{` at openIdx. */
function matchBrace(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface TokenBlocks { dark: string; light: string; rest: string }

/** Split a stylesheet into the dark token block body, the light token block
 *  body, and everything else (comments stripped). Throws when either block is
 *  missing, a third :root exists, or prefers-color-scheme appears elsewhere. */
function splitTokenBlocks(cssRaw: string): TokenBlocks {
  const css = stripCssComments(cssRaw);
  const roots = [...css.matchAll(/:root\s*\{/g)];
  if (roots.length !== 2) throw new Error(`expected exactly 2 :root blocks, found ${roots.length}`);
  const darkOpen = css.indexOf('{', roots[0].index);
  const darkClose = matchBrace(css, darkOpen);
  const medias = [...css.matchAll(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{/g)];
  if (medias.length !== 1) throw new Error(`expected exactly 1 light media block, found ${medias.length}`);
  const mediaIdx = medias[0].index as number;
  const mOpen = css.indexOf('{', mediaIdx);
  const mClose = matchBrace(css, mOpen);
  const innerRoot = /^\s*:root\s*\{([\s\S]*)\}\s*$/.exec(css.slice(mOpen + 1, mClose));
  if (!innerRoot) throw new Error('the light media block must hold exactly one :root block and nothing else');
  if (!(darkClose < mediaIdx)) throw new Error('the dark :root block must come before the light media block');
  const rest = css.slice(0, roots[0].index) + css.slice(darkClose + 1, mediaIdx) + css.slice(mClose + 1);
  if (/prefers-color-scheme/.test(rest)) throw new Error('prefers-color-scheme may appear only in the light token block');
  return { dark: css.slice(darkOpen + 1, darkClose), light: innerRoot[1], rest };
}

function parseDecls(blockBody: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of blockBody.split(';')) {
    const m = /^\s*(--[a-z0-9-]+|color-scheme)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const COLOUR_PROPS = new Set([
  'color', 'background', 'background-color', 'border', 'border-top', 'border-right',
  'border-bottom', 'border-left', 'border-color', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'outline', 'outline-color', 'box-shadow',
  'fill', 'stroke', 'accent-color', 'caret-color', 'text-decoration', 'text-decoration-color',
  'column-rule', 'column-rule-color', '-webkit-tap-highlight-color', 'text-shadow',
]);
const ALLOWED_WORDS = new Set([
  'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none', 'solid', 'dashed',
  'dotted', 'double', 'inset', 'underline', 'overline', 'line-through', 'wavy', 'auto',
]);

/** Colour literals in the non-token part of a stylesheet: any colour
 *  function or hex anywhere (keyframes included), plus any colour-bearing
 *  declaration whose value holds a word that is not var(--token), a number or
 *  length, or an allowed keyword — which is how a named colour is caught. */
function literalViolations(rest: string): string[] {
  const bad: string[] = [];
  for (const m of rest.matchAll(/\b(oklch|oklab|lab|lch|rgba?|hsla?|hwb|color|color-mix|light-dark)\(/gi)) {
    bad.push(`colour function ${m[0]}`);
  }
  for (const m of rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) bad.push(`hex ${m[0]}`);
  for (const m of rest.matchAll(/([-a-z]+)\s*:\s*([^;{}]+)[;}]/g)) {
    const prop = m[1].toLowerCase();
    if (!COLOUR_PROPS.has(prop)) continue;
    const residue = m[2]
      .replace(/var\(--[a-z0-9-]+\)/g, ' ')
      .replace(/-?\d*\.?\d+(px|em|rem|%|s|ms|deg)?/g, ' ')
      .replace(/[(),!]/g, ' ')
      .replace(/\bimportant\b/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => !ALLOWED_WORDS.has(w.toLowerCase()));
    if (residue.length) bad.push(`${prop}: ${m[2].trim()} (unexpected: ${residue.join(' ')})`);
  }
  return bad;
}

function unknownTokenRefs(rest: string, declared: Set<string>): string[] {
  const bad: string[] = [];
  for (const m of rest.matchAll(/var\((--[a-z0-9-]+)\)/g)) if (!declared.has(m[1])) bad.push(m[1]);
  return bad;
}

// ----------------------------------------------------------- colour math --

type Rgb = [number, number, number];

function oklchToSrgb(L: number, C: number, H: number): { rgb: Rgb; inGamut: boolean } {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const inGamut = lin.every((v) => v >= -0.0005 && v <= 1.0005);
  const enc = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  return { rgb: lin.map((v) => enc(Math.min(1, Math.max(0, v)))) as Rgb, inGamut };
}
function toHex(rgb: Rgb): string {
  return '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
function relLum(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: Rgb, b: Rgb): number {
  const x = relLum(a), y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as Rgb;
}

interface Resolved {
  opaque: Map<string, Rgb>;
  mix: Map<string, { base: string; alpha: number }>;
  number: Map<string, number>;
  errors: string[];
}

/** Resolve one scheme's declarations. Only three value forms are allowed:
 *  `oklch(L C H)`, `color-mix(in oklch, var(--token) N%, transparent)`, and a
 *  bare number (--scrim-alpha). */
function resolveScheme(decls: Map<string, string>): Resolved {
  const r: Resolved = { opaque: new Map(), mix: new Map(), number: new Map(), errors: [] };
  for (const [k, v] of decls) {
    if (k === 'color-scheme' || k === '--pad') continue;
    let m: RegExpExecArray | null;
    if ((m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v))) {
      const c = oklchToSrgb(+m[1], +m[2], +m[3]);
      if (!c.inGamut) r.errors.push(`${k} is outside the sRGB gamut`);
      r.opaque.set(k, c.rgb);
    } else if ((m = /^color-mix\(in oklch,\s*var\((--[a-z-]+)\)\s+([\d.]+)%,\s*transparent\)$/.exec(v))) {
      r.mix.set(k, { base: m[1], alpha: +m[2] / 100 });
    } else if ((m = /^([\d.]+)$/.exec(v))) {
      r.number.set(k, +m[1]);
    } else {
      r.errors.push(`${k}: unsupported value form "${v}"`);
    }
  }
  return r;
}

/** [foreground, background, minimum ratio, tint composited over the background]. */
const PAIRS: Array<[string, string, number, string?]> = [
  ['--ink', '--ground', 7], ['--ink', '--raised', 7], ['--ink', '--raised-hover', 7],
  ['--dim', '--ground', 4.5], ['--dim', '--raised', 4.5],
  ['--faint', '--ground', 4.5], ['--faint', '--raised', 4.5],
  ['--accent-ink', '--ground', 4.5], ['--accent-ink', '--raised', 4.5], ['--accent-ink', '--raised-hover', 4.5],
  ['--accent-ink', '--ground', 4.5, '--accent-tint'], ['--accent-ink', '--raised', 4.5, '--accent-tint'],
  ['--accent-ink', '--ground', 4.5, '--accent-tint-hover'], ['--accent-ink', '--raised', 4.5, '--accent-tint-hover'],
  ['--accent-ink', '--raised', 4.5, '--accent-tint-active'],
  ['--ink', '--ground', 4.5, '--accent-tint-soft'], ['--dim', '--ground', 4.5, '--accent-tint-soft'],
  ['--faint', '--ground', 4.5, '--accent-tint-soft'], ['--ink', '--ground', 4.5, '--accent-tint-hover'],
  ['--on-accent', '--accent', 4.5], ['--on-accent-ink', '--accent-ink', 4.5],
  ['--ring', '--ground', 3], ['--ring', '--raised', 3],
  ['--hairline', '--ground', 1.25], ['--hairline', '--raised', 1.15],
  ['--raised', '--ground', 1.1],
];

function pairFailures(r: Resolved): string[] {
  const out: string[] = [];
  for (const [fg, bg, min, tint] of PAIRS) {
    const f = r.opaque.get(fg);
    let back = r.opaque.get(bg);
    if (!f || !back) { out.push(`${fg} on ${bg}: token missing`); continue; }
    if (tint) {
      const t = r.mix.get(tint);
      const base = t && r.opaque.get(t.base);
      if (!t || !base) { out.push(`${tint}: token missing`); continue; }
      back = over(base, t.alpha, back);
    }
    const ratio = contrast(f, back);
    if (!(ratio >= min)) out.push(`${fg} on ${tint ? tint + ' over ' : ''}${bg}: ${ratio.toFixed(2)} < ${min}`);
  }
  return out;
}

function schemes(css: string): { dark: Resolved; light: Resolved; blocks: TokenBlocks } {
  const blocks = splitTokenBlocks(css);
  return { dark: resolveScheme(parseDecls(blocks.dark)), light: resolveScheme(parseDecls(blocks.light)), blocks };
}

// ------------------------------------------------------ known-bad proofs --

const GOOD_FIXTURE = [
  ':root { --ground: oklch(0.18 0.012 250); color-scheme: dark; }',
  '@media (prefers-color-scheme: light) { :root { --ground: oklch(0.99 0.002 250); color-scheme: light; } }',
  '/* a comment naming oklch(0.5 0 0) and color-mix( must not count */',
  '.a { color: var(--ground); border: 1px solid transparent; text-decoration: underline dotted; }',
].join('\n');

describe('theme detectors fail on known-bad input (the checks can fail)', () => {
  it('T1 passes the good fixture — a literal inside a comment does not count', () => {
    const { rest } = splitTokenBlocks(GOOD_FIXTURE);
    assert.deepEqual(literalViolations(rest), []);
  });

  it('T1 flags a colour function inside a rule', () => {
    const { rest } = splitTokenBlocks(GOOD_FIXTURE + '\n.b { background: oklch(0.78 0.15 85 / 0.22); }');
    assert.ok(literalViolations(rest).length > 0);
  });

  it('T1 flags color-mix outside the token blocks', () => {
    const { rest } = splitTokenBlocks(GOOD_FIXTURE + '\n.b { background: color-mix(in oklch, var(--ground) 14%, transparent); }');
    assert.ok(literalViolations(rest).length > 0);
  });

  it('T1 flags a literal inside keyframes', () => {
    const { rest } = splitTokenBlocks(GOOD_FIXTURE + '\n@keyframes p { 0% { box-shadow: 0 0 4px rgba(0, 0, 0, 0.1); } }');
    assert.ok(literalViolations(rest).length > 0);
  });

  it('T1 flags a named colour and a hex colour', () => {
    assert.ok(literalViolations(splitTokenBlocks(GOOD_FIXTURE + '\n.b { border: 1px solid white; }').rest).length > 0);
    assert.ok(literalViolations(splitTokenBlocks(GOOD_FIXTURE + '\n.b { color: #101419; }').rest).length > 0);
  });

  it('T1 flags a reference to an undeclared token', () => {
    const { rest, dark } = splitTokenBlocks(GOOD_FIXTURE + '\n.b { color: var(--accent-inc); }');
    assert.deepEqual(unknownTokenRefs(rest, new Set(parseDecls(dark).keys())), ['--accent-inc']);
  });

  it('the block splitter refuses a single-scheme stylesheet and a stray scheme query', () => {
    assert.throws(() => splitTokenBlocks(':root { --ground: oklch(0.19 0.012 250); }'));
    assert.throws(() => splitTokenBlocks(GOOD_FIXTURE + '\n@media (prefers-color-scheme: dark) { .x { color: var(--ground); } }'));
  });

  it('T2 flags a token missing from the light block', () => {
    const css = ':root { --ground: oklch(0.18 0.012 250); --ink: oklch(0.95 0.008 250); }\n' +
      '@media (prefers-color-scheme: light) { :root { --ground: oklch(0.99 0.002 250); } }';
    const { dark, light } = splitTokenBlocks(css);
    assert.notDeepEqual([...parseDecls(dark).keys()].sort(), [...parseDecls(light).keys()].sort());
  });

  it('T3 flags a failing contrast pair and an out-of-gamut token', () => {
    const real = readFileSync(join(PKG_ROOT, 'public', 'styles.css'), 'utf8');
    // The pre-theme gold accent used as light-scheme text: ~1.9:1 on white.
    const goldText = real.replace(/(prefers-color-scheme: light\)[\s\S]*?--accent-ink:\s*)oklch\([^)]*\)/, '$1oklch(0.78 0.15 85)');
    assert.notEqual(goldText, real, 'fixture substitution did not apply');
    assert.ok(pairFailures(schemes(goldText).light).some((f) => f.startsWith('--accent-ink on')));
    // The pre-theme dark surfaces: raised only 0.04 lighter than ground.
    const flatSurfaces = real.replace(/(:root\s*\{[\s\S]*?--raised:\s*)oklch\([^)]*\)/, '$1oklch(0.215 0.012 250)');
    assert.ok(pairFailures(schemes(flatSurfaces).dark).some((f) => f.startsWith('--raised on --ground')));
    const outOfGamut = real.replace(/(:root\s*\{[\s\S]*?--accent:\s*)oklch\([^)]*\)/, '$1oklch(0.8 0.4 82)');
    assert.ok(schemes(outOfGamut).dark.errors.some((e) => e.includes('gamut')));
  });
});

// ------------------------------------------------------------- the files --

describe('theme tokens: styles.css', () => {
  it('T1 no colour literal and no unknown token outside the two token blocks', () => {
    const { rest, dark } = splitTokenBlocks(readPublic('styles.css'));
    assert.deepEqual(literalViolations(rest), []);
    assert.deepEqual(unknownTokenRefs(rest, new Set([...parseDecls(dark).keys()])), []);
  });

  it('T2 both blocks declare exactly the spec colour-token set, with their own color-scheme', () => {
    const { dark, light } = splitTokenBlocks(readPublic('styles.css'));
    const d = parseDecls(dark);
    const l = parseDecls(light);
    const colourKeys = (m: Map<string, string>) => [...m.keys()].filter((k) => k !== '--pad' && k !== 'color-scheme').sort();
    assert.deepEqual(colourKeys(d), [...COLOUR_TOKENS].sort(), 'dark block token set');
    assert.deepEqual(colourKeys(l), [...COLOUR_TOKENS].sort(), 'light block token set');
    assert.equal(d.get('color-scheme'), 'dark');
    assert.equal(l.get('color-scheme'), 'light');
    assert.equal(l.has('--pad'), false, 'non-colour tokens live in the dark block only');
  });

  it('T3 every pair meets its floor in both schemes and every token is in gamut', () => {
    const { dark, light } = schemes(readPublic('styles.css'));
    assert.deepEqual(dark.errors, [], 'dark value forms / gamut');
    assert.deepEqual(light.errors, [], 'light value forms / gamut');
    assert.deepEqual(pairFailures(dark), [], 'dark contrast floors');
    assert.deepEqual(pairFailures(light), [], 'light contrast floors');
    assert.equal(dark.number.get('--scrim-alpha'), 0.72);
    assert.equal(light.number.get('--scrim-alpha'), 0.4);
  });
});

describe('theme metas, manifest and auth pages', () => {
  // Resolved inside each test, never at describe time: a stylesheet that
  // fails to parse must fail these tests, not abort the file.
  function grounds(): { darkHex: string; lightHex: string } {
    const { dark, light } = schemes(readPublic('styles.css'));
    return {
      darkHex: toHex(dark.opaque.get('--ground') as Rgb),
      lightHex: toHex(light.opaque.get('--ground') as Rgb),
    };
  }

  it('T5 the grounds are the fixed theme-color values', () => {
    const { darkHex, lightHex } = grounds();
    assert.equal(darkHex, '#0e1217');
    assert.equal(lightHex, '#fbfcfd');
  });

  for (const page of ['index.html', 'share.html']) {
    it(`T5 ${page} lists both schemes and one theme-color per scheme matching --ground`, () => {
      const { darkHex, lightHex } = grounds();
      const html = readPublic(page);
      assert.equal((html.match(/<meta name="color-scheme"[^>]*>/g) || []).join(''), '<meta name="color-scheme" content="dark light">');
      const metas = html.match(/<meta name="theme-color"[^>]*>/g) || [];
      assert.deepEqual(metas, [
        `<meta name="theme-color" content="${darkHex}" media="(prefers-color-scheme: dark)">`,
        `<meta name="theme-color" content="${lightHex}" media="(prefers-color-scheme: light)">`,
      ]);
    });
  }

  it('T5 the manifest colours equal the dark ground (a manifest holds one scheme)', () => {
    const { darkHex } = grounds();
    const manifest = JSON.parse(readPublic('manifest.webmanifest'));
    assert.equal(manifest.theme_color, darkHex);
    assert.equal(manifest.background_color, darkHex);
  });

  it('T5 the auth-callback pages let the browser follow the device scheme', () => {
    for (const page of [AUTH_PAGE_OK, AUTH_PAGE_FAIL]) {
      assert.ok(page.includes('<meta name="color-scheme" content="light dark">'), page);
    }
  });

  it('T6 the stylesheet header describes the two-scheme model', () => {
    const header = /^\/\*[\s\S]*?\*\//.exec(readPublic('styles.css'));
    assert.ok(header, 'styles.css must open with its header comment');
    assert.doesNotMatch(header[0], /dark only|none may be added/i);
    assert.match(header[0], /prefers-color-scheme/);
  });
});
