/**
 * Env-guard enforcement gate (D16, WP-D, AI-156, 2026-08-23): a test file
 * that imports telegram.js / notify.js / workers.js / worker-exec.js — the
 * modules whose call paths can send a real Telegram message or write a real
 * forensic-log line — must import './test-env-guard.js' as its FIRST import,
 * so a direct scoped run (`node --test dist/tests/x.test.js`, bypassing the
 * whole-suite --import preload) still cannot leak PA_HOME to the real
 * ~/.pa. On 2026-08-17 that leak sent 3 real Telegram alerts to pa-alerts
 * and wrote 64 synthetic rows into the production forensic log
 * (plans/2026-08-23-alerts-week-review.md §5.3).
 *
 * KNOWN LIMITATION, stated here deliberately so a green gate is never read
 * as full coverage: this check is DIRECT-IMPORTS ONLY (a plain per-line
 * regex, mirroring timer-inventory.test.ts's comment-stripped-source
 * approach in spirit but not in depth). A test file that imports a module
 * which TRANSITIVELY reaches notify.ts/telegram.ts is NOT caught — e.g.
 * pa/tests/catchup.test.ts dynamically imports '../src/commands/catchup.js'
 * (`await import(...)` inside its test bodies), which itself reaches
 * notify.ts several calls deep, and this gate cannot see that (verified
 * 2026-08-23 while rechecking this wave: an earlier draft of this comment
 * named pa/tests/catchup-alerts.test.ts, which does not import catchup.js
 * at all — it only touches src/logger.js). Such files still rely on the
 * whole-suite --import preload (or
 * their own manual guard) for real protection; this gate only mechanizes
 * the direct case.
 *
 * Mirrors pa/tests/timer-inventory.test.ts's ALLOWLIST-with-staleness-check
 * shape.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// This file lands at <pa>/dist/tests/test-env-guard-gate.test.js after
// build, so __dirname there is pa/dist/tests — walk back up to the pa/
// package root, then one more level to the repo root so the bot's source
// tests (a sibling package, not under pa/) can be scanned too.
const PA_ROOT = join(__dirname, '..', '..');
const REPO_ROOT = join(PA_ROOT, '..');
const SCAN_DIRS = [join(PA_ROOT, 'tests'), join(REPO_ROOT, 'projects', 'telegram-bot', 'src', 'tests')];

// Direct-import-only by construction (see header). Any non-"import type"
// line matching this marks the file as triggering.
const TRIGGER_RE = /(from|import\()\s*['"][^'"]*\/(telegram|notify|workers|worker-exec)\.js['"]/;
const GUARD_IMPORT_MARKER = 'test-env-guard.js';

interface EnvGuardAllowlistEntry {
  file: string;
  reason: string;
}

/**
 * Opt-out for a triggering file that deliberately does not carry the guard
 * import first (mirrors TIMER_ALLOWLIST). Empty as of 2026-08-23 — the WP-D
 * sweep guarded every file this gate found triggering.
 */
export const ENV_GUARD_ALLOWLIST: EnvGuardAllowlistEntry[] = [];

interface ScanResult {
  relKey: string;
  triggerIdx: number;
  guardIdx: number;
}

function scanDir(dir: string, out: ScanResult[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.test.ts')) continue;
    const full = join(dir, entry);
    const lines = readFileSync(full, 'utf8').split('\n');

    let triggerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('import type')) continue;
      if (TRIGGER_RE.test(lines[i])) {
        triggerIdx = i;
        break;
      }
    }
    if (triggerIdx === -1) continue; // does not trigger — nothing to check

    let guardIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(GUARD_IMPORT_MARKER)) {
        guardIdx = i;
        break;
      }
    }

    out.push({ relKey: relative(REPO_ROOT, full).split(sep).join('/'), triggerIdx, guardIdx });
  }
}

function totalTestFileCount(): number {
  let total = 0;
  for (const dir of SCAN_DIRS) {
    try {
      total += readdirSync(dir).filter((f) => f.endsWith('.test.ts')).length;
    } catch {
      // A missing scan dir is itself a broken-path-resolution bug — the
      // sane-count assertion below catches it via a too-low total.
    }
  }
  return total;
}

const triggering: ScanResult[] = [];
for (const dir of SCAN_DIRS) scanDir(dir, triggering);

describe('env-guard enforcement gate (D16 — direct-imports-only, see header)', () => {
  it('scans a sane number of test files (guards against broken path resolution)', () => {
    const total = totalTestFileCount();
    assert.ok(total > 100, `expected > 100 .test.ts files across pa/tests + bot src/tests, got ${total}`);
  });

  it('every ENV_GUARD_ALLOWLIST entry is real, justified, and still triggering (staleness check)', () => {
    for (const entry of ENV_GUARD_ALLOWLIST) {
      assert.ok(
        entry.reason.length >= 40,
        `ENV_GUARD_ALLOWLIST entry for '${entry.file}' needs a real justification (>=40 chars), not a placeholder.`,
      );
      const hit = triggering.find((t) => t.relKey === entry.file);
      if (!hit) {
        assert.fail(`stale ENV_GUARD_ALLOWLIST entry for '${entry.file}'; remove it.`);
      }
    }
  });

  it('every triggering test file imports test-env-guard.js before its first telegram/notify/workers/worker-exec import', () => {
    for (const t of triggering) {
      const allowed = ENV_GUARD_ALLOWLIST.some((e) => e.file === t.relKey);
      if (allowed) continue;

      assert.ok(
        t.guardIdx !== -1 && t.guardIdx < t.triggerIdx,
        `${t.relKey}: imports telegram.js/notify.js/workers.js/worker-exec.js directly (line ${t.triggerIdx + 1}) ` +
          `without './test-env-guard.js' imported first. Add "import './test-env-guard.js';" as the FIRST import, ` +
          `or add a justified ENV_GUARD_ALLOWLIST entry (see AI-156).`,
      );
    }
  });
});
