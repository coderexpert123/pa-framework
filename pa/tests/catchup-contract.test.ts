import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  CATCHUP_LOOP_LANES,
  CATCHUP_STALL_EXIT_CODE,
  CATCHUP_LOOP_PAGE_SUBJECT,
  CATCHUP_LOOP_PAGE_FIRST_LINE,
  CATCHUP_LOOP_STALLED_DEDUP_KEY,
  CATCHUP_LAUNCHER_UV_THREADPOOL_SIZE,
  catchupLanesDir,
  catchupLaneProgressPath,
  catchupStallMarkerPath,
  catchupPageBodyPath,
  catchupDrillWedgePath,
  catchupWatchdogScriptPath,
  formatLaneBreadcrumb,
  formatStallMarker,
  writeLaneProgress,
} from '../src/lib/catchup-contract.js';

let tmpHome: string;

describe('lib/catchup-contract shared strings and paths', { concurrency: 1 }, () => {
  beforeEach(async () => {
    tmpHome = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(tmpHome);
  });

  it('CATCHUP_LOOP_LANES and CATCHUP_STALL_EXIT_CODE are pinned', () => {
    assert.deepEqual(CATCHUP_LOOP_LANES, ['default', 'reminders', 'maintenance']);
    assert.equal(CATCHUP_STALL_EXIT_CODE, 4);
    assert.equal(CATCHUP_LOOP_PAGE_SUBJECT, 'Catchup loop restarted');
    assert.equal(CATCHUP_LOOP_PAGE_FIRST_LINE, 'Catchup loop restarted by its watchdog.');
    assert.equal(CATCHUP_LOOP_STALLED_DEDUP_KEY, 'catchup-loop-stalled');
    assert.equal(CATCHUP_LAUNCHER_UV_THREADPOOL_SIZE, 16);
  });

  it('path helpers resolve under PA_HOME', () => {
    assert.equal(catchupLanesDir(), join(tmpHome, 'catchup-lanes'));
    assert.equal(catchupLaneProgressPath('reminders'), join(tmpHome, 'catchup-lanes', 'reminders'));
    assert.equal(catchupStallMarkerPath(), join(tmpHome, 'catchup-loop.stalled'));
    assert.equal(catchupPageBodyPath(), join(tmpHome, 'catchup-loop-page.txt'));
    assert.equal(catchupDrillWedgePath(), join(tmpHome, 'catchup-drill-wedge'));
    assert.equal(catchupWatchdogScriptPath(), join(tmpHome, 'run-catchup-watchdog.sh'));
  });

  it('formatLaneBreadcrumb sanitizes every field and caps it at 120 chars', () => {
    assert.equal(
      formatLaneBreadcrumb('2026-09-16T10:00:00.000Z', 'default', 'skill-dispatch', 'daily|mail"brief\\x%y'),
      '2026-09-16T10:00:00.000Z|default|skill-dispatch|daily_mail_brief_x_y',
    );
    const longDetail = 'a'.repeat(200);
    const result = formatLaneBreadcrumb('2026-09-16T10:00:00.000Z', 'default', 'skill-dispatch', longDetail);
    const finalField = result.split('|')[3];
    assert.equal(finalField.length, 120);
    const withUndefined = formatLaneBreadcrumb('2026-09-16T10:00:00.000Z', 'default', 'skill-dispatch', undefined);
    assert.ok(withUndefined.endsWith('|'));
  });

  it('formatStallMarker renders store and optional target', () => {
    assert.equal(
      formatStallMarker('maintenance-state', 'maintenance-state.json'),
      'store stall: maintenance-state (maintenance-state.json)',
    );
    assert.equal(formatStallMarker('app-log', ''), 'store stall: app-log');
  });

  it('writeLaneProgress creates the lanes dir and writes the exact breadcrumb; returns false when it cannot write', async () => {
    const now = new Date('2026-09-16T10:00:00.000Z');
    const ok = writeLaneProgress('maintenance', 'job-decision', 'bus-drain', now);
    assert.equal(ok, true);
    const content = await readFile(catchupLaneProgressPath('maintenance'), 'utf8');
    assert.equal(content, '2026-09-16T10:00:00.000Z|maintenance|job-decision|bus-drain');

    await rm(catchupLanesDir(), { recursive: true, force: true });
    const fsSync = await import('fs');
    fsSync.writeFileSync(catchupLanesDir(), '');
    const failed = writeLaneProgress('default', 'tick-start');
    assert.equal(failed, false);
  });
});
