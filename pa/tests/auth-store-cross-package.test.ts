/**
 * Cross-package shape pin for the §3.3 broker row (auth broker Phase A,
 * deep-recheck 2026-09-10). `pa/src/lib/auth/store.ts` and
 * `projects/voice-inbox/src/auth-providers.ts` each implement an
 * INDEPENDENT reader/writer for the same on-disk JSON contract
 * (`~/.pa/auth/requests/<id>.json`) — no shared code between the two
 * packages, by design (D2/§3.3: "no shared code, just a frozen file
 * format"). That means nothing catches the two copies drifting apart if a
 * future edit changes one `AuthRequestRow` interface (or its write-order
 * object) without the other — this test is that catch.
 *
 * Extraction is regex-over-source-text, not an import: `pa` cannot import
 * `projects/voice-inbox/src` (undeclared cross-package dependency, D10)
 * and this pin must not force a build of that package into pa's own gate.
 * Same idiom as `sync-twins.test.ts` / `extract_contracts_kinds` elsewhere
 * in this repo for exactly this "two independent copies of one shape"
 * problem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Sync, layout-independent fallback (walks up for pa/package.json) — used
// instead of the async repoRootFromModule() because this file needs the
// root at plain module scope, not inside an async test body.
import { walkUpToRepoRoot } from '../src/lib/git-root.js';

const repoRoot = walkUpToRepoRoot(dirname(__filename));

function extractInterfaceKeys(src: string, ifaceName: string): string[] {
  const re = new RegExp(`interface ${ifaceName} \\{([\\s\\S]*?)\\n\\}`);
  const m = src.match(re);
  assert.ok(m, `interface ${ifaceName} not found — extraction regex is stale`);
  return [...m![1].matchAll(/^\s*(\w+)\??:/gm)].map((x) => x[1]);
}

describe('auth broker store — cross-package shape pin (pa vs voice-inbox)', () => {
  it('AuthRequestRow key order is identical in both independent implementations', () => {
    const storeSrc = readFileSync(join(repoRoot, 'pa/src/lib/auth/store.ts'), 'utf8');
    const viSrc = readFileSync(join(repoRoot, 'projects/voice-inbox/src/auth-providers.ts'), 'utf8');

    const paKeys = extractInterfaceKeys(storeSrc, 'AuthRequestRow');
    const viKeys = extractInterfaceKeys(viSrc, 'AuthRequestRow');

    // Known-bad control: the extraction itself must be capable of catching
    // a real divergence, not just echoing whatever it finds. A regex that
    // always returns [] for both sides would pass vacuously.
    assert.ok(paKeys.length >= 10, 'extraction found too few keys — regex is broken, not the shape');
    assert.deepEqual(
      viKeys,
      paKeys,
      'pa/src/lib/auth/store.ts and projects/voice-inbox/src/auth-providers.ts ' +
        'must declare AuthRequestRow with the SAME keys in the SAME order (§3.3) — ' +
        'a change to one interface without the other breaks the frozen on-disk contract'
    );

    // The §3.3 order itself, spelled out — this is the actual frozen shape,
    // not just "the two files agree with each other" (they could both drift
    // together and this assertion would still catch it).
    assert.deepEqual(paKeys, [
      'request_id',
      'task_id',
      'tenant_id',
      'shape',
      'provider',
      'kind',
      'status',
      'created_at',
      'expires_at',
      'state',
      'code_verifier',
      'redirect_uri',
      'auth_id',
      'answer_pointer',
      'delivered_at',
    ]);
  });

  it('the write-order object literal in each writer matches its own interface (self-consistency)', () => {
    const storeSrc = readFileSync(join(repoRoot, 'pa/src/lib/auth/store.ts'), 'utf8');
    const viSrc = readFileSync(join(repoRoot, 'projects/voice-inbox/src/auth-providers.ts'), 'utf8');

    function extractOrderedLiteralKeys(src: string, fnHeadRe: RegExp): string[] {
      const m = src.match(fnHeadRe);
      assert.ok(m, 'ordered-object function not found — extraction regex is stale');
      return [...m![1].matchAll(/^\s*(\w+):\s*row\.\w+/gm)].map((x) => x[1]);
    }

    const paOrdered = extractOrderedLiteralKeys(
      storeSrc,
      /function orderRow\(row: AuthRequestRow\): AuthRequestRow \{\s*return \{([\s\S]*?)\n {2}\};/
    );
    const viOrdered = extractOrderedLiteralKeys(
      viSrc,
      /export function writeAuthRequestRow\(row: AuthRequestRow\): void \{[\s\S]*?const ordered: AuthRequestRow = \{([\s\S]*?)\n {2}\};/
    );

    assert.deepEqual(viOrdered, paOrdered, 'both writers must serialize keys in the same order');
  });
});
