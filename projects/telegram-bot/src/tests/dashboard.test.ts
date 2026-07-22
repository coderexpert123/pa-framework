import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify as stringifyYaml } from 'yaml';

let sharedTempDir: string;

// Baseline fixture: two workers, NEITHER declaring a `tunables` block — i.e. a
// config written before the tunables schema existed. Kept as a constant so the
// capability-matrix tests can swap the config out and put this back.
const BASE_CONFIG = {
  workers: [
    { name: 'claude', priority: 1, command: 'c', args: [], check: 'c', rate_limit_patterns: [] },
    { name: 'gemini', priority: 2, command: 'g', args: [], check: 'c', rate_limit_patterns: [] }
  ]
};

async function writeConfig(dir: string, config: unknown): Promise<void> {
  await writeFile(join(dir, 'config.yaml'), stringifyYaml(config), 'utf8');
}

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'dashboard-test-'));
  process.env.PA_HOME = sharedTempDir;

  // 1. Mock config.yaml
  await writeConfig(sharedTempDir, BASE_CONFIG);
  
  // 2. Mock telegram-keepawake.json
  const ka = {
    active: true,
    since: '2026-04-22T10:00:00.000Z',
    pid: process.pid // use our own PID so it's "alive"
  };
  await writeFile(join(sharedTempDir, 'telegram-keepawake.json'), JSON.stringify(ka), 'utf8');
  
  // 3. Mock skills directory
  const skillsPath = join(sharedTempDir, 'skills');
  await mkdir(skillsPath);
  const briefPath = join(skillsPath, 'daily-mail-brief');
  await mkdir(briefPath);
  const briefContent = `---
cron: "45 7 * * *"
---
p`;
  await writeFile(join(briefPath, 'skill.md'), briefContent, 'utf8');
});

after(async () => {
  delete process.env.PA_HOME;
  await rm(sharedTempDir, { recursive: true, force: true });
});

// Dynamic import after setting PA_HOME
const {
  getDashboardContent,
  renderWorkerCapabilityMatrix,
  TELEGRAM_MESSAGE_LIMIT,
  DASHBOARD_RESERVE,
} = await import('../dashboard.js');
const { sanitizeMdV2 } = await import('../../../../pa/dist/src/lib/mdv2.js');

/** Post-sanitize length is what Telegram enforces; raw length under-counts. */
const sent = (text: string) => sanitizeMdV2(text.trim()).length;

describe('Dashboard', () => {
  it('generates correct dashboard content', async () => {
    const content = await getDashboardContent();
    
    assert.ok(content.includes('SYSTEM DASHBOARD'));
    assert.ok(content.includes('Keep-awake**: on since 15:30 IST'));
    assert.ok(content.includes('Model Failover Order'));
    assert.ok(content.includes('1. claude (priority 1)'));
    assert.ok(content.includes('2. gemini (priority 2)'));
    assert.ok(content.includes('Skill Schedule'));
    assert.ok(content.includes('daily-mail-brief**: `45 7 * * *`'));
  });

  it('handles off keep-awake', async () => {
    // Modify keep-awake state on disk
    await writeFile(join(sharedTempDir, 'telegram-keepawake.json'), JSON.stringify({ active: false }), 'utf8');

    const content = await getDashboardContent();
    assert.ok(content.includes('Keep-awake**: off'));
  });
});

// ---------------------------------------------------------------------------
// Capability matrix (T3)
// ---------------------------------------------------------------------------

/** Mirrors the live 2026-07-22 config: every worker declares model, all but gemini declare effort. */
const CAP_CONFIG = {
  workers: [
    {
      name: 'zclaude', priority: 1, command: 'z', args: [], check: 'c', rate_limit_patterns: [],
      tunables: {
        model: { args: ['--model', '{value}'] },
        effort: { args: ['--effort', '{value}'], values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      }
    },
    {
      // No tunables at all — must render cleanly, not awkwardly.
      name: 'gemini', priority: 2, command: 'g', args: [], check: 'c', rate_limit_patterns: []
    },
    {
      name: 'codex', priority: 3, command: 'x', args: [], check: 'c', rate_limit_patterns: [],
      tunables: {
        model: { args: ['--model', '{value}'] },
        effort: { args: ['-c', 'model_reasoning_effort={value}'], values: ['minimal', 'low', 'medium', 'high'] }
      }
    }
  ]
};

const cap = (name: string, priority: number, settings: Array<{ setting: string; values?: string[]; observed?: string[] }> = []) => ({
  name,
  priority,
  settings: settings.map(s => ({ setting: s.setting, values: s.values ?? [], observed: s.observed ?? [] }))
});

describe('Dashboard capability matrix (pure renderer)', () => {
  it('renders declared values and observed values for a worker with tunables', () => {
    const lines = renderWorkerCapabilityMatrix(
      [cap('codex', 3, [
        { setting: 'model', values: [], observed: ['gpt-5.4'] },
        { setting: 'effort', values: ['minimal', 'low', 'medium', 'high'] }
      ])],
      4000
    );
    const text = lines.join('\n');
    assert.ok(text.includes('1. codex (priority 3)'), text);
    assert.ok(text.includes('model: any value'), text);          // values are never gated
    assert.ok(text.includes('recent: gpt-5.4'), text);           // observed history
    assert.ok(text.includes('effort: minimal, low, medium, high'), text);
  });

  it('renders a worker with no tunables cleanly on one line', () => {
    const lines = renderWorkerCapabilityMatrix([cap('gemini', 2)], 4000);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '1. gemini (priority 2) — no settable options');
  });

  it('returns [] for an empty worker list', () => {
    assert.deepEqual(renderWorkerCapabilityMatrix([], 4000), []);
  });

  it('degrades instead of overflowing when the budget is tight', () => {
    const caps = [
      cap('zclaude', 1, [
        { setting: 'model', values: [], observed: ['opusplan', 'sonnet'] },
        { setting: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }
      ]),
      cap('codex', 4, [{ setting: 'effort', values: ['minimal', 'low', 'medium', 'high'] }])
    ];

    const rich = renderWorkerCapabilityMatrix(caps, 4000).join('\n');
    assert.ok(rich.includes('recent: opusplan'), rich);

    // Enough room for the values but not the history.
    const mid = renderWorkerCapabilityMatrix(caps, sent(rich) - 5).join('\n');
    assert.ok(!mid.includes('recent:'), mid);
    assert.ok(mid.includes('low, medium, high'), mid);

    // Barely any room: names only, then the bare priority list.
    const terse = renderWorkerCapabilityMatrix(caps, 90).join('\n');
    assert.ok(terse.includes('accepts: model, effort') || terse === '1. zclaude (priority 1)\n2. codex (priority 4)', terse);

    // Impossible budget still yields the original bare list — never nothing.
    const floor = renderWorkerCapabilityMatrix(caps, 0);
    assert.deepEqual(floor, ['1. zclaude (priority 1)', '2. codex (priority 4)']);
  });

  it('never exceeds the budget it was given at any detail level', () => {
    const caps = [
      cap('zclaude', 1, [{ setting: 'model', values: [], observed: ['a', 'b', 'c', 'd'] }, { setting: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }]),
      cap('agy', 2, [{ setting: 'model', values: [], observed: ['gemini-3.6-flash-high'] }, { setting: 'effort', values: ['low', 'medium', 'high'] }]),
      cap('gemini', 3),
      cap('codex', 4, [{ setting: 'model', values: [] }, { setting: 'effort', values: ['minimal', 'low', 'medium', 'high'] }]),
      cap('claude', 5, [{ setting: 'model', values: [] }, { setting: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }])
    ];
    for (const budget of [4000, 800, 500, 300, 200, 120]) {
      const rendered = renderWorkerCapabilityMatrix(caps, budget).join('\n');
      // The bare list is the floor: honour the budget whenever the floor fits.
      const floor = sent(renderWorkerCapabilityMatrix(caps, 0).join('\n'));
      if (budget >= floor) {
        assert.ok(sent(rendered) <= budget, `budget ${budget} exceeded: ${sent(rendered)}`);
      }
    }
  });
});

describe('Dashboard capability matrix (integration)', () => {
  after(async () => {
    await writeConfig(sharedTempDir, BASE_CONFIG);
  });

  it('documents capabilities without implying any topic is using them', async () => {
    await writeConfig(sharedTempDir, CAP_CONFIG);
    const content = await getDashboardContent();

    // The pre-existing section is still discoverable by its original name.
    assert.ok(content.includes('Model Failover Order'), content);
    assert.ok(content.includes('1. zclaude (priority 1)'), content);

    // Worker WITH tunables.
    assert.ok(content.includes('• model: any value'), content);
    assert.ok(content.includes('• effort: low, medium, high, xhigh, max'), content);
    assert.ok(content.includes('• effort: minimal, low, medium, high'), content);

    // Worker WITHOUT tunables.
    assert.ok(content.includes('2. gemini (priority 2) — no settable options'), content);

    // Global-not-per-topic framing must be explicit.
    assert.ok(/capability only/i.test(content), content);
    assert.ok(content.includes('/llm'), content);
    assert.ok(content.includes('/effort'), content);
  });

  it('stays well inside the Telegram limit for a realistic config', async () => {
    // Realistic worst case measured 2026-07-22: 5 workers all declaring
    // tunables + 21 scheduled skills. editMessageText cannot chunk, so an
    // over-long edit breaks the WHOLE pinned dashboard.
    const isolated = await mkdtemp(join(tmpdir(), 'dashboard-cap-'));
    const prev = process.env.PA_HOME;
    process.env.PA_HOME = isolated;
    try {
      const effort5 = { args: ['--effort', '{value}'], values: ['low', 'medium', 'high', 'xhigh', 'max'] };
      await writeConfig(isolated, {
        workers: [
          { name: 'zclaude', priority: 1, command: 'z', args: [], check: 'c', rate_limit_patterns: [], tunables: { model: { args: ['--model', '{value}'] }, effort: effort5 } },
          { name: 'agy', priority: 2, command: 'a', args: [], check: 'c', rate_limit_patterns: [], tunables: { model: { args: ['--model', '{value}'] }, effort: { args: ['--effort', '{value}'], values: ['low', 'medium', 'high'] } } },
          { name: 'gemini', priority: 3, command: 'g', args: [], check: 'c', rate_limit_patterns: [], tunables: { model: { args: ['--model', '{value}'] } } },
          { name: 'codex', priority: 4, command: 'x', args: [], check: 'c', rate_limit_patterns: [], tunables: { model: { args: ['--model', '{value}'] }, effort: { args: ['-c', 'model_reasoning_effort={value}'], values: ['minimal', 'low', 'medium', 'high'] } } },
          { name: 'claude', priority: 5, command: 'c', args: [], check: 'c', rate_limit_patterns: [], tunables: { model: { args: ['--model', '{value}'] }, effort: effort5 } }
        ]
      });

      const skillsPath = join(isolated, 'skills');
      await mkdir(skillsPath);
      for (let i = 0; i < 21; i++) {
        const name = `scheduled-skill-with-a-long-name-${i}`;
        await mkdir(join(skillsPath, name));
        await writeFile(join(skillsPath, name, 'skill.md'), `---\ncron: "30 13,23 * * *"\n---\np`, 'utf8');
      }

      const content = await getDashboardContent();
      const length = sent(content);
      assert.ok(length <= TELEGRAM_MESSAGE_LIMIT - DASHBOARD_RESERVE, `dashboard too long: ${length}`);
      // Sanity: it degraded to nothing useful only if the budget forced it.
      assert.ok(content.includes('• effort:'), content);
    } finally {
      process.env.PA_HOME = prev;
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it('clamps the whole message when the skill list alone would blow the cap', async () => {
    // PRE-EXISTING overflow, surfaced (not caused) by the matrix work: the
    // skill schedule had no cap at all, and ~60 skills exceed 4096 on their
    // own. editMessageText cannot chunk, so that would freeze the pinned
    // dashboard entirely.
    const isolated = await mkdtemp(join(tmpdir(), 'dashboard-many-'));
    const prev = process.env.PA_HOME;
    process.env.PA_HOME = isolated;
    try {
      await writeConfig(isolated, CAP_CONFIG);
      const skillsPath = join(isolated, 'skills');
      await mkdir(skillsPath);
      for (let i = 0; i < 120; i++) {
        const name = `a-fairly-long-scheduled-skill-name-${i}`;
        await mkdir(join(skillsPath, name));
        await writeFile(join(skillsPath, name, 'skill.md'), `---\ncron: "30 13,23 * * *"\n---\np`, 'utf8');
      }

      const content = await getDashboardContent();
      assert.ok(sent(content) <= TELEGRAM_MESSAGE_LIMIT - DASHBOARD_RESERVE, `too long: ${sent(content)}`);
      assert.ok(/more — run/.test(content), 'truncation must be signposted');
      // The worker section survives the squeeze — degraded, never dropped.
      assert.ok(content.includes('1. zclaude (priority 1)'), content.slice(0, 400));
    } finally {
      process.env.PA_HOME = prev;
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it('does not throw and keeps the bare list when no worker declares tunables', async () => {
    await writeConfig(sharedTempDir, BASE_CONFIG);
    const content = await getDashboardContent();
    assert.ok(content.includes('1. claude (priority 1)'), content);
    assert.ok(content.includes('2. gemini (priority 2)'), content);
    assert.ok(!content.includes('•'), content);
  });
});
