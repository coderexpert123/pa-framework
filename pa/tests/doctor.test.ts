import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import {
  resourceClassFor,
  diskClassFor,
  deriveProfile,
  buildProfile,
  renderText,
} from '../src/commands/doctor.js';
import { paHome } from '../src/paths.js';
import { createTempPaHome, cleanup } from './helpers.js';

/**
 * pa doctor — PURE parts only. No test in this file may call collectProbes()
 * or doctorCommand(): live probes (spawned CLIs, the Telegram HEAD probe,
 * PowerShell disk queries) stay outside the unit gate. The seam is
 * ProbeResults — fixtures inject it into buildProfile()/deriveProfile().
 */

const GIB = 1024 ** 3;

function fixture(overrides: Record<string, unknown> = {}): Parameters<typeof buildProfile>[0] {
  return {
    os: { platform: 'win32', release: '10.0.26100', arch: 'x64' },
    shell: { powershell: true, pwsh: false, bash: true },
    cpus: 8,
    memTotalBytes: 16 * GIB,
    disk: [{ mount: 'C:\\', gb: 476, ssdLikely: true }],
    paHome: join('C:', 'nonexistent-doctor-test-home', '.pa'),
    paths: { repoRoot: join('D:', 'test-repo'), nodeVersion: 'v22.0.0' },
    schedulerBackend: 'task-scheduler',
    telegramDirect: true,
    workers: [
      { name: 'claude', available: true, version: '1.2.3' },
      { name: 'codex', available: false },
    ],
    ...overrides,
  } as Parameters<typeof buildProfile>[0];
}

describe('resourceClassFor thresholds', () => {
  it('classifies low: few cpus', () => {
    assert.equal(resourceClassFor(1, 2 * GIB), 'low');
    assert.equal(resourceClassFor(2, 32 * GIB), 'low'); // cpu floor wins
  });

  it('classifies low: little memory', () => {
    assert.equal(resourceClassFor(8, 4 * GIB), 'low'); // mem floor wins over cpus
  });

  it('classifies high only when cpus AND memory both clear the ceilings', () => {
    assert.equal(resourceClassFor(8, 16 * GIB), 'high');
    assert.equal(resourceClassFor(16, 32 * GIB), 'high');
    assert.equal(resourceClassFor(8, 8 * GIB), 'mid'); // mem below ceiling
    assert.equal(resourceClassFor(4, 32 * GIB), 'mid'); // cpus below ceiling
  });

  it('classifies mid between the floors and ceilings', () => {
    assert.equal(resourceClassFor(3, 8 * GIB), 'mid');
    assert.equal(resourceClassFor(4, 16 * GIB), 'mid');
  });
});

describe('diskClassFor and suggestedSerializeSuites', () => {
  it('empty disk list is unknown, never hdd', () => {
    assert.equal(diskClassFor([]), 'unknown');
  });

  it('all confirmed non-rotational is ssd', () => {
    assert.equal(diskClassFor([{ mount: 'C:\\', gb: 476, ssdLikely: true }]), 'ssd');
  });

  it('one confirmed rotational disk anywhere makes the machine hdd', () => {
    assert.equal(
      diskClassFor([
        { mount: 'C:\\', gb: 476, ssdLikely: true },
        { mount: 'D:\\', gb: 931, ssdLikely: false },
      ]),
      'hdd'
    );
  });

  it('partial evidence (true + unknown) is honest unknown', () => {
    assert.equal(
      diskClassFor([
        { mount: 'C:\\', gb: 476, ssdLikely: true },
        { mount: 'D:\\', gb: 931, ssdLikely: 'unknown' },
      ]),
      'unknown'
    );
  });

  it('all-unknown evidence is unknown', () => {
    assert.equal(diskClassFor([{ mount: '/', gb: 100, ssdLikely: 'unknown' }]), 'unknown');
  });

  it('suggestedSerializeSuites is EXACTLY diskClass === hdd', () => {
    const hdd = deriveProfile(fixture({ disk: [{ mount: 'C:\\', gb: 100, ssdLikely: false }] }));
    const ssd = deriveProfile(fixture({ disk: [{ mount: 'C:\\', gb: 100, ssdLikely: true }] }));
    const unk = deriveProfile(fixture({ disk: [{ mount: 'C:\\', gb: 100, ssdLikely: 'unknown' }] }));
    assert.equal(hdd.suggestedSerializeSuites, true);
    assert.equal(hdd.diskClass, 'hdd');
    assert.equal(ssd.suggestedSerializeSuites, false);
    assert.equal(unk.suggestedSerializeSuites, false);
  });
});

describe('buildProfile JSON shape completeness (every spec field present)', () => {
  it('carries every spec field with the right type', () => {
    const p = buildProfile(fixture());

    // os
    assert.equal(typeof p.os.platform, 'string');
    assert.equal(typeof p.os.release, 'string');
    assert.equal(typeof p.os.arch, 'string');
    // shell
    assert.equal(typeof p.shell.powershell, 'boolean');
    assert.equal(typeof p.shell.pwsh, 'boolean');
    assert.equal(typeof p.shell.bash, 'boolean');
    // resources
    assert.equal(typeof p.cpus, 'number');
    assert.ok(p.cpus > 0);
    assert.equal(typeof p.memTotalBytes, 'number');
    assert.ok(p.memTotalBytes > 0);
    // disk entries
    assert.ok(Array.isArray(p.disk));
    for (const d of p.disk) {
      assert.equal(typeof d.mount, 'string');
      assert.equal(typeof d.gb, 'number');
      assert.ok(d.ssdLikely === true || d.ssdLikely === false || d.ssdLikely === 'unknown');
    }
    // paHome + paths
    assert.equal(typeof p.paHome, 'string');
    assert.ok(p.paHome.length > 0);
    assert.equal(typeof p.paths.repoRoot, 'string');
    assert.equal(typeof p.paths.nodeVersion, 'string');
    // scheduler + telegram
    assert.ok(['task-scheduler', 'cron', 'launchd', 'unknown'].includes(p.schedulerBackend));
    assert.ok(p.telegramDirect === true || p.telegramDirect === false || p.telegramDirect === 'unknown');
    // workers
    assert.ok(Array.isArray(p.workers));
    const claude = p.workers.find((w) => w.name === 'claude');
    assert.ok(claude, 'fleet list must include claude');
    assert.equal(claude.available, true);
    assert.equal(claude.version, '1.2.3');
    const codex = p.workers.find((w) => w.name === 'codex');
    assert.ok(codex, 'fleet list must include codex');
    assert.equal(codex.available, false);
    assert.ok(!('version' in codex), 'unavailable worker carries no version field');
    // derivedProfile
    assert.ok(['low', 'mid', 'high'].includes(p.derivedProfile.resourceClass));
    assert.ok(['hdd', 'ssd', 'unknown'].includes(p.derivedProfile.diskClass));
    assert.equal(typeof p.derivedProfile.suggestedSerializeSuites, 'boolean');
  });

  it('survives a JSON round-trip unchanged (output is JSON-safe)', () => {
    const p = buildProfile(fixture());
    const round = JSON.parse(JSON.stringify(p)) as typeof p;
    assert.deepEqual(round, p);
  });

  it('keeps the derivedProfile consistent with its inputs', () => {
    // fixture default: 8 cpus / 16 GiB / ssd disk => high + ssd + no serialize
    const p = buildProfile(fixture());
    assert.equal(p.derivedProfile.resourceClass, 'high');
    assert.equal(p.derivedProfile.diskClass, 'ssd');
    assert.equal(p.derivedProfile.suggestedSerializeSuites, false);
  });
});

describe('paHome probe seam (temp PA_HOME idiom)', () => {
  it('profile echoes the resolved PA_HOME verbatim', async () => {
    const tempDir = await createTempPaHome();
    try {
      const p = buildProfile(fixture({ paHome: paHome() }));
      assert.equal(p.paHome, tempDir);
    } finally {
      await cleanup(tempDir);
    }
  });
});

describe('renderText human table', () => {
  it('carries the derived classes and a worker line', () => {
    const text = renderText(buildProfile(fixture()));
    assert.ok(text.includes('resourceClass=high'));
    assert.ok(text.includes('diskClass=ssd'));
    assert.ok(text.includes('suggestedSerializeSuites=false'));
    assert.ok(text.includes('claude: available (1.2.3)'));
    assert.ok(text.includes('codex: unavailable'));
    assert.ok(text.includes('task-scheduler'));
    assert.ok(text.includes('C:\\ 476 GB ssdLikely=true'));
  });
});
