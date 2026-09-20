import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseVoiceInboxTypedRouting,
  readVoiceInboxRoutingFileConfig,
  resolveVoiceInboxDefaultTopic,
} from '../src/lib/voice-inbox-routing-config.js';

function withTempConfig(yaml: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pa-voice-routing-config-'));
  try {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, yaml, 'utf8');
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RC2_DEFAULTS = { actConfidence: 0.9, continueConfidence: 0.9, noMatch: 'create-topic', escalation: 'llm-turn' };

describe('readVoiceInboxRoutingFileConfig — typed routing block', () => {
  it('an absent or disabled voice_inbox_routing block yields no typed routing', () => {
    withTempConfig('voice_inbox:\n  inbox_topic: "-1_1"\n', (path) => {
      const cfg = readVoiceInboxRoutingFileConfig(path);
      assert.equal(cfg.typedRouting, undefined);
      assert.equal('typedRouting' in cfg, false);
    });
    withTempConfig('voice_inbox_routing:\n  enabled: false\n', (path) => {
      const cfg = readVoiceInboxRoutingFileConfig(path);
      assert.equal(cfg.typedRouting, undefined);
      assert.equal('typedRouting' in cfg, false);
    });
    withTempConfig('voice_inbox_routing:\n  enabled: "true"\n', (path) => {
      const cfg = readVoiceInboxRoutingFileConfig(path);
      assert.equal(cfg.typedRouting, undefined);
      assert.equal('typedRouting' in cfg, false);
    });
  });

  it('an enabled block defaults to 0.9, 0.9, create-topic and llm-turn', () => {
    assert.deepEqual(parseVoiceInboxTypedRouting({ enabled: true }), RC2_DEFAULTS);
    assert.deepEqual(
      parseVoiceInboxTypedRouting({
        enabled: true,
        act_confidence: 0.8,
        continue_confidence: 0.95,
        no_match: 'escalate',
        escalation: 'place',
      }),
      { actConfidence: 0.8, continueConfidence: 0.95, noMatch: 'escalate', escalation: 'place' }
    );
  });

  it('out-of-range thresholds and unknown enums fall back to the defaults', () => {
    assert.deepEqual(
      parseVoiceInboxTypedRouting({
        enabled: true,
        act_confidence: 1.5,
        continue_confidence: -1,
        no_match: 'weird',
        escalation: 'loud',
      }),
      RC2_DEFAULTS
    );
  });

  it('readVoiceInboxRoutingFileConfig reads inbox_topic, default_topic and lowercased keyword topics', () => {
    withTempConfig(
      'voice_inbox:\n  inbox_topic: "-100123_900"\n  default_topic: " -100123_5 "\nvoice_inbox_fallback:\n  keyword_topics:\n    Invoice: "-100123_5"\n    bad: "nope"\n',
      (path) => {
        assert.deepEqual(readVoiceInboxRoutingFileConfig(path), {
          keywordTopics: { invoice: '-100123_5' },
          inboxTopic: '-100123_900',
          defaultTopic: '-100123_5',
        });
      }
    );
    assert.deepEqual(readVoiceInboxRoutingFileConfig(join(tmpdir(), 'pa-voice-routing-config-missing', 'config.yaml')), {
      keywordTopics: {},
    });
  });
});

describe('resolveVoiceInboxDefaultTopic', () => {
  it('resolveVoiceInboxDefaultTopic prefers env, then config, then the inbox chat thread 0', () => {
    assert.deepEqual(
      resolveVoiceInboxDefaultTopic({ env: { PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC: '-1_2' } as NodeJS.ProcessEnv }),
      { topic: '-1_2', source: 'env' }
    );
    assert.deepEqual(resolveVoiceInboxDefaultTopic({ env: {} as NodeJS.ProcessEnv, configDefault: '-1_3' }), {
      topic: '-1_3',
      source: 'config',
    });
    assert.deepEqual(
      resolveVoiceInboxDefaultTopic({ env: {} as NodeJS.ProcessEnv, inboxTopic: '-100123_900' }),
      { topic: '-100123_0', source: 'inbox-chat' }
    );
    assert.equal(
      resolveVoiceInboxDefaultTopic({ env: { PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC: 'bad' } as NodeJS.ProcessEnv }),
      undefined
    );
  });
});
