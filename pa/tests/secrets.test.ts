import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { loadSecrets } from '../src/secrets.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('loadSecrets', () => {
  it('parses KEY=VALUE pairs', async () => {
    await createTempSecrets(tempDir, 'FOO=bar\nBAZ=qux\n');
    const secrets = await loadSecrets();
    assert.equal(secrets.FOO, 'bar');
    assert.equal(secrets.BAZ, 'qux');
  });

  it('strips surrounding double quotes', async () => {
    await createTempSecrets(tempDir, 'KEY="hello world"\n');
    const secrets = await loadSecrets();
    assert.equal(secrets.KEY, 'hello world');
  });

  it('strips surrounding single quotes', async () => {
    await createTempSecrets(tempDir, "KEY='hello world'\n");
    const secrets = await loadSecrets();
    assert.equal(secrets.KEY, 'hello world');
  });

  it('skips comments and empty lines', async () => {
    await createTempSecrets(tempDir, '# comment\n\nKEY=val\n  \n# another\n');
    const secrets = await loadSecrets();
    assert.equal(Object.keys(secrets).length, 1);
    assert.equal(secrets.KEY, 'val');
  });

  it('handles values with = signs', async () => {
    await createTempSecrets(tempDir, 'KEY=a=b=c\n');
    const secrets = await loadSecrets();
    assert.equal(secrets.KEY, 'a=b=c');
  });

  it('returns empty map for missing file', async () => {
    // No secrets.env created
    const secrets = await loadSecrets();
    assert.deepEqual(secrets, {});
  });

  it('filters to requested keys', async () => {
    await createTempSecrets(tempDir, 'A=1\nB=2\nC=3\n');
    const secrets = await loadSecrets(['A', 'C']);
    assert.equal(Object.keys(secrets).length, 2);
    assert.equal(secrets.A, '1');
    assert.equal(secrets.C, '3');
    assert.equal(secrets.B, undefined);
  });

  it('returns all keys when no filter', async () => {
    await createTempSecrets(tempDir, 'A=1\nB=2\n');
    const secrets = await loadSecrets();
    assert.equal(Object.keys(secrets).length, 2);
  });

  it('handles Windows CRLF line endings', async () => {
    await createTempSecrets(tempDir, 'KEY=val\r\nKEY2=val2\r\n');
    const secrets = await loadSecrets();
    assert.equal(secrets.KEY, 'val');
    assert.equal(secrets.KEY2, 'val2');
  });

  it('last value wins for duplicate keys', async () => {
    await createTempSecrets(tempDir, 'KEY=first\nKEY=second\n');
    const secrets = await loadSecrets();
    assert.equal(secrets.KEY, 'second');
  });

  it('skips lines without = sign', async () => {
    await createTempSecrets(tempDir, 'NOEQUALS\nKEY=val\n');
    const secrets = await loadSecrets();
    assert.equal(Object.keys(secrets).length, 1);
    assert.equal(secrets.KEY, 'val');
  });
});
