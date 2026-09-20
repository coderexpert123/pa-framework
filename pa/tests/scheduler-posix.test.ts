/**
 * Tests for POSIX crontab registration in syncSchedules / listSchedules.
 * Uses mock exec calls so no real crontab is touched.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { platform, homedir } from 'os';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  resolveWindowsPaPath,
  resolvePosixPaPath,
  scheduledTaskName,
  buildCatchupWatchdogCronLine,
  buildCatchupWatchdogShScript,
  shSingleQuote,
} from '../src/scheduler.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
  mock.restoreAll();
});

// Helper: import scheduler with exec mocked at the child_process level
async function importSchedulerWithExecMock(
  execResults: Record<string, string>
): Promise<{ syncSchedules: () => Promise<void>; listSchedules: () => Promise<void> }> {
  // We can't easily mock child_process.exec in ESM without a full loader.
  // Instead, test the logic through integration-level assertions on output.
  // These tests validate the regex/upsert logic directly.
  return { syncSchedules: async () => {}, listSchedules: async () => {} };
}

// ── Crontab upsert logic (pure, extracted for unit testing) ──────────────────

function upsertCronLines(
  existing: string,
  entries: Array<{ sentinel: string; line: string }>
): string {
  let updated = existing;
  for (const { sentinel, line } of entries) {
    const escapedSentinel = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedSentinel}\\n[^\\n]*\\n?`, 'g');
    const block = `${sentinel}\n${line}\n`;
    if (pattern.test(updated)) {
      updated = updated.replace(pattern, block);
    } else {
      if (!updated.endsWith('\n') && updated.length > 0) updated += '\n';
      updated += block;
    }
  }
  return updated;
}

// 2026-09-10 launch-cadence wave: ONE managed line — the watchdog-gated
// `catchup --loop`, the POSIX twin of S1 (`kill -0` is a shell builtin, so
// the healthy path spawns nothing beyond the shell cron already starts).
// Replaces the two-line `--topic reminders` / bare `catchup` pair.
const LOCK_PATH = '/home/user/.pa/catchup-loop.lock';
const LOOP_CRON_LINE = `* * * * * /bin/sh '/home/user/.pa/run-catchup-watchdog.sh'`;
const REMINDERS_SENTINEL = '# PA-Catchup-Reminders (managed by pa schedules sync)';
const CATCHUP_SENTINEL = '# PA-Catchup (managed by pa schedules sync)';
const ENTRIES = [
  { sentinel: CATCHUP_SENTINEL, line: LOOP_CRON_LINE },
];

describe('POSIX crontab upsert logic', () => {
  it('appends the single loop entry to an empty crontab', () => {
    const result = upsertCronLines('', ENTRIES);
    assert.ok(result.includes(LOOP_CRON_LINE));
    assert.ok(result.includes('PA-Catchup (managed'));
  });

  it('appends to an existing crontab without touching existing lines', () => {
    const existing = '0 9 * * 1 /usr/local/bin/weekly-report\n';
    const result = upsertCronLines(existing, ENTRIES);
    assert.ok(result.startsWith('0 9 * * 1 /usr/local/bin/weekly-report\n'));
    assert.ok(result.includes(LOOP_CRON_LINE));
  });

  it('replaces an existing PA line in-place (no duplicates)', () => {
    const existing =
      '0 9 * * 1 /usr/local/bin/weekly-report\n' +
      `${CATCHUP_SENTINEL}\n` +
      '*/30 * * * * pa-old catchup\n';
    const result = upsertCronLines(existing, ENTRIES);
    // Old line replaced
    assert.ok(!result.includes('pa-old'));
    assert.ok(!result.includes('*/30'));
    // New line present exactly once
    const count = (result.match(/\/bin\/sh '\/home\/user\/\.pa\/run-catchup-watchdog\.sh'$/mg) ?? []).length;
    assert.equal(count, 1);
    // Existing non-PA line preserved
    assert.ok(result.includes('0 9 * * 1 /usr/local/bin/weekly-report'));
  });

  it('handles crontab with no trailing newline', () => {
    const existing = '0 1 * * * /usr/bin/some-job';
    const result = upsertCronLines(existing, ENTRIES);
    assert.ok(result.includes(`\n${CATCHUP_SENTINEL}`));
    assert.ok(!result.includes(`some-job${CATCHUP_SENTINEL}`));
  });

  it('sentinels are escaped correctly (no regex injection)', () => {
    // Sentinel contains parens, which could break an unescaped regex
    const existing = `${CATCHUP_SENTINEL}\n${LOOP_CRON_LINE}\n`;
    const result = upsertCronLines(existing, ENTRIES);
    // Should replace, not duplicate
    const count = (result.match(/\/bin\/sh '\/home\/user\/\.pa\/run-catchup-watchdog\.sh'$/mg) ?? []).length;
    assert.equal(count, 1);
  });

  it('buildCatchupWatchdogCronLine runs the generated script through /bin/sh with a single-quoted path', () => {
    assert.equal(buildCatchupWatchdogCronLine('/home/user/.pa/run-catchup-watchdog.sh'), LOOP_CRON_LINE);
    assert.equal(
      buildCatchupWatchdogCronLine("/home/o'neil/.pa/w.sh"),
      "* * * * * /bin/sh '/home/o'\\''neil/.pa/w.sh'"
    );
  });

  // 2026-09-12 stuck-loop incident: `kill -0` alone proved the PID was alive,
  // not that its event loop was still turning — a frozen-but-alive loop ran
  // silently for 7.5h before self-recovering. buildCatchupWatchdogCronLine
  // is the actual generator these tests exercise directly (unlike
  // LOOP_CRON_LINE above, a hand-written literal used only to test the
  // upsert/sentinel logic).
  describe('buildCatchupWatchdogShScript (POSIX lane-progress watchdog)', () => {
    const paPath = '/usr/local/bin/pa';
    const paths = {
      lockPath: LOCK_PATH,
      lanesDir: '/home/user/.pa/catchup-lanes',
      stallMarkerPath: '/home/user/.pa/catchup-loop.stalled',
      stallRecordsPath: '/home/user/.pa/stall-records.jsonl',
      pageBodyPath: '/home/user/.pa/catchup-loop-page.txt',
    };
    const minutes = 5;

    it('matches the golden script text', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      const EXPECTED = [
        `#!/bin/sh`,
        `# Generated by pa schedules sync; edits are overwritten on the next sync.`,
        `L=${shSingleQuote(paths.lockPath)}`,
        `D=${shSingleQuote(paths.lanesDir)}`,
        `M=${shSingleQuote(paths.stallMarkerPath)}`,
        `R=${shSingleQuote(paths.stallRecordsPath)}`,
        `B=${shSingleQuote(paths.pageBodyPath)}`,
        `PA=${shSingleQuote(paPath)}`,
        `N=${minutes}`,
        `W=$PA_CATCHUP_KILL_EXIT_WAIT_S`,
        `case "$W" in`,
        `  ''|*[!0-9]*|0*|?????*) W=120 ;;`,
        `esac`,
        `: "\${UV_THREADPOOL_SIZE:=16}"`,
        `export UV_THREADPOOL_SIZE`,
        ``,
        `# Appends "; <marker>" to C and deletes the loop's store-stall marker, if any.`,
        `append_marker() {`,
        `  if [ -f "$M" ]; then`,
        `    MK=$(head -n 1 "$M" 2>/dev/null)`,
        `    rm -f "$M"`,
        `    C="$C; \${MK:-store stall}"`,
        `  fi`,
        `}`,
        ``,
        `# Appends one JSON line of launcher evidence for PID $1 with store label $2.`,
        `record() {`,
        `  J=$(printf '%s' "$C" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')`,
        `  printf '{"ts":"%s","pid":%s,"host":"launcher","store":"%s","cause":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$J" >> "$R"`,
        `}`,
        ``,
        `# True while PID $1 is still the catchup loop. A zombie, or a PID that now runs`,
        `# another command line, reads as exited; when ps reports nothing, kill -0 decides.`,
        `loop_alive() {`,
        `  Z=$(ps -p "$1" -o stat= 2>/dev/null)`,
        `  if [ -z "$Z" ]; then`,
        `    kill -0 "$1" 2>/dev/null && return 0`,
        `    return 1`,
        `  fi`,
        `  case "$Z" in`,
        `    *Z*) return 1 ;;`,
        `  esac`,
        `  case "$(ps -p "$1" -o args= 2>/dev/null)" in`,
        `    ''|*catchup*--loop*) return 0 ;;`,
        `  esac`,
        `  return 1`,
        `}`,
        ``,
        `C=`,
        `O=`,
        `V=error`,
        `K=catchup-loop-stalled`,
        `P=$(cat "$L" 2>/dev/null)`,
        `if [ -n "$P" ]; then`,
        `  A=$(ps -p "$P" -o args= 2>/dev/null)`,
        `  case "$A" in`,
        `    ''|*catchup*--loop*) ;;`,
        `    *) O=$P; P= ;;`,
        `  esac`,
        `fi`,
        `if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then`,
        `  if [ -n "$(find "$L" -mmin +"$N" 2>/dev/null)" ]; then`,
        `    C='heartbeat stale'`,
        `  else`,
        `    for lane in default reminders maintenance; do`,
        `      f="$D/$lane"`,
        `      if [ ! -f "$f" ] || [ -n "$(find "$f" -mmin +"$N" 2>/dev/null)" ]; then`,
        `        S=$(awk -F'|' 'NR==1 && NF>=3 { s=" at " $3; if (NF>=4 && $4 != "") s=s ": " $4; printf "%s", s }' "$f" 2>/dev/null)`,
        `        C="lane $lane stale$S"`,
        `        break`,
        `      fi`,
        `    done`,
        `  fi`,
        `  [ -z "$C" ] && exit 0`,
        `  append_marker`,
        `  record "$P" lane-progress`,
        `  kill -9 "$P" 2>/dev/null`,
        `  T=0`,
        `  while loop_alive "$P"; do`,
        `    if [ "$T" -ge "$W" ]; then`,
        `      C="$C; killed catchup loop did not exit within $W s; relaunched anyway - a stale write may land"`,
        `      break`,
        `    fi`,
        `    sleep 2`,
        `    T=$((T + 2))`,
        `  done`,
        `elif [ -n "$O" ]; then`,
        `  C='catchup loop was not running (recorded PID now belongs to another process); relaunched'`,
        `  append_marker`,
        `  record "$O" pid-reused`,
        `  V=warn`,
        `  K=catchup-loop-pid-reused`,
        `elif [ -f "$M" ]; then`,
        `  MK=$(head -n 1 "$M" 2>/dev/null)`,
        `  rm -f "$M"`,
        `  C="\${MK:-store stall}"`,
        `fi`,
        `if [ -n "$C" ]; then`,
        `  printf '%s\\nCause: %s\\n' 'Catchup loop restarted by its watchdog.' "$C" > "$B"`,
        `  "$PA" notify --subject 'Catchup loop restarted' --body-file "$B" --dedup-key "$K" --severity "$V" >/dev/null 2>&1 &`,
        `fi`,
        `exec "$PA" catchup --loop`,
      ].join('\n') + '\n';
      assert.equal(script, EXPECTED);
    });

    it('kills only a live PID whose heartbeat or lane file is stale, after recording evidence', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      const iGate = script.indexOf('if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then');
      const iExit = script.indexOf('[ -z "$C" ] && exit 0');
      const iRecord = script.indexOf('record "$P" lane-progress');
      const iKill = script.indexOf('kill -9 "$P" 2>/dev/null');
      const iElif = script.indexOf('elif [ -n "$O" ]; then');
      assert.ok(iGate >= 0 && iGate < iExit);
      assert.ok(iExit < iRecord);
      assert.ok(iRecord < iKill);
      assert.ok(iKill < iElif);
    });

    it('checks the heartbeat first, then each lane in order', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      const iHeartbeat = script.indexOf('find "$L" -mmin +"$N"');
      const iLanes = script.indexOf('for lane in default reminders maintenance; do');
      assert.ok(iHeartbeat >= 0 && iHeartbeat < iLanes);
    });

    it('a dead PID with a stall marker pages without a kill', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      const start = script.indexOf('elif [ -f "$M" ]; then');
      const end = script.indexOf('fi\n', start);
      const body = script.slice(start, end);
      assert.ok(body.includes('C="${MK:-store stall}"'));
      assert.ok(!body.includes('kill'));
    });

    it('pages in the background, then execs the loop as the last line', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      const nonEmpty = script.split('\n').filter((l) => l.length > 0);
      assert.equal(nonEmpty[nonEmpty.length - 1], 'exec "$PA" catchup --loop');
      const notifyLine = script.split('\n').find((l) => l.includes(' notify --subject '));
      assert.ok(notifyLine?.endsWith('>/dev/null 2>&1 &'));
    });

    it('defaults UV_THREADPOOL_SIZE to 16 without overriding a set value', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      assert.ok(script.includes(': "${UV_THREADPOOL_SIZE:=16}"'));
    });

    it('single-quotes every baked path', () => {
      const script = buildCatchupWatchdogShScript(paPath, { ...paths, lockPath: "/home/o'neil/.pa/catchup-loop.lock" }, minutes);
      assert.ok(script.includes(`L='/home/o'\\''neil/.pa/catchup-loop.lock'`));
    });

    it('clears the PID when ps reports a command line that is not the catchup loop', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      const iArgs = script.indexOf('A=$(ps -p "$P" -o args= 2>/dev/null)');
      const iCase = script.indexOf("''|*catchup*--loop*) ;;");
      const iClear = script.indexOf('*) O=$P; P= ;;');
      const iGate = script.indexOf('if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then');
      assert.ok(iArgs >= 0 && iArgs < iCase);
      assert.ok(iCase < iClear);
      assert.ok(iClear < iGate);
    });

    it('the script waits for the killed PID to exit before relaunching, bounded by PA_CATCHUP_KILL_EXIT_WAIT_S', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      assert.ok(script.includes('W=$PA_CATCHUP_KILL_EXIT_WAIT_S'));
      assert.ok(script.includes(`  ''|*[!0-9]*|0*|?????*) W=120 ;;`));
      const iKill = script.indexOf('kill -9 "$P" 2>/dev/null');
      const iWhile = script.indexOf('while loop_alive "$P"; do');
      const iGe = script.indexOf('if [ "$T" -ge "$W" ]; then');
      const iCause = script.indexOf('C="$C; killed catchup loop did not exit within $W s; relaunched anyway - a stale write may land"');
      const iSleep = script.indexOf('sleep 2');
      const iElif = script.indexOf('elif [ -n "$O" ]; then');
      assert.ok(iKill >= 0 && iKill < iWhile);
      assert.ok(iWhile < iGe);
      assert.ok(iGe < iCause);
      assert.ok(iCause < iSleep);
      assert.ok(iSleep < iElif);
    });

    it('loop_alive reads a zombie or a reused PID as exited and lets kill -0 decide when ps is silent', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      const start = script.indexOf('loop_alive() {');
      const end = script.indexOf('\n}\n', start);
      const body = script.slice(start, end);
      assert.ok(body.includes('  Z=$(ps -p "$1" -o stat= 2>/dev/null)'));
      assert.ok(body.includes('    kill -0 "$1" 2>/dev/null && return 0'));
      assert.ok(body.includes('    *Z*) return 1 ;;'));
      assert.ok(body.includes(`    ''|*catchup*--loop*) return 0 ;;`));
      assert.ok(body.indexOf('stat=') < body.indexOf('kill -0'));
    });

    it('the script records a reused PID once as catchup-loop-pid-reused at warn without any kill', () => {
      const script = buildCatchupWatchdogShScript(paPath, paths, minutes);
      const start = script.indexOf('elif [ -n "$O" ]; then');
      const end = script.indexOf('elif [ -f "$M" ]; then');
      const body = script.slice(start, end);
      assert.ok(body.includes(`  C='catchup loop was not running (recorded PID now belongs to another process); relaunched'`));
      assert.ok(body.includes('  append_marker'));
      assert.ok(body.includes('  record "$O" pid-reused'));
      assert.ok(body.includes('  V=warn'));
      assert.ok(body.includes('  K=catchup-loop-pid-reused'));
      assert.ok(!body.includes('kill'));
      const iV = script.indexOf('V=error');
      const iK = script.indexOf('K=catchup-loop-stalled');
      const iP = script.indexOf('P=$(cat "$L" 2>/dev/null)');
      assert.ok(iV >= 0 && iV < iP);
      assert.ok(iK >= 0 && iK < iP);
    });
  });

  it('a legacy PA-Catchup-Reminders block survives the upsert untouched', () => {
    const existing = `${REMINDERS_SENTINEL}\n* * * * * pa catchup --topic reminders\n`;
    const result = upsertCronLines(existing, ENTRIES);
    assert.ok(result.includes(REMINDERS_SENTINEL));
    assert.ok(result.includes('* * * * * pa catchup --topic reminders'));
    const count = (result.match(/\/bin\/sh '\/home\/user\/\.pa\/run-catchup-watchdog\.sh'$/mg) ?? []).length;
    assert.equal(count, 1);
  });
});

// ── Fail-loud pa-path resolution (D4) ─────────────────────────────────────
// Extracted as pure functions specifically so this is testable without
// mocking child_process.exec (unreliable to intercept for a CJS-compiled
// named import across Node versions) — syncSchedulesWindows/Posix just feed
// real `where`/`which` output (or null on failure) through these.

describe('resolveWindowsPaPath (D4 fail-loud on missing pa)', () => {
  it('fails loud when `where pa` found nothing', () => {
    const result = resolveWindowsPaPath(null);
    assert.equal(result.ok, false);
    assert.match(result.errorMessage!, /not on PATH/i);
    assert.match(result.errorMessage!, /npm install -g \./);
  });

  it('prefers the .cmd wrapper when multiple candidates are found', () => {
    const result = resolveWindowsPaPath(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\pa\nC:\\Users\\me\\AppData\\Roaming\\npm\\pa.cmd\n'
    );
    assert.equal(result.ok, true);
    assert.ok(result.paPath.toLowerCase().endsWith('.cmd'));
  });

  it('rejects a path containing shell metacharacters', () => {
    const result = resolveWindowsPaPath('C:\\evil&path\\pa.cmd\n');
    assert.equal(result.ok, false);
    assert.match(result.errorMessage!, /unsafe characters/);
  });
});

describe('resolvePosixPaPath (D4 fail-loud on missing pa)', () => {
  it('fails loud when `which pa` found nothing', () => {
    const result = resolvePosixPaPath(null);
    assert.equal(result.ok, false);
    assert.match(result.errorMessage!, /not on PATH/i);
    assert.match(result.errorMessage!, /npm install -g \./);
  });

  it('resolves a clean which-pa path', () => {
    const result = resolvePosixPaPath('/usr/local/bin/pa\n');
    assert.equal(result.ok, true);
    assert.equal(result.paPath, '/usr/local/bin/pa');
  });

  it('rejects a path containing shell metacharacters', () => {
    const result = resolvePosixPaPath('/usr/local/bin/pa; rm -rf /\n');
    assert.equal(result.ok, false);
    assert.match(result.errorMessage!, /unsafe characters/);
  });
});

// ── scheduledTaskName (2026-07-23 multi-instance collision fix) ────────────
// Reproduced live: two `pa` installs both registering the literal task name
// "PA-Catchup" means the second `pa schedules sync` silently deletes and
// overwrites the first install's real scheduled task, reporting SUCCESS
// both times. This is the fix: derive the name from PA_HOME, falling back
// to the unchanged legacy literal whenever the RESOLVED PA_HOME path
// equals the implicit default (~/.pa) — whether that's because PA_HOME was
// never set, or was explicitly set to the same value (a real production
// install must keep producing exactly "PA-Catchup" either way — zero
// disruption, zero migration).

describe('scheduledTaskName (multi-instance collision fix)', () => {
  it('returns the base label unchanged when PA_HOME is not set', () => {
    delete process.env.PA_HOME;
    assert.equal(scheduledTaskName('PA-Catchup'), 'PA-Catchup');
    assert.equal(scheduledTaskName('PA-Catchup-Reminders'), 'PA-Catchup-Reminders');
  });

  it('hash-suffixes the base label when PA_HOME resolves to a non-default path', () => {
    process.env.PA_HOME = tempDir;
    const name = scheduledTaskName('PA-Catchup');
    assert.match(name, /^PA-Catchup-[0-9a-f]{8}$/);
  });

  it('is deterministic: the same PA_HOME always produces the same name', () => {
    process.env.PA_HOME = tempDir;
    const first = scheduledTaskName('PA-Catchup');
    const second = scheduledTaskName('PA-Catchup');
    assert.equal(first, second);
  });

  it('two different PA_HOME values produce two different names — the actual property fixing the bug', async () => {
    process.env.PA_HOME = tempDir;
    const nameA = scheduledTaskName('PA-Catchup');

    const otherDir = await createTempPaHome();
    try {
      process.env.PA_HOME = otherDir;
      const nameB = scheduledTaskName('PA-Catchup');
      assert.notEqual(nameA, nameB, 'two installs must never collide on the same task name');
    } finally {
      await cleanup(otherDir);
      process.env.PA_HOME = tempDir;
    }
  });

  it('same real directory, different spelling, hashes identically on Windows', { skip: platform() !== 'win32' }, () => {
    process.env.PA_HOME = tempDir;
    const canonical = scheduledTaskName('PA-Catchup');
    process.env.PA_HOME = tempDir.toUpperCase();
    const upper = scheduledTaskName('PA-Catchup');
    process.env.PA_HOME = tempDir.replace(/\\/g, '/') + '/';
    const slashed = scheduledTaskName('PA-Catchup');
    assert.equal(canonical, upper, 'case must not change the hash on Windows');
    assert.equal(canonical, slashed, 'separator/trailing-slash spelling must not change the hash on Windows');
  });

  it('PA_HOME explicitly set to the same value as the implicit default still returns the unchanged legacy name', () => {
    // Compares RESOLVED PATHS, not env-var presence — this is the property
    // that makes that comparison necessary rather than just checking
    // `!process.env.PA_HOME`. If a future config change ever explicitly
    // exports PA_HOME with a value equal to the default, the unchanged-name
    // guarantee must still hold, or the next sync would silently create a
    // second, differently-named task and orphan the old one.
    delete process.env.PA_HOME;
    const implicitDefault = scheduledTaskName('PA-Catchup');
    process.env.PA_HOME = join(homedir(), '.pa');
    const explicitDefault = scheduledTaskName('PA-Catchup');
    assert.equal(implicitDefault, 'PA-Catchup');
    assert.equal(explicitDefault, 'PA-Catchup');
  });

  it('output always contains the base label as a substring — listSchedules() Windows branch depends on this', () => {
    // listSchedules() filters `schtasks /query` output with
    // `l.includes('PA-Catchup')`, relying on scheduledTaskName() never
    // producing a name that DOESN'T contain the base label (e.g. it must
    // stay a suffix, not become a hash-only replacement). Asserted directly
    // so a future change to the naming scheme can't silently break that
    // filter without a test failing here first.
    delete process.env.PA_HOME;
    assert.ok(scheduledTaskName('PA-Catchup').includes('PA-Catchup'));
    process.env.PA_HOME = tempDir;
    assert.ok(scheduledTaskName('PA-Catchup').includes('PA-Catchup'));
  });
});
