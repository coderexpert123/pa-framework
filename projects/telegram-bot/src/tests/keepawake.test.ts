import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getKeepAwakeStatus } from '../keepawake.js';

function getPaHome(): string {
  return process.env.PA_HOME || join(homedir(), '.pa');
}
const STATE_FILE = join(getPaHome(), 'telegram-keepawake.json');

describe('keepawake', () => {
  beforeEach(() => {
    if (existsSync(STATE_FILE)) {
      try { unlinkSync(STATE_FILE); } catch {}
    }
  });

  it('should return inactive if no state file exists', () => {
    const status = getKeepAwakeStatus();
    assert.strictEqual(status.active, false);
  });
});
