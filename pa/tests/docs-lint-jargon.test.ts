import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  jargonFindings,
  jargonFindingMessage,
  JARGON_LEXICON,
} from '../src/lib/docs-lint.js';

// WP-C5 (AI-264, Wave C): the jargon-blocklist arm's unit suite. The arm
// lives once in src/lib/docs-lint.ts (the file header's one-implementation
// mandate covers every arm); this suite pins the fence scoping, the lexicon
// contract and the J1 message shape the CLI prints verbatim.

describe('docs-lint jargon arm', () => {
  it('exports the spec WP-C5 lexicon', () => {
    assert.ok(JARGON_LEXICON.includes('MCP'));
    assert.ok(JARGON_LEXICON.includes('API key'));
    assert.ok(JARGON_LEXICON.includes('scheduler'));
    assert.ok(JARGON_LEXICON.includes('claude'));
  });

  it('flags every lexicon hit inside a user-facing fence with rule tag J1', () => {
    const content = [
      '# Guide',
      '',
      '<!-- user-facing -->',
      'Run the setup in a terminal.',
      'Clone the repo and build the project.',
      '<!-- /user-facing -->',
      '',
    ].join('\n');
    const findings = jargonFindings('scratch/jargon-fixture.md', content);
    assert.equal(findings.length, 3, JSON.stringify(findings));
    assert.ok(findings.every((f) => f.message.startsWith('J1:')));
    const terms = new Set(findings.map((f) => f.term));
    assert.ok(terms.has('clone'));
    assert.ok(terms.has('repo'));
    assert.ok(terms.has('build'));
  });

  it('is exempt outside user-facing fences (agent-facing sections yield nothing)', () => {
    const content = [
      'Agent-facing: config, env, path, MCP, hook, YAML.',
      '',
      '<!-- user-facing -->',
      'Plain words only here.',
      '<!-- /user-facing -->',
      'More agent-facing prose about the scheduler.',
    ].join('\n');
    assert.deepEqual(jargonFindings('x.md', content), []);
  });

  it('matches lexicon terms case-insensitively', () => {
    const content = [
      '<!-- user-facing -->',
      'Claude wrote Config into a Path.',
      '<!-- /user-facing -->',
    ].join('\n');
    const findings = jargonFindings('x.md', content);
    const terms = findings.map((f) => f.term).sort();
    assert.deepEqual(terms, ['claude', 'config', 'path']);
  });

  it('does not match lexicon substrings inside larger words', () => {
    const content = [
      '<!-- user-facing -->',
      'The configuration was rebuilt around a repository of gitignore entries.',
      'A tokenless approach deploys fine.',
      '<!-- /user-facing -->',
    ].join('\n');
    assert.deepEqual(jargonFindings('x.md', content), []);
  });

  it('an unclosed fence runs to end-of-file (never silently drops findings)', () => {
    const content = [
      '<!-- user-facing -->',
      'Clone the repo.',
    ].join('\n');
    const findings = jargonFindings('x.md', content);
    assert.ok(findings.length > 0);
  });

  it('builds the J1 message via jargonFindingMessage', () => {
    const msg = jargonFindingMessage({ file: 'x.md', line: 7, term: 'MCP' });
    assert.equal(
      msg,
      'J1: x.md:7: user-facing jargon "MCP" — rewrite in plain language (docs/CONVENTIONS.md § "Jargon gate")'
    );
  });
});
