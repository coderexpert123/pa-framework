import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LIVE_ACTIVITY_MS,
  TRANSCRIPT_SCAN_DAYS,
  attributePath,
  deriveTranscriptDirName,
  scanTranscriptsForPaths,
  type TranscriptHit,
} from '../src/lib/orphan-attribution.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.now(); // real wall clock — liveness math uses real mtimes

describe('attributePath (pure)', () => {
  const base = {
    path: 'src/a.ts',
    pathMtimeMs: NOW - 7 * HOUR,
    now: NOW,
    activeReservations: [] as Array<{ paths: string[]; session: string }>,
    transcriptHits: [] as TranscriptHit[],
  };

  it('reservation hit wins over everything and carries the session', () => {
    const res = attributePath({
      ...base,
      activeReservations: [{ paths: ['src'], session: 'someone-else' }],
      transcriptHits: [{ file: 't.jsonl', fileMtimeMs: NOW - 1000, newestMatchTs: NOW - 1000 }],
    });
    assert.deepEqual(res, { status: 'reserved', session: 'someone-else' });
  });

  it('newest transcript hit wins over an older one', () => {
    const res = attributePath({
      ...base,
      transcriptHits: [
        { file: 'old.jsonl', fileMtimeMs: NOW - 3 * HOUR, newestMatchTs: NOW - 3 * HOUR },
        { file: 'new.jsonl', fileMtimeMs: NOW - HOUR, newestMatchTs: NOW - HOUR },
      ],
    });
    assert.equal(res.status, 'owned');
    if (res.status === 'owned') {
      assert.equal(res.ownerFile, 'new.jsonl');
      assert.equal(res.lastActivityMs, NOW - HOUR);
    }
  });

  it('liveness boundary: file mtime within LIVE_ACTIVITY_MS is alive, 1s past is not', () => {
    const alive = attributePath({
      ...base,
      transcriptHits: [{ file: 't.jsonl', fileMtimeMs: NOW - LIVE_ACTIVITY_MS + 1000, newestMatchTs: NOW - 5 * HOUR }],
    });
    assert.equal(alive.status, 'owned');
    assert.equal(alive.status === 'owned' && alive.alive, true);

    const dead = attributePath({
      ...base,
      transcriptHits: [{ file: 't.jsonl', fileMtimeMs: NOW - LIVE_ACTIVITY_MS - 1000, newestMatchTs: NOW - 5 * HOUR }],
    });
    assert.equal(dead.status, 'owned');
    assert.equal(dead.status === 'owned' && dead.alive, false);
  });

  it('no reservation and no hits → unattributed', () => {
    assert.deepEqual(attributePath(base), { status: 'unattributed' });
  });
});

describe('scanTranscriptsForPaths (temp PA_CLAUDE_PROJECTS_DIR)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orphan-attr-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    delete process.env.PA_CLAUDE_PROJECTS_DIR;
  });

  const repoRoot = 'C:\\wt\\fake-repo';

  async function seedTranscript(name: string, lines: string[], mtimeMs?: number): Promise<string> {
    const dir = join(root, 'projects', deriveTranscriptDirName(repoRoot));
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    await writeFile(file, lines.join('\n') + '\n', 'utf8');
    if (mtimeMs !== undefined) {
      const when = new Date(mtimeMs);
      await utimes(file, when, when);
    }
    return file;
  }

  it('derives the Claude projects subdir name (both slash directions, spaces)', () => {
    assert.equal(deriveTranscriptDirName('D:\\Personal Assistant'), 'D--Personal-Assistant');
    assert.equal(deriveTranscriptDirName('C:\\Users\\test'), 'C--Users-test');
    assert.equal(deriveTranscriptDirName('/home/user/repo'), '-home-user-repo');
  });

  it('finds a path in a recent transcript (absolute backslash form) and reads its timestamp', async () => {
    await seedTranscript('t1.jsonl', [
      JSON.stringify({ timestamp: new Date(NOW - HOUR).toISOString(), content: `edited ${repoRoot}\\src\\a.ts here` }),
    ]);
    const res = await scanTranscriptsForPaths(repoRoot, ['src/a.ts'], { now: NOW, projectsDirFn: () => join(root, 'projects') });
    const hits = res.hitsByPath.get('src/a.ts');
    assert.ok(hits);
    assert.equal(hits!.length, 1);
    assert.equal(hits![0].newestMatchTs, Date.parse(new Date(NOW - HOUR).toISOString()));
    assert.equal(res.budgetExhausted, false);
  });

  it('a transcript older than TRANSCRIPT_SCAN_DAYS is never scanned', async () => {
    await seedTranscript(
      'old.jsonl',
      [JSON.stringify({ timestamp: new Date(NOW - HOUR).toISOString(), content: 'src/a.ts' })],
      NOW - (TRANSCRIPT_SCAN_DAYS * 24 * HOUR + 2 * HOUR),
    );
    const res = await scanTranscriptsForPaths(repoRoot, ['src/a.ts'], { now: NOW, projectsDirFn: () => join(root, 'projects') });
    assert.equal(res.hitsByPath.size, 0);
    assert.equal(res.scannedFiles, 0);
  });

  it('corrupted / missing-ts matching lines fall back to the file mtime', async () => {
    const file = await seedTranscript('bad.jsonl', [
      'not json at all but names src/a.ts',
      JSON.stringify({ no_timestamp: true, body: 'src/a.ts again' }),
    ]);
    const res = await scanTranscriptsForPaths(repoRoot, ['src/a.ts'], { now: NOW, projectsDirFn: () => join(root, 'projects') });
    const hits = res.hitsByPath.get('src/a.ts');
    assert.ok(hits);
    const st = await (await import('fs/promises')).stat(file);
    assert.equal(hits![0].newestMatchTs, st.mtimeMs);
  });

  it('budget exhaustion stops the scan and returns what was found (fail-safe to unattributed)', async () => {
    await seedTranscript('t1.jsonl', [JSON.stringify({ timestamp: new Date(NOW - HOUR).toISOString(), content: 'src/a.ts' })]);
    const res = await scanTranscriptsForPaths(repoRoot, ['src/a.ts', 'src/never-found.ts'], {
      now: NOW,
      projectsDirFn: () => join(root, 'projects'),
      budgetMs: 0,
    });
    assert.equal(res.budgetExhausted, true);
    assert.equal(res.scannedFiles, 0);
    assert.equal(res.hitsByPath.get('src/never-found.ts'), undefined);
  });

  it('absent transcript dir and empty path list both return empty without throwing', async () => {
    const noDir = await scanTranscriptsForPaths('C:\\nope\\missing', ['src/a.ts'], { now: NOW, projectsDirFn: () => join(root, 'projects') });
    assert.equal(noDir.hitsByPath.size, 0);
    const noPaths = await scanTranscriptsForPaths(repoRoot, [], { now: NOW, projectsDirFn: () => join(root, 'projects') });
    assert.equal(noPaths.hitsByPath.size, 0);
    assert.equal(noPaths.scannedFiles, 0);
  });

  it('PA_CLAUDE_PROJECTS_DIR env override redirects the default root', async () => {
    process.env.PA_CLAUDE_PROJECTS_DIR = join(root, 'envroot');
    const dir = join(root, 'envroot', deriveTranscriptDirName(repoRoot));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 't.jsonl'), `${JSON.stringify({ timestamp: new Date(NOW - HOUR).toISOString() })} src/a.ts\n`, 'utf8');
    // No projectsDirFn — the env override must carry it.
    const res = await scanTranscriptsForPaths(repoRoot, ['src/a.ts'], { now: NOW });
    assert.ok(res.hitsByPath.get('src/a.ts'));
  });
});
