import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { log, flushLog } from '../src/lib/log.js';

const APP_LOG = 'app.log.jsonl';

let tmpA: string;
let tmpB: string;
let originalHome: string | undefined;
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;

describe('lib/log destination pinning', { concurrency: 1 }, () => {
  beforeEach(async () => {
    originalHome = process.env.PA_HOME;
    tmpA = await mkdtemp(join(tmpdir(), 'pa-log-a-'));
    tmpB = await mkdtemp(join(tmpdir(), 'pa-log-b-'));
    process.env.PA_HOME = tmpA;
    // Start from a drained queue so assertions about tmpA's contents can't be
    // confused by appends enqueued earlier in this process.
    await flushLog();
    // log() also mirrors to the terminal; silence it so the runner output stays
    // readable. Restored in afterEach.
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(async () => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    await flushLog(); // drain before the temp homes disappear
    if (originalHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalHome;
    await rm(tmpA, { recursive: true, force: true });
    await rm(tmpB, { recursive: true, force: true });
  });

  it('writes an entry to the PA_HOME in effect at ENQUEUE time, even if PA_HOME changes before the drain', async () => {
    log('info', 'log-test', 'pinned to A', { pin: 'switch' });
    // Switch synchronously — nothing has been able to drain yet.
    process.env.PA_HOME = tmpB;
    await flushLog();

    const written = await readFile(join(tmpA, APP_LOG), 'utf8');
    assert.match(written, /pinned to A/);
    assert.equal(
      existsSync(join(tmpB, APP_LOG)),
      false,
      'a queued entry must not follow a later PA_HOME'
    );
  });

  it('regression: an entry survives PA_HOME being CLEARED before the drain instead of landing in the real ~/.pa', async () => {
    // The exact production defect: tests set PA_HOME to a tmpdir, logged, then
    // cleared PA_HOME in afterEach; the queue drained afterwards, paHome() fell
    // back to ~/.pa, and ~196 synthetic records (fake worker failures, fake
    // telegram sends with resolvable refIds) were written into the real
    // forensic log.
    log('warn', 'log-test', 'pinned when PA_HOME is cleared');
    delete process.env.PA_HOME;
    await flushLog();
    process.env.PA_HOME = tmpA;

    const written = await readFile(join(tmpA, APP_LOG), 'utf8');
    assert.match(written, /pinned when PA_HOME is cleared/);
  });

  it('flushLog resolves only after every queued entry is written, in enqueue order', async () => {
    for (let i = 0; i < 5; i++) log('info', 'log-test', `queued ${i}`);

    assert.equal(
      existsSync(join(tmpA, APP_LOG)),
      false,
      'log() must stay fire-and-forget — nothing is written synchronously'
    );

    await flushLog();

    const lines = (await readFile(join(tmpA, APP_LOG), 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 5, 'flush must not resolve before the whole queue has drained');
    for (let i = 0; i < 5; i++) {
      assert.equal(JSON.parse(lines[i]).message, `queued ${i}`, 'FIFO order preserved');
    }
  });

  it('emits an unchanged line format: one JSON object per line, timestamp/level/module/message then context, newline-terminated', async () => {
    log('info', 'log-test', 'representative entry', { skill: 'demo', exitCode: 1 });
    await flushLog();

    const raw = await readFile(join(tmpA, APP_LOG), 'utf8');
    const line = raw.split('\n').filter(Boolean)[0];
    const parsed = JSON.parse(line);
    assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(
      line,
      JSON.stringify({
        timestamp: parsed.timestamp,
        level: 'info',
        module: 'log-test',
        message: 'representative entry',
        skill: 'demo',
        exitCode: 1,
      }),
      'field order and encoding must be byte-identical to the pre-fix format'
    );
    assert.equal(raw, line + '\n', 'exactly one newline-terminated line');
  });
});

describe('lib/log PA_TEST_LOG_HOME backstop', { concurrency: 1 }, () => {
  // The real production destination. Never written to by these tests — that is
  // the whole point — so it is only ever used as a value to compare against.
  const REAL_LOG = join(homedir(), '.pa', APP_LOG);

  // Suite-local temps/state: this describe deliberately does not share the
  // module-level tmpA/tmpB with the pinning suite above.
  let redirectHome: string;
  let ownHome: string;
  let savedHome: string | undefined;
  let savedTestLogHome: string | undefined;
  let savedLog: typeof console.log;
  let savedError: typeof console.error;

  beforeEach(async () => {
    savedHome = process.env.PA_HOME;
    savedTestLogHome = process.env.PA_TEST_LOG_HOME;
    redirectHome = await mkdtemp(join(tmpdir(), 'pa-log-backstop-r-'));
    ownHome = await mkdtemp(join(tmpdir(), 'pa-log-backstop-o-'));
    // Start from a drained queue so assertions about these dirs can't be
    // confused by appends enqueued earlier in this process.
    await flushLog();
    savedLog = console.log;
    savedError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(async () => {
    console.log = savedLog;
    console.error = savedError;
    await flushLog(); // drain before the temp homes disappear
    if (savedHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = savedHome;
    if (savedTestLogHome === undefined) delete process.env.PA_TEST_LOG_HOME;
    else process.env.PA_TEST_LOG_HOME = savedTestLogHome;
    await rm(redirectHome, { recursive: true, force: true });
    await rm(ownHome, { recursive: true, force: true });
  });

  it('redirects to PA_TEST_LOG_HOME when PA_HOME is UNSET, instead of the real ~/.pa', async () => {
    // The class enqueue-time pinning cannot fix: the entry is created while
    // PA_HOME is unset (a test file that never sets one, the window after a
    // cleanup, or fire-and-forget work that outlives its test), so paHome()
    // legitimately resolves to the production forensic log.
    process.env.PA_TEST_LOG_HOME = redirectHome;
    delete process.env.PA_HOME;

    log('warn', 'log-test', 'backstop: unset PA_HOME must not reach production');
    await flushLog();

    const written = await readFile(join(redirectHome, APP_LOG), 'utf8');
    assert.match(written, /backstop: unset PA_HOME must not reach production/);
  });

  it('redirects when PA_HOME is explicitly set to the real ~/.pa', async () => {
    process.env.PA_TEST_LOG_HOME = redirectHome;
    process.env.PA_HOME = join(homedir(), '.pa');

    log('warn', 'log-test', 'backstop: explicit real PA_HOME must not reach production');
    await flushLog();

    const written = await readFile(join(redirectHome, APP_LOG), 'utf8');
    assert.match(written, /backstop: explicit real PA_HOME must not reach production/);
    assert.notEqual(join(redirectHome, APP_LOG), REAL_LOG, 'sanity: the redirect target is not the real log');
  });

  it('does NOT hijack a test that set its own temp PA_HOME', async () => {
    // The backstop fires only for the real-home destination; an explicit
    // PA_HOME still wins, so per-test isolation keeps working unchanged.
    process.env.PA_TEST_LOG_HOME = redirectHome;
    process.env.PA_HOME = ownHome;

    log('info', 'log-test', 'explicit PA_HOME still wins');
    await flushLog();

    const written = await readFile(join(ownHome, APP_LOG), 'utf8');
    assert.match(written, /explicit PA_HOME still wins/);
    assert.equal(
      existsSync(join(redirectHome, APP_LOG)),
      false,
      'the backstop must not divert entries that already have a safe destination'
    );
  });

  it('is inert without the explicit signal: an unset PA_TEST_LOG_HOME leaves the destination alone', async () => {
    // Production shape — PA_TEST_LOG_HOME is set only by the two test
    // preloads. Asserted against a temp PA_HOME so this test can never write
    // into the real ~/.pa itself.
    delete process.env.PA_TEST_LOG_HOME;
    process.env.PA_HOME = ownHome;

    log('info', 'log-test', 'no signal, no redirect');
    await flushLog();

    const written = await readFile(join(ownHome, APP_LOG), 'utf8');
    assert.match(written, /no signal, no redirect/);
    assert.equal(existsSync(join(redirectHome, APP_LOG)), false, 'nothing may be redirected without the signal');
  });
});
