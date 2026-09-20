import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildProfile, renderText } from '../src/commands/doctor.js';
import { listForDoctor } from '../src/lib/coexistence.js';
import { paHome } from '../src/paths.js';

/**
 * pa doctor's coexistence arm (Wave C WP-C2): PA-touched entries per the
 * coexistence registry, rendered in both the JSON profile and the human
 * table. Pure parts only — collectProbes()/doctorCommand() are never called
 * (live probes are out of scope here; same contract as doctor.test.ts).
 */

describe('pa doctor coexistence arm', () => {
  let paHomeDir: string;
  const savedPaHome = process.env.PA_HOME;

  before(() => {
    paHomeDir = mkdtempSync(join(tmpdir(), 'coexist-doctor-'));
    process.env.PA_HOME = paHomeDir;
  });

  after(() => {
    process.env.PA_HOME = savedPaHome;
    rmSync(paHomeDir, { recursive: true, force: true });
  });

  function seedRegistry(entries: unknown): void {
    writeFileSync(join(paHome(), 'coexistence-registry.json'), JSON.stringify({ entries }), 'utf8');
  }

  it('empty registry: profile coexistence block is empty and renderText omits it', async () => {
    const profile = buildProfile({
      os: { platform: 'win32', release: '10', arch: 'x64' },
      shell: { powershell: true, pwsh: false, bash: false },
      cpus: 4,
      memTotalBytes: 8 * 1024 ** 3,
      disk: [],
      paHome: paHomeDir,
      paths: { repoRoot: 'D:/test', nodeVersion: 'v22' },
      schedulerBackend: 'unknown',
      telegramDirect: 'unknown',
      workers: [],
      coexistence: await listForDoctor(),
    });
    assert.deepEqual(profile.coexistence, []);
    assert.ok(!renderText(profile).includes('coexist    '));
  });

  it('seeded registry: profile lists the PA-touched entries; renderText prints a coexist line', async () => {
    seedRegistry([
      {
        id: 'claude-claude-settings-json-abc123',
        cli: 'claude',
        surface: 'C:/Users/example/.claude/settings.json',
        mode: 'registry-restore',
        snapshot: join(paHomeDir, 'coexistence-snapshots', 'x.snap'),
        addedKeys: ['hooks'],
        timestamp: new Date().toISOString(),
      },
    ]);
    const profile = buildProfile({
      os: { platform: 'win32', release: '10', arch: 'x64' },
      shell: { powershell: true, pwsh: false, bash: false },
      cpus: 4,
      memTotalBytes: 8 * 1024 ** 3,
      disk: [],
      paHome: paHomeDir,
      paths: { repoRoot: 'D:/test', nodeVersion: 'v22' },
      schedulerBackend: 'unknown',
      telegramDirect: 'unknown',
      workers: [],
      coexistence: await listForDoctor(),
    });
    assert.equal(profile.coexistence.length, 1);
    assert.equal(profile.coexistence[0].cli, 'claude');
    assert.deepEqual(profile.coexistence[0].addedKeys, ['hooks']);
    const text = renderText(profile);
    assert.ok(text.includes('coexist    claude claude-claude-settings-json-abc123 addedKeys=hooks'));
    rmSync(join(paHome(), 'coexistence-registry.json'), { force: true });
  });

  it('listForDoctor degrades to [] on a corrupt registry (probe-degrades contract)', async () => {
    const reg = join(paHome(), 'coexistence-registry.json');
    writeFileSync(reg, '{corrupt', 'utf8');
    assert.deepEqual(await listForDoctor(), []);
    rmSync(reg, { force: true });
  });

  it('renderText coexist line omits addedKeys parens when none recorded', () => {
    const p = buildProfile({
      os: { platform: 'win32', release: '10', arch: 'x64' },
      shell: { powershell: true, pwsh: false, bash: false },
      cpus: 4,
      memTotalBytes: 8 * 1024 ** 3,
      disk: [],
      paHome: paHomeDir,
      paths: { repoRoot: 'D:/test', nodeVersion: 'v22' },
      schedulerBackend: 'unknown',
      telegramDirect: 'unknown',
      workers: [],
      coexistence: [
        { id: 'devin-x', cli: 'devin', surface: 'C:/d.json', addedKeys: [], timestamp: '2026-09-17T00:00:00Z' },
      ],
    });
    assert.ok(renderText(p).includes('coexist    devin devin-x addedKeys=(none)'));
  });
});
