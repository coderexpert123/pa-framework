import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempConfig, cleanup } from './helpers.js';
import { loadConfig, DEFAULT_TRANSCRIPTION_CONFIG, resolveTranscriptionConfig } from '../src/config.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

const oneWorker = [{ name: 'w1', command: 'echo', args: ['x'], check: 'echo ok' }];

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  return { warnings, restore: () => { console.warn = original; } };
}

describe('transcription config', () => {
  it('1. no transcription block loads fine and yields transcription === undefined', async () => {
    await createTempConfig(tempDir, oneWorker);
    const config = await loadConfig();
    assert.equal(config.transcription, undefined);
  });

  it('2. resolveTranscriptionConfig(undefined) returns exactly DEFAULT_TRANSCRIPTION_CONFIG', () => {
    const resolved = resolveTranscriptionConfig(undefined);
    assert.deepEqual(resolved, DEFAULT_TRANSCRIPTION_CONFIG);
    assert.deepEqual(resolved, {
      engine_preference: 'auto',
      worker_mode: 'spawn',
      cloud_order: ['groq', 'openai', 'deepgram'],
      language: null,
    });
  });

  it('3. a full valid block round-trips every field', async () => {
    await createTempConfig(tempDir, oneWorker, {
      transcription: {
        engine_preference: 'cloud',
        worker_mode: 'persistent',
        cloud_order: ['deepgram', 'groq'],
        language: 'en-US',
      },
    });
    const config = await loadConfig();
    assert.deepEqual(config.transcription, {
      engine_preference: 'cloud',
      worker_mode: 'persistent',
      cloud_order: ['deepgram', 'groq'],
      language: 'en-US',
    });
  });

  it('4. a partial block (worker_mode only) resolves the rest to defaults', async () => {
    await createTempConfig(tempDir, oneWorker, {
      transcription: { worker_mode: 'persistent' },
    });
    const config = await loadConfig();
    assert.deepEqual(config.transcription, {
      engine_preference: 'auto',
      worker_mode: 'persistent',
      cloud_order: ['groq', 'openai', 'deepgram'],
      language: null,
    });
  });

  it('5. engine_preference "CLOUD" normalises to cloud; "banana" warns and defaults, loadConfig still resolves', async () => {
    await createTempConfig(tempDir, oneWorker, {
      transcription: { engine_preference: 'CLOUD' },
    });
    const config1 = await loadConfig();
    assert.equal(config1.transcription?.engine_preference, 'cloud');

    const cap = captureWarnings();
    try {
      await createTempConfig(tempDir, oneWorker, {
        transcription: { engine_preference: 'banana' },
      });
      const config2 = await loadConfig();
      assert.equal(config2.transcription?.engine_preference, 'auto');
      assert.ok(cap.warnings.some((w) => w.includes('engine_preference')));
    } finally {
      cap.restore();
    }
  });

  it('6. worker_mode "persistant" (typo) warns and yields spawn', async () => {
    const cap = captureWarnings();
    try {
      await createTempConfig(tempDir, oneWorker, {
        transcription: { worker_mode: 'persistant' },
      });
      const config = await loadConfig();
      assert.equal(config.transcription?.worker_mode, 'spawn');
      assert.ok(cap.warnings.some((w) => w.includes('worker_mode')));
    } finally {
      cap.restore();
    }
  });

  it('7. cloud_order "groq" (scalar) is coerced to [\'groq\']', async () => {
    await createTempConfig(tempDir, oneWorker, {
      transcription: { cloud_order: 'groq' },
    });
    const config = await loadConfig();
    assert.deepEqual(config.transcription?.cloud_order, ['groq']);
  });

  it('8. cloud_order [groq, banana, GROQ] -> [\'groq\'], warns naming banana, drops duplicate', async () => {
    const cap = captureWarnings();
    try {
      await createTempConfig(tempDir, oneWorker, {
        transcription: { cloud_order: ['groq', 'banana', 'GROQ'] },
      });
      const config = await loadConfig();
      assert.deepEqual(config.transcription?.cloud_order, ['groq']);
      assert.ok(cap.warnings.some((w) => w.includes('banana')));
    } finally {
      cap.restore();
    }
  });

  it('9. cloud_order [] and cloud_order [banana] both fall back to the default list', async () => {
    await createTempConfig(tempDir, oneWorker, {
      transcription: { cloud_order: [] },
    });
    const config1 = await loadConfig();
    assert.deepEqual(config1.transcription?.cloud_order, ['groq', 'openai', 'deepgram']);

    await createTempConfig(tempDir, oneWorker, {
      transcription: { cloud_order: ['banana'] },
    });
    const config2 = await loadConfig();
    assert.deepEqual(config2.transcription?.cloud_order, ['groq', 'openai', 'deepgram']);
  });

  it('10. transcription: "yes" (scalar block) warns and yields undefined; rest of config still parses', async () => {
    const cap = captureWarnings();
    try {
      await createTempConfig(tempDir, oneWorker, {
        transcription: 'yes',
      });
      const config = await loadConfig();
      assert.equal(config.transcription, undefined);
      assert.ok(config.workers.length > 0);
      assert.ok(cap.warnings.some((w) => w.includes('transcription')));
    } finally {
      cap.restore();
    }
  });
});

describe('transcription config — language', () => {
  it('11. no language set resolves to null', async () => {
    await createTempConfig(tempDir, oneWorker, {
      transcription: { engine_preference: 'cloud' },
    });
    const config = await loadConfig();
    assert.equal(config.transcription?.language, null);
  });

  it('12. a bare two-letter language ("en") round-trips', async () => {
    await createTempConfig(tempDir, oneWorker, {
      transcription: { language: 'en' },
    });
    const config = await loadConfig();
    assert.equal(config.transcription?.language, 'en');
  });

  it('13. a region-qualified language ("hi-IN") round-trips', async () => {
    await createTempConfig(tempDir, oneWorker, {
      transcription: { language: 'hi-IN' },
    });
    const config = await loadConfig();
    assert.equal(config.transcription?.language, 'hi-IN');
  });

  it('14. a malformed language ("english") warns and falls back to null', async () => {
    const cap = captureWarnings();
    try {
      await createTempConfig(tempDir, oneWorker, {
        transcription: { language: 'english' },
      });
      const config = await loadConfig();
      assert.equal(config.transcription?.language, null);
      assert.ok(cap.warnings.some((w) => w.includes('transcription.language')));
    } finally {
      cap.restore();
    }
  });

  it('15. an all-whitespace language is treated as unset (null), no warning', async () => {
    const cap = captureWarnings();
    try {
      await createTempConfig(tempDir, oneWorker, {
        transcription: { language: '   ' },
      });
      const config = await loadConfig();
      assert.equal(config.transcription?.language, null);
      assert.ok(!cap.warnings.some((w) => w.includes('transcription.language')));
    } finally {
      cap.restore();
    }
  });

  it('16. non-English language + engine_preference "local" warns about the English-only local model', async () => {
    const cap = captureWarnings();
    try {
      await createTempConfig(tempDir, oneWorker, {
        transcription: { language: 'fr', engine_preference: 'local' },
      });
      const config = await loadConfig();
      assert.equal(config.transcription?.language, 'fr');
      assert.ok(cap.warnings.some((w) => w.includes('English-only')));
    } finally {
      cap.restore();
    }
  });

  it('17. non-English language + engine_preference "auto" (default) does NOT warn about the local model', async () => {
    const cap = captureWarnings();
    try {
      await createTempConfig(tempDir, oneWorker, {
        transcription: { language: 'fr' },
      });
      const config = await loadConfig();
      assert.equal(config.transcription?.language, 'fr');
      assert.ok(!cap.warnings.some((w) => w.includes('English-only')));
    } finally {
      cap.restore();
    }
  });

  it('18. English language + engine_preference "local" does NOT warn', async () => {
    const cap = captureWarnings();
    try {
      await createTempConfig(tempDir, oneWorker, {
        transcription: { language: 'en-GB', engine_preference: 'local' },
      });
      const config = await loadConfig();
      assert.equal(config.transcription?.language, 'en-GB');
      assert.ok(!cap.warnings.some((w) => w.includes('English-only')));
    } finally {
      cap.restore();
    }
  });
});
