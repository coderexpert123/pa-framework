import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerErrorResponse } from '../logic.js';

describe('buildWorkerErrorResponse', () => {
  it('basic failure with exitCode 1 and stderr renders code-fence', () => {
    const out = buildWorkerErrorResponse({ worker: 'claude', exitCode: 1, stderr: 'API error', suggestedWorker: 'agy' });
    assert.ok(out.startsWith('⚠️ claude failed (exit 1).'));
    assert.ok(out.includes('```\nAPI error\n```'));
    assert.ok(out.includes('Try again, or switch with /model agy.'));
  });

  it('exitCode -1 omits the exit suffix', () => {
    const out = buildWorkerErrorResponse({ worker: 'claude', exitCode: -1, stderr: 'spawn error', suggestedWorker: 'agy' });
    assert.ok(out.startsWith('⚠️ claude failed.'));
    assert.ok(!out.includes('(exit -1)'));
  });

  it('exitCode undefined omits the exit suffix', () => {
    const out = buildWorkerErrorResponse({ worker: 'agy', exitCode: undefined, stderr: 'err', suggestedWorker: 'claude' });
    assert.ok(out.startsWith('⚠️ agy failed.'));
    assert.ok(!out.includes('(exit'));
  });

  it('empty stderr omits the code-fence block', () => {
    const out = buildWorkerErrorResponse({ worker: 'claude', exitCode: 1, stderr: '', suggestedWorker: 'agy' });
    assert.ok(!out.includes('```'));
    assert.ok(out.includes('Try again, or switch with /model agy.'));
  });

  it('stderr over 500 chars is truncated to 500', () => {
    const longStderr = 'x'.repeat(600);
    const out = buildWorkerErrorResponse({ worker: 'claude', exitCode: 1, stderr: longStderr, suggestedWorker: 'agy' });
    assert.ok(out.includes('x'.repeat(500)));
    assert.ok(!out.includes('x'.repeat(501)));
  });

  it('stderr containing triple-backtick is sanitized to triple-quote', () => {
    const out = buildWorkerErrorResponse({ worker: 'claude', exitCode: 1, stderr: 'before ```code``` after', suggestedWorker: 'agy' });
    assert.ok(out.includes("before '''code''' after"));
    assert.ok(!out.includes('```code```'));
  });

  it('emptyResponse variant has no code-fence and uses the empty-response line', () => {
    const out = buildWorkerErrorResponse({ worker: 'agy', emptyResponse: true, suggestedWorker: 'zclaude' });
    assert.ok(out.startsWith('⚠️ agy returned an empty response.'));
    assert.ok(!out.includes('```'));
    assert.ok(out.includes('Try again, or switch with /model zclaude.'));
  });

  it('suggestedWorker null renders the cooling-down fallback line', () => {
    const out = buildWorkerErrorResponse({ worker: 'claude', exitCode: 1, stderr: 'err', suggestedWorker: null });
    assert.ok(out.includes('Try again (all other workers cooling down or unavailable).'));
    assert.ok(!out.includes('/model'));
  });
});
