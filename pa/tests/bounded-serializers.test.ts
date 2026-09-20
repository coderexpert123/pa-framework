import './test-env-guard.js';
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// This file lands at <pa>/dist/tests/bounded-serializers.test.js after build,
// same as timer-inventory.test.ts — walk back up to the pa/ package root.
const PA_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(PA_ROOT, 'src');
const SKIP_DIR_SEGMENTS = new Set(['node_modules', 'dist', 'tests']);

const UNBOUNDED_PATTERNS = [
  /\.catch\(\(\) => \{\}\)\s*\.then\(/,
  /\bprevious\.catch\(\(\) => \{\}\)/,
  /\bprev\.catch\(\(\) => \{\}\)/,
];

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
}

const files: string[] = [];
walk(SRC_ROOT, files);

describe('bounded serializers (catchup-lane-wedge WP-A)', () => {
  it('no pa/src module keeps an unbounded in-process promise-chain serializer', () => {
    const offenders: string[] = [];
    for (const absPath of files) {
      const src = readFileSync(absPath, 'utf8');
      if (UNBOUNDED_PATTERNS.some((re) => re.test(src))) {
        offenders.push(absPath);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `use withBoundedQueue (pa/src/lib/stall.ts): ${offenders.join(', ')}`,
    );
  });

  it('the eight pa store serializers route through withBoundedQueue with their store labels', () => {
    const pairs: Array<[string, string]> = [
      ['src/lib/log.ts', 'app-log'],
      ['src/lib/maintenance/state.ts', 'maintenance-state'],
      ['src/lib/archive-files.ts', 'archive-rotate'],
      ['src/lib/reservations.ts', 'reservations'],
      ['src/lib/topic-tasks.ts', 'topic-tasks'],
      ['src/lib/watch-jobs.ts', 'watch-jobs'],
      ['src/lib/bus-queue.ts', 'bus-queue'],
      ['src/rate-limits.ts', 'rate-limits'],
    ];
    for (const [relPath, label] of pairs) {
      const src = readFileSync(join(PA_ROOT, relPath), 'utf8');
      assert.ok(src.includes('withBoundedQueue('), `${relPath}: expected withBoundedQueue(`);
      assert.ok(src.includes(`store: '${label}'`), `${relPath}: expected store: '${label}'`);
    }
  });
});
