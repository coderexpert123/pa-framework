import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSkillRoster } from '../src/lib/skill-roster.js';
import { PROTECTED_SKILLS } from '../src/validator.js';

describe('renderSkillRoster', () => {
  const entry = (name: string, fm?: { trigger_description?: string; description?: string }) => ({
    name,
    frontmatter: fm,
  });

  it('renders `[name] desc` lines, trigger_description preferred over description', () => {
    const out = renderSkillRoster([
      entry('a-skill', { trigger_description: 'when a fires', description: 'generic a' }),
      entry('b-skill', { description: 'generic b' }),
    ]);
    assert.equal(out, '[a-skill] when a fires\n[b-skill] generic b');
  });

  it('excludes PROTECTED_SKILLS by default — a roster containing commit/push-public must omit them', () => {
    const out = renderSkillRoster([
      entry('commit', { trigger_description: 'commit the work' }),
      entry('push-public', { trigger_description: 'publish' }),
      entry('self-improver', { description: 'improves' }),
      entry('normal-skill', { trigger_description: 'ordinary' }),
    ]);
    for (const protectedName of ['commit', 'push-public', 'self-improver']) {
      assert.ok(!out.includes(`[${protectedName}]`), `${protectedName} must never appear in a run_skill roster`);
    }
    assert.ok(out.includes('[normal-skill] ordinary'));
  });

  it('requireTriggerDescription filters skills lacking one', () => {
    const out = renderSkillRoster(
      [
        entry('has-trigger', { trigger_description: 'triggered', description: 'generic' }),
        entry('no-trigger', { description: 'generic only' }),
        entry('bare'),
      ],
      { requireTriggerDescription: true }
    );
    assert.equal(out, '[has-trigger] triggered');
  });

  it('maxLines caps rows and appends the overflow marker', () => {
    const skills = Array.from({ length: 30 }, (_, i) => entry(`s-${i}`, { description: `d${i}` }));
    const out = renderSkillRoster(skills, { maxLines: 3 });
    const lines = out.split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[3], '(+27 more — pa list)');
  });

  it('maxChars cuts mid-roster and counts the dropped tail', () => {
    const skills = Array.from({ length: 10 }, (_, i) => entry(`skill-${i}`, { description: 'x'.repeat(50) }));
    const out = renderSkillRoster(skills, { maxChars: 120 });
    const lines = out.split('\n');
    assert.ok(lines[lines.length - 1].startsWith('(+'), 'overflow marker present');
    assert.ok(out.length <= 200, `roster stays near the cap, got ${out.length}`);
  });

  it('empty input and all-filtered input both return the empty string', () => {
    assert.equal(renderSkillRoster([]), '');
    assert.equal(renderSkillRoster([entry('commit', { trigger_description: 'x' })]), '');
    assert.equal(
      renderSkillRoster([entry('a', { description: 'no trigger' })], { requireTriggerDescription: true }),
      ''
    );
  });

  it('a custom exclude set overrides the default', () => {
    const out = renderSkillRoster(
      [entry('commit', { description: 'kept' }), entry('other', { description: 'dropped' })],
      { exclude: new Set(['other']) }
    );
    assert.ok(out.includes('[commit] kept'), 'custom exclude replaces PROTECTED_SKILLS');
    assert.ok(!out.includes('other'));
  });

  it('PROTECTED_SKILLS is the documented default — assert the set itself stays the known six', () => {
    assert.deepEqual([...PROTECTED_SKILLS].sort(), [
      'commit', 'investigate-flagged', 'push', 'push-public', 'self-improver', 'update-brain',
    ]);
  });
});
