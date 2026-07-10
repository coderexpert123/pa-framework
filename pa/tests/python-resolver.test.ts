import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePythonCommand, _resetPythonCacheForTest } from '../src/lib/python.js';
import type { PythonProbe } from '../src/lib/python.js';

beforeEach(() => {
  _resetPythonCacheForTest();
});

function trackedProbe(result: boolean): { probe: PythonProbe; calls: string[] } {
  const calls: string[] = [];
  const probe: PythonProbe = (cmd) => {
    calls.push(cmd);
    return result;
  };
  return { probe, calls };
}

describe('resolvePythonCommand', () => {
  it('$PYTHON env wins verbatim and is trimmed, probe never called', () => {
    const { probe, calls } = trackedProbe(true);
    const result = resolvePythonCommand({ PYTHON: '  /usr/bin/python3.11  ' } as NodeJS.ProcessEnv, probe, 'linux');
    assert.equal(result, '/usr/bin/python3.11');
    assert.equal(calls.length, 0, 'probe should never be called when $PYTHON is set');
  });

  it('$PYTHON env wins verbatim on win32 too', () => {
    const { probe, calls } = trackedProbe(true);
    const result = resolvePythonCommand({ PYTHON: 'py' } as NodeJS.ProcessEnv, probe, 'win32');
    assert.equal(result, 'py');
    assert.equal(calls.length, 0);
  });

  it('empty/whitespace-only $PYTHON is ignored, falls through to platform logic', () => {
    const result = resolvePythonCommand({ PYTHON: '   ' } as NodeJS.ProcessEnv, () => true, 'win32');
    assert.equal(result, 'python');
  });

  it('win32 (no $PYTHON) resolves to "python" without probing', () => {
    const { probe, calls } = trackedProbe(true);
    const result = resolvePythonCommand({} as NodeJS.ProcessEnv, probe, 'win32');
    assert.equal(result, 'python');
    assert.equal(calls.length, 0, 'win32 branch should never probe');
  });

  it('POSIX (no $PYTHON): probe succeeds for python3 → resolves to "python3"', () => {
    const { probe } = trackedProbe(true);
    const result = resolvePythonCommand({} as NodeJS.ProcessEnv, probe, 'linux');
    assert.equal(result, 'python3');
  });

  it('POSIX (no $PYTHON): probe fails for python3 → falls back to "python"', () => {
    const { probe } = trackedProbe(false);
    const result = resolvePythonCommand({} as NodeJS.ProcessEnv, probe, 'darwin');
    assert.equal(result, 'python');
  });

  it('POSIX probe result is memoized — only probed once across two calls', () => {
    const { probe, calls } = trackedProbe(true);
    const first = resolvePythonCommand({} as NodeJS.ProcessEnv, probe, 'linux');
    const second = resolvePythonCommand({} as NodeJS.ProcessEnv, probe, 'linux');
    assert.equal(first, 'python3');
    assert.equal(second, 'python3');
    assert.equal(calls.length, 1, 'probe should only run once — result is memoized');
  });

  it('_resetPythonCacheForTest() clears the memoized result, forcing a re-probe', () => {
    const first = trackedProbe(true);
    resolvePythonCommand({} as NodeJS.ProcessEnv, first.probe, 'linux');
    assert.equal(first.calls.length, 1);

    _resetPythonCacheForTest();

    const second = trackedProbe(false);
    const result = resolvePythonCommand({} as NodeJS.ProcessEnv, second.probe, 'linux');
    assert.equal(second.calls.length, 1, 'reset should force a fresh probe');
    assert.equal(result, 'python');
  });

  it('$PYTHON override does not populate or consult the POSIX cache', () => {
    const envProbe = trackedProbe(true);
    resolvePythonCommand({ PYTHON: 'custom-python' } as NodeJS.ProcessEnv, envProbe.probe, 'linux');
    assert.equal(envProbe.calls.length, 0);

    // A subsequent PYTHON-less call on the same platform must still probe fresh —
    // proving the env-override path never warmed the memoized cache.
    const posixProbe = trackedProbe(false);
    const result = resolvePythonCommand({} as NodeJS.ProcessEnv, posixProbe.probe, 'linux');
    assert.equal(posixProbe.calls.length, 1);
    assert.equal(result, 'python');
  });

  it('end-to-end with real defaults resolves without throwing (host-platform dependent, no mocks)', () => {
    const result = resolvePythonCommand();
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });
});
