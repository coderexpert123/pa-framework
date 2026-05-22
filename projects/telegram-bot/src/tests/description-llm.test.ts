import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDescriptionWithLLM,
  DESCRIPTION_SYSTEM_PROMPT,
} from '../main.js';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

interface Captured {
  cmd: string;
  args: string[];
  opts: any;
}

function makeRunner(captured: Captured, behavior: 'success' | 'error'): any {
  return (cmd: string, args: string[], opts: any, cb: any): void => {
    captured.cmd = cmd;
    captured.args = args;
    captured.opts = opts;
    if (behavior === 'success') {
      cb(null, 'A topic about hyper-local weather queries near me.', '');
    } else {
      cb(new Error('Command failed'), '', 'stderr noise');
    }
  };
}

let captured: Captured;

beforeEach(() => {
  captured = { cmd: '', args: [], opts: null };
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

describe('generateDescriptionWithLLM — argument handling', { concurrency: 1 }, () => {
  it('on win32, multi-word args are wrapped in double quotes', async () => {
    setPlatform('win32');
    await generateDescriptionWithLLM('hyper-local', undefined, makeRunner(captured, 'success'));
    // args layout: [--system-prompt, <prompt>, -p, <userPrompt>, --output-format, text]
    assert.match(captured.args[1], /^"[^"]+"$/, 'system prompt arg must be wrapped in "..."');
    assert.match(captured.args[3], /^"[^"]+"$/, 'user prompt arg must be wrapped in "..."');
  });

  it('on win32, single-token args are NOT quoted', async () => {
    setPlatform('win32');
    await generateDescriptionWithLLM('hyper-local', undefined, makeRunner(captured, 'success'));
    assert.equal(captured.args[0], '--system-prompt');
    assert.equal(captured.args[2], '-p');
    assert.equal(captured.args[4], '--output-format');
    assert.equal(captured.args[5], 'text');
  });

  it('on non-win32, args are passed through without surrounding quotes', async () => {
    setPlatform('linux');
    await generateDescriptionWithLLM('hyper-local', undefined, makeRunner(captured, 'success'));
    assert.ok(!captured.args[1].startsWith('"'), 'system prompt must not be wrapped on non-Windows');
    assert.ok(!captured.args[3].startsWith('"'), 'user prompt must not be wrapped on non-Windows');
  });

  it('sets stdio to [ignore, pipe, pipe] so claude.cmd does not wait on stdin', async () => {
    setPlatform('win32');
    await generateDescriptionWithLLM('hyper-local', undefined, makeRunner(captured, 'success'));
    assert.deepEqual(captured.opts.stdio, ['ignore', 'pipe', 'pipe']);
  });

  it('keeps the 30s timeout', async () => {
    setPlatform('win32');
    await generateDescriptionWithLLM('hyper-local', undefined, makeRunner(captured, 'success'));
    assert.equal(captured.opts.timeout, 30_000);
  });

  it('keeps shell:true (needed to invoke .cmd via cmd.exe)', async () => {
    setPlatform('win32');
    await generateDescriptionWithLLM('hyper-local', undefined, makeRunner(captured, 'success'));
    assert.equal(captured.opts.shell, true);
  });
});

describe('generateDescriptionWithLLM — runner output handling', { concurrency: 1 }, () => {
  it('runner success → confident description', async () => {
    const result = await generateDescriptionWithLLM('hyper-local', undefined, makeRunner(captured, 'success'));
    assert.equal(result.confident, true);
    assert.match(result.description, /weather/);
  });

  it('runner error → confident=false, empty description', async () => {
    const result = await generateDescriptionWithLLM('hyper-local', undefined, makeRunner(captured, 'error'));
    assert.equal(result.confident, false);
    assert.equal(result.description, '');
  });
});

describe('DESCRIPTION_SYSTEM_PROMPT — quote-regression guard', () => {
  it('contains no double-quote characters (otherwise Windows arg quoting breaks)', () => {
    assert.equal(
      DESCRIPTION_SYSTEM_PROMPT.includes('"'),
      false,
      'DESCRIPTION_SYSTEM_PROMPT must not contain " characters — they break the Windows shell arg-quoting fix in generateDescriptionWithLLM',
    );
  });
});
