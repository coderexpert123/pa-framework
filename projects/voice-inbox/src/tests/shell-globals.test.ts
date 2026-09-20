/**
 * Shell global-scope integrity (2026-09-16).
 *
 * index.html loads answer-shapes.js, live-pane.js and app.js as CLASSIC
 * scripts, so all three share one global scope. A top-level `const`/`let`/
 * `class` declared in two of them is a SyntaxError — "Identifier 'X' has
 * already been declared" — thrown while parsing whichever file loads second.
 * That file then never evaluates at all, so boot() never runs and the app
 * renders a blank page.
 *
 * Nothing else catches this: each file is independently valid JavaScript, so
 * `node --check` passes on every one of them and only the browser, loading
 * them together, ever sees the collision.
 *
 * The incident: shell v73 mirrored answer-shapes.js's answerLineDashSplit
 * into app.js as lineDashSplit. The FUNCTION was renamed to avoid the clash;
 * the `const LINE_DASH_ITEM_RE` beside it was copied verbatim. Every client
 * that picked up v73 went blank on its next launch.
 *
 * The script list is read out of index.html rather than hardcoded, so a
 * fourth classic script added later is covered without touching this file.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox
const PUBLIC = join(PKG_ROOT, 'public');

/** SHELL_SCRIPTS env var points the scan at a different public dir — used to
 *  prove this check still fails on the known-bad pre-v80 pair. */
function publicDir(): string {
  return process.env.SHELL_PUBLIC ? join(PKG_ROOT, process.env.SHELL_PUBLIC) : PUBLIC;
}

/** Classic same-origin scripts index.html pulls into the shared global scope.
 *  `type="module"` tags are excluded: a module has its own scope and cannot
 *  collide. */
function classicScripts(dir: string): string[] {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const out: string[] = [];
  const re = /<script\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\btype\s*=\s*["']module["']/.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(attrs);
    if (!src) continue;
    if (/^[a-z]+:\/\//i.test(src[1])) continue; // cross-origin: not our scope to police
    out.push(src[1].replace(/^\.?\//, ''));
  }
  return out;
}

/** Top-level declarations: a binding keyword at column 0. Anything indented
 *  sits inside a function or block and cannot collide across files. */
function topLevelNames(source: string): string[] {
  const names: string[] = [];
  const re = /^(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

describe('shell global scope', () => {
  it('index.html yields the classic scripts to scan', () => {
    const scripts = classicScripts(publicDir());
    // Without this the scan could pass by finding nothing at all.
    assert.ok(scripts.length >= 2, `expected >=2 classic scripts, got ${scripts.length}`);
    assert.ok(scripts.includes('app.js'), 'app.js missing from the scan');
    assert.ok(scripts.includes('answer-shapes.js'), 'answer-shapes.js missing from the scan');
  });

  it('no top-level declaration is made by two classic scripts', () => {
    const dir = publicDir();
    const owners = new Map<string, string[]>();
    for (const file of classicScripts(dir)) {
      // A `const` collides even with a `var`/`function` of the same name, so
      // every binding kind goes into one namespace.
      for (const name of new Set(topLevelNames(readFileSync(join(dir, file), 'utf8')))) {
        owners.set(name, (owners.get(name) ?? []).concat(file));
      }
    }
    const clashes = [...owners].filter(([, files]) => files.length > 1);
    assert.deepEqual(
      clashes.map(([name, files]) => `${name} (${files.join(' + ')})`),
      [],
      'a top-level name is declared by two classic scripts — the second to parse ' +
        'throws SyntaxError and never evaluates, blanking the app',
    );
  });
});
