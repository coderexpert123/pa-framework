import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { profilePath } from '../src/paths.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('profilePath (AI-089 relocation)', () => {
  it('resolves under PA_HOME/data, not the repo tree', () => {
    assert.equal(profilePath(), join(tempDir, 'data', 'profile.json'));
  });

  it('follows PA_HOME when it changes at runtime', async () => {
    const other = await createTempPaHome();
    try {
      assert.equal(profilePath(), join(other, 'data', 'profile.json'));
    } finally {
      await cleanup(other);
    }
  });
});
