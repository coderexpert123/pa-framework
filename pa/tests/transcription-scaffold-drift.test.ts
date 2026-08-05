import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { initCommand } from '../src/commands/init.js';
import { configPath } from '../src/paths.js';
import { parseTranscription, DEFAULT_TRANSCRIPTION_CONFIG } from '../src/config.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

// Compiled to pa/dist/tests/transcription-scaffold-drift.test.js — __dirname
// is that file's dir; 3 levels up (dist/tests -> dist -> pa -> repo root)
// reaches examples/ (same convention as init-defaults.test.ts:47).
const EXAMPLE_CONFIG_PATH = join(__dirname, '..', '..', '..', 'examples', 'config.yaml.example');
const EXAMPLE_SECRETS_PATH = join(__dirname, '..', '..', '..', 'examples', 'secrets.env.example');

// examples/secrets.env.example is gitignored in the PRIVATE repo (public-mirror-only
// path, per CLAUDE.md), so a fresh CI checkout of the private repo never has it, even
// though it's present on every real dev machine (reproduced identically on all 3 CI
// platforms the first time these tests ran, 2026-08-04 -- not a flake). Only the tests
// below that read this specific file need the guard; config.yaml.example IS tracked in
// the private repo and its own tests run normally everywhere.
const SECRETS_EXAMPLE_MISSING_REASON =
  'examples/secrets.env.example is not present in this checkout (gitignored in the private repo)';

/** Extract the commented `# transcription:` sub-block from a config scaffold's
 *  text, starting at the anchor line and running to the end of the file (both
 *  scaffolds place this block last). Returns the raw lines, still `#`-prefixed. */
function extractTranscriptionCommentLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === '# transcription:');
  assert.ok(startIdx >= 0, 'could not find "# transcription:" anchor line');
  const block: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith('#')) {
      block.push(line);
    } else {
      break;
    }
  }
  return block;
}

/** Strip one leading '#' (and one following space, if present) from every
 *  commented line, turning the documentation block back into live YAML. */
function uncomment(lines: string[]): string {
  return lines.map((l) => l.replace(/^#\s?/, '')).join('\n');
}

describe('transcription scaffold — presence', () => {
  it('both examples/config.yaml.example and init.ts scaffolded output contain a transcription: block', async () => {
    await initCommand();
    const initText = await readFile(configPath(), 'utf8');
    const exampleText = await readFile(EXAMPLE_CONFIG_PATH, 'utf8');
    assert.ok(initText.includes('# transcription:'), 'init.ts DEFAULT_CONFIG is missing the commented transcription: block');
    assert.ok(exampleText.includes('# transcription:'), 'examples/config.yaml.example is missing the commented transcription: block');
  });
});

describe('transcription scaffold — the two scaffolds agree', () => {
  it('comment bodies are equal after normalising whitespace', async () => {
    await initCommand();
    const initText = await readFile(configPath(), 'utf8');
    const exampleText = await readFile(EXAMPLE_CONFIG_PATH, 'utf8');

    const initBlock = extractTranscriptionCommentLines(initText).join('\n').trim().replace(/\s+/g, ' ');
    const exampleBlock = extractTranscriptionCommentLines(exampleText).join('\n').trim().replace(/\s+/g, ' ');

    assert.equal(
      initBlock,
      exampleBlock,
      'init.ts DEFAULT_CONFIG and examples/config.yaml.example transcription: blocks have drifted apart'
    );
  });
});

describe('transcription scaffold — knob and enum coverage', () => {
  it('every knob name and enum value from D2 is present in the documented block', async () => {
    await initCommand();
    const initText = await readFile(configPath(), 'utf8');
    const block = extractTranscriptionCommentLines(initText).join('\n');

    const required = [
      'engine_preference',
      'worker_mode',
      'cloud_order',
      'language',
      'auto',
      'cloud',
      'local',
      'spawn',
      'persistent',
      'groq',
      'openai',
      'deepgram',
    ];
    for (const name of required) {
      assert.ok(block.includes(name), `transcription: scaffold block is missing '${name}'`);
    }
  });
});

describe('transcription scaffold — secrets.env.example', () => {
  it('documents every cloud API key and every PA_VOICE_* env var from D8, each commented out', async (t) => {
    if (!existsSync(EXAMPLE_SECRETS_PATH)) return t.skip(SECRETS_EXAMPLE_MISSING_REASON);
    const text = await readFile(EXAMPLE_SECRETS_PATH, 'utf8');
    const names = [
      'GROQ_API_KEY',
      'OPENAI_API_KEY',
      'DEEPGRAM_API_KEY',
      'PA_VOICE_TRANSCRIBE_TIMEOUT_MS',
      'PA_VOICE_MAX_DURATION_S',
      'PA_VOICE_MAX_FILE_BYTES',
      'PA_VOICE_TRANSCRIBE_SCRIPT',
      'PA_VOICE_WORKER_SCRIPT',
      'PA_VOICE_WORKER_IDLE_MS',
      'PA_VOICE_WORKER_START_TIMEOUT_MS',
      'PA_VOICE_WORKER_PING_TIMEOUT_MS',
    ];
    const lines = text.split(/\r?\n/);
    for (const name of names) {
      const line = lines.find((l) => l.includes(name) && l.trim().startsWith(`# ${name}=`));
      assert.ok(
        line,
        `examples/secrets.env.example is missing a commented '# ${name}=' line — either absent, or uncommented (which would inject an empty value into every worker's environment)`
      );
    }
  });

  it('does not accidentally uncomment PA_VOICE_MAX_TRANSCRIPT_CHARS (removed — hard-coded Python constant, not an env var)', async (t) => {
    if (!existsSync(EXAMPLE_SECRETS_PATH)) return t.skip(SECRETS_EXAMPLE_MISSING_REASON);
    const text = await readFile(EXAMPLE_SECRETS_PATH, 'utf8');
    assert.ok(
      !text.includes('PA_VOICE_MAX_TRANSCRIPT_CHARS'),
      'PA_VOICE_MAX_TRANSCRIPT_CHARS was removed from D8 and replaced with a hard-coded Python constant; it must not appear in the scaffold'
    );
  });
});

describe('transcription scaffold — documentation is executable, not aspirational', () => {
  it('uncommenting the config example block and parsing it yields the values parseTranscription resolves to', async () => {
    const exampleText = await readFile(EXAMPLE_CONFIG_PATH, 'utf8');
    const commentLines = extractTranscriptionCommentLines(exampleText);
    const yamlText = uncomment(commentLines);

    const parsed = parseYaml(yamlText);
    assert.ok(parsed && typeof parsed === 'object' && 'transcription' in parsed, 'uncommented block did not parse to a { transcription: ... } document');

    const resolved = parseTranscription(parsed.transcription);
    assert.deepEqual(
      resolved,
      DEFAULT_TRANSCRIPTION_CONFIG,
      'the documented scaffold values no longer match what parseTranscription resolves them to — the comment is aspirational, not executable'
    );
  });
});

describe('transcription scaffold — first-run adequacy (D10)', () => {
  it('both example files name the Groq key URL and cross-reference docs/', async (t) => {
    if (!existsSync(EXAMPLE_SECRETS_PATH)) return t.skip(SECRETS_EXAMPLE_MISSING_REASON);
    const configText = await readFile(EXAMPLE_CONFIG_PATH, 'utf8');
    const secretsText = await readFile(EXAMPLE_SECRETS_PATH, 'utf8');
    for (const [label, text] of [['config.yaml.example', configText], ['secrets.env.example', secretsText]] as const) {
      assert.ok(text.includes('console.groq.com/keys'), `${label} does not mention console.groq.com/keys`);
      assert.ok(text.includes('docs/'), `${label} does not cross-reference a docs/ file`);
    }
  });

  it('both example files mention "minutes" when describing the local path (honesty constraint)', async (t) => {
    if (!existsSync(EXAMPLE_SECRETS_PATH)) return t.skip(SECRETS_EXAMPLE_MISSING_REASON);
    const configText = await readFile(EXAMPLE_CONFIG_PATH, 'utf8');
    const secretsText = await readFile(EXAMPLE_SECRETS_PATH, 'utf8');
    assert.ok(/minutes/i.test(configText), 'config.yaml.example does not mention minutes-per-note for the local path');
    assert.ok(/minutes/i.test(secretsText), 'secrets.env.example does not mention minutes-per-note for the local path');
  });

  it('the fast path leads: the cloud (Groq) mention precedes the local/offline-setup mention in each file', async (t) => {
    if (!existsSync(EXAMPLE_SECRETS_PATH)) return t.skip(SECRETS_EXAMPLE_MISSING_REASON);
    // Neither scaffold's verbatim text (fixed by WP4) contains the literal
    // strings "pip install" or "GROQ_API_KEY" ahead of the other term in both
    // files simultaneously — config.yaml.example spells out "engine_preference:
    // local" while secrets.env.example says "local Whisper" instead, and the
    // env-var identifier GROQ_API_KEY itself only appears in the trailing
    // commented key list, after the human-readable "Groq" provider mention.
    // So the ordering check is anchored on case-insensitive "groq" (covers
    // both the prose mention and the env var name) versus whichever local/
    // offline marker the file actually uses.
    const LOCAL_MARKERS = ['pip install', 'engine_preference: local', 'local whisper'];
    const firstIndexOfAny = (text: string, needles: string[]): number => {
      const lower = text.toLowerCase();
      const idxs = needles.map((n) => lower.indexOf(n.toLowerCase())).filter((i) => i >= 0);
      return idxs.length > 0 ? Math.min(...idxs) : -1;
    };

    for (const [label, text] of [
      ['config.yaml.example', await readFile(EXAMPLE_CONFIG_PATH, 'utf8')],
      ['secrets.env.example', await readFile(EXAMPLE_SECRETS_PATH, 'utf8')],
    ] as const) {
      const groqIdx = text.toLowerCase().indexOf('groq');
      const localIdx = firstIndexOfAny(text, LOCAL_MARKERS);
      assert.ok(groqIdx >= 0, `${label} never mentions Groq`);
      assert.ok(localIdx >= 0, `${label} never mentions the local/offline path`);
      assert.ok(groqIdx < localIdx, `${label} leads with the local/offline path instead of the cloud (Groq) option`);
    }
  });
});
