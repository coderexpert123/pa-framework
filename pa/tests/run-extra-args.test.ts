import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerExtraArgs } from '../src/commands/run.js';
import type { Skill } from '../src/types.js';

// AI-187 follow-up (2026-09-10): `pa run <llm-skill> -- <extraArgs>` bridges
// extraArgs into the prompt (buildOperatorArgsBlock) for LLM-worker skills,
// but the worker-argv builder ALSO appended extraArgs unconditionally — riding
// both. agy exits 2 on any positional argument, so every `pa run commit --
// <files>` run was excluded from that worker (live failure, 2026-09-10:
// worker-exec spawn-failed, exitCode 2, "unexpected argument
// \"projects/voice-inbox/src/contracts.ts\""), and with the rest of the
// failover chain cooling down the skill died with "No workers available".
// This test proves buildWorkerExtraArgs no longer lets extraArgs ride the
// worker argv for LLM-worker skills, while worker_args (real worker CLI
// flags, declared per-skill) still do — and that cmd skills are unaffected.

function makeSkill(frontmatter: Skill['frontmatter']): Skill {
  return {
    name: 'test-skill',
    path: '/tmp/test-skill.md',
    frontmatter,
    prompt: 'test prompt',
  };
}

describe('buildWorkerExtraArgs', () => {
  it('drops bridged extraArgs from the worker argv for an LLM-worker skill, keeping worker_args', () => {
    const skill = makeSkill({ worker_args: ['--include-directories', '/some/dir'] });
    const result = buildWorkerExtraArgs(skill, ['projects/voice-inbox/src/contracts.ts', 'pa/src/commands/run.ts']);

    assert.deepEqual(result, ['--include-directories', '/some/dir']);
    assert.ok(!result.includes('projects/voice-inbox/src/contracts.ts'), 'extraArgs must not ride the worker argv');
    assert.ok(!result.includes('pa/src/commands/run.ts'), 'extraArgs must not ride the worker argv');
  });

  it('returns only worker_args (empty array) for an LLM-worker skill with no worker_args declared', () => {
    const skill = makeSkill({});
    const result = buildWorkerExtraArgs(skill, ['some-file.ts']);

    assert.deepEqual(result, []);
  });

  it('keeps extraArgs appended after worker_args for a cmd skill (unchanged behaviour)', () => {
    const skill = makeSkill({ cmd: 'echo hi', worker_args: ['--flag'] });
    const result = buildWorkerExtraArgs(skill, ['arg1', 'arg2']);

    assert.deepEqual(result, ['--flag', 'arg1', 'arg2']);
  });
});
