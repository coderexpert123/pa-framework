import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeFileIdentity, formatBootIdentity } from '../boot-identity.js';
import { unlinkSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('computeFileIdentity', () => {
  const testDir = join(tmpdir(), 'boot-identity-test');
  const testFile = join(testDir, 'test-file.txt');

  before(() => {
    // Create test directory
    try { mkdirSync(testDir, { recursive: true }); } catch {}
  });

  after(() => {
    // Cleanup test file
    try { unlinkSync(testFile); } catch {}
  });

  it('returns sha256 hash (first 12 hex chars) and ISO-8601 mtime', () => {
    const content = 'test content for identity';
    writeFileSync(testFile, content);

    const result = computeFileIdentity(testFile);

    assert.ok(result.sha);
    assert.equal(result.sha.length, 12);
    assert.match(result.sha, /^[a-f0-9]{12}$/);

    assert.ok(result.mtime);
    assert.ok(!isNaN(new Date(result.mtime).getTime()));
  });

  it('returns consistent sha for same content', () => {
    const content = 'consistent content';
    writeFileSync(testFile, content);

    const result1 = computeFileIdentity(testFile);
    const result2 = computeFileIdentity(testFile);

    assert.equal(result1.sha, result2.sha);
  });

  it('returns different sha for different content', () => {
    writeFileSync(testFile, 'content A');
    const result1 = computeFileIdentity(testFile);

    writeFileSync(testFile, 'content B');
    const result2 = computeFileIdentity(testFile);

    assert.notEqual(result1.sha, result2.sha);
  });

  it('returns different mtime for modified file', () => {
    writeFileSync(testFile, 'initial');
    const result1 = computeFileIdentity(testFile);

    // Wait a bit to ensure mtime changes
    const start = Date.now();
    while (Date.now() - start < 10) { /* sleep 10ms */ }

    writeFileSync(testFile, 'modified');
    const result2 = computeFileIdentity(testFile);

    assert.notEqual(result1.mtime, result2.mtime);
  });
});

describe('formatBootIdentity', () => {
  it('formats the boot identity banner line', () => {
    const testDir = join(tmpdir(), 'boot-identity-test');
    const testFile = join(testDir, 'test-file.txt');

    try { mkdirSync(testDir, { recursive: true }); } catch {}
    try { unlinkSync(testFile); } catch {}

    writeFileSync(testFile, 'test');
    const result = formatBootIdentity(testFile);

    assert.match(result, /^dist identity sha=[a-f0-9]{12} mtime=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
