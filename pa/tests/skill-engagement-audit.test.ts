import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { runSkillEngagementAudit, skillEngagementAuditJob } from '../src/lib/maintenance/jobs/skill-engagement-audit.js';
import { decisionStatsBySkill } from '../src/lib/decisions.js';
import type { Skill, RunMeta } from '../src/types.js';

describe('skill-engagement-audit job (WP-B, AI-168)', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(tempHome);
    await rm(tempHome, { force: true, recursive: true }).catch(() => {});
  });

  describe('stale rule matrix', () => {
    it('marks never-run manual skill as stale (null lastSuccessAt, 0 decision rows)', async () => {
      const now = Date.now();
      const mockSkills: Skill[] = [{ name: 'clnwu', path: '/fake/skill.md', frontmatter: {}, prompt: 'test' }];
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun() { return null; },
        decisionStats() { return new Map([['clnwu', { skill: 'clnwu', total: 0, approved: 0, rejected: 0, replied: 0, pending: 0, other_reaction: 0 }]]); },
        readCensusFile() { return '{}'; },
        async writeFile() {},
      };

      const result = await runSkillEngagementAudit(ctx);
      assert.equal(result.touched, 1);
      assert.equal(result.detail.staleCount, 1);
      assert.equal(result.detail.totalSkills, 1);
    });

    it('marks skill stale when last success 91d ago and 0 decision rows', async () => {
      const now = Date.now();
      const ninetyOneDaysAgo = now - 91 * 24 * 60 * 60 * 1000;
      const mockSkills: Skill[] = [{ name: 'stale-skill', path: '/fake/skill.md', frontmatter: { cron: '0 0 * * *' }, prompt: 'test' }];
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun(): Promise<RunMeta> { return { worker: 'agy', status: 'success', exitCode: 0, duration: 1000, timestamp: new Date(ninetyOneDaysAgo).toISOString() }; },
        decisionStats() { return new Map([['stale-skill', { skill: 'stale-skill', total: 0, approved: 0, rejected: 0, replied: 0, pending: 0, other_reaction: 0 }]]); },
        readCensusFile() { return '{}'; },
        async writeFile() {},
      };

      const result = await runSkillEngagementAudit(ctx);
      assert.equal(result.touched, 1);
      assert.equal(result.detail.staleCount, 1);
    });

    it('does NOT mark skill stale when last success 89d ago (under threshold)', async () => {
      const now = Date.now();
      const eightyNineDaysAgo = now - 89 * 24 * 60 * 60 * 1000;
      const mockSkills: Skill[] = [{ name: 'recent-skill', path: '/fake/skill.md', frontmatter: { cron: '0 0 * * *' }, prompt: 'test' }];
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun(): Promise<RunMeta> { return { worker: 'agy', status: 'success', exitCode: 0, duration: 1000, timestamp: new Date(eightyNineDaysAgo).toISOString() }; },
        decisionStats() { return new Map([['recent-skill', { skill: 'recent-skill', total: 0, approved: 0, rejected: 0, replied: 0, pending: 0, other_reaction: 0 }]]); },
        readCensusFile() { return '{}'; },
        async writeFile() {},
      };

      const result = await runSkillEngagementAudit(ctx);
      assert.equal(result.touched, 0);
      assert.equal(result.detail.staleCount, 0);
    });

    it('does NOT mark skill stale when last success 91d ago BUT has 2 decision rows', async () => {
      const now = Date.now();
      const ninetyOneDaysAgo = now - 91 * 24 * 60 * 60 * 1000;
      const mockSkills: Skill[] = [{ name: 'engaged-skill', path: '/fake/skill.md', frontmatter: { cron: '0 0 * * *' }, prompt: 'test' }];
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun(): Promise<RunMeta> { return { worker: 'agy', status: 'success', exitCode: 0, duration: 1000, timestamp: new Date(ninetyOneDaysAgo).toISOString() }; },
        decisionStats() { return new Map([['engaged-skill', { skill: 'engaged-skill', total: 2, approved: 1, rejected: 0, replied: 1, pending: 0, other_reaction: 0 }]]); },
        readCensusFile() { return '{}'; },
        async writeFile() {},
      };

      const result = await runSkillEngagementAudit(ctx);
      assert.equal(result.touched, 0);
      assert.equal(result.detail.staleCount, 0);
    });

    it('does NOT mark scheduled skill stale when it has recent success', async () => {
      const now = Date.now();
      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const mockSkills: Skill[] = [{ name: 'active-skill', path: '/fake/skill.md', frontmatter: { cron: '0 0 * * *' }, prompt: 'test' }];
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun(): Promise<RunMeta> { return { worker: 'agy', status: 'success', exitCode: 0, duration: 1000, timestamp: new Date(oneDayAgo).toISOString() }; },
        decisionStats() { return new Map([['active-skill', { skill: 'active-skill', total: 0, approved: 0, rejected: 0, replied: 0, pending: 0, other_reaction: 0 }]]); },
        readCensusFile() { return '{}'; },
        async writeFile() {},
      };

      const result = await runSkillEngagementAudit(ctx);
      assert.equal(result.touched, 0);
      assert.equal(result.detail.staleCount, 0);
    });
  });

  describe('decisions-DB handling', () => {
    it('when DB absent, decisionRows90d is 0 everywhere and never-run skill is still stale', async () => {
      const now = Date.now();
      const mockSkills: Skill[] = [{ name: 'never-run', path: '/fake/skill.md', frontmatter: {}, prompt: 'test' }];
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun() { return null; },
        decisionStats() { return null; }, // DB absent
        readCensusFile() { return '{}'; },
        async writeFile() {},
      };

      const result = await runSkillEngagementAudit(ctx);
      assert.equal(result.touched, 1);
      assert.equal(result.detail.staleCount, 1);
    });
  });

  describe('census join', () => {
    it('joins alert-census.json for alertSent7d annotation', async () => {
      const now = Date.now();
      const mockSkills: Skill[] = [
        { name: 'synthetic-a', path: '/fake/a.md', frontmatter: {}, prompt: 'test' },
        { name: 'synthetic-b', path: '/fake/b.md', frontmatter: {}, prompt: 'test' },
      ];
      const censusData = {
        families: [
          { ownerKind: 'skill', owner: 'synthetic-a', sent: 7 },
          { ownerKind: 'maintenance-job', owner: 'some-job', sent: 3 },
        ],
      };
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun() { return null; },
        decisionStats() { return new Map(); },
        readCensusFile() { return JSON.stringify(censusData); },
        async writeFile(path: string, data: string) {
          const output = JSON.parse(data);
          assert.equal(output.stale[0].alertSent7d, 7);
          assert.equal(output.stale[1].alertSent7d, 0);
        },
      };

      await runSkillEngagementAudit(ctx);
    });

    it('absent census yields alertSent7d = 0 for all skills', async () => {
      const now = Date.now();
      const mockSkills: Skill[] = [{ name: 'no-census-skill', path: '/fake/skill.md', frontmatter: {}, prompt: 'test' }];
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun() { return null; },
        decisionStats() { return new Map(); },
        readCensusFile() { return '{}'; },
        async writeFile(path: string, data: string) {
          const output = JSON.parse(data);
          assert.equal(output.stale[0].alertSent7d, 0);
        },
      };

      await runSkillEngagementAudit(ctx);
    });
  });

  describe('output file shape', () => {
    it('matches §2.3 exactly with all required keys', async () => {
      const now = Date.now();
      const mockSkills: Skill[] = [{ name: 'test-skill', path: '/fake/skill.md', frontmatter: {}, prompt: 'test' }];
      let writtenData: string = '';
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun() { return null; },
        decisionStats() { return new Map(); },
        readCensusFile() { return '{}'; },
        async writeFile(path: string, data: string) {
          writtenData = data;
        },
      };

      await runSkillEngagementAudit(ctx);
      const output = JSON.parse(writtenData);

      assert.ok(output.generatedAt);
      assert.match(output.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/);
      assert.equal(output.windowDays, 90);
      assert.equal(output.totalSkills, 1);
      assert.equal(output.staleCount, 1);
      assert.ok(Array.isArray(output.stale));
      assert.equal(output.stale.length, 1);
    });

    it('stale list is sorted by skill name asc', async () => {
      const now = Date.now();
      const mockSkills: Skill[] = [
        { name: 'zebra', path: '/fake/z.md', frontmatter: {}, prompt: 'test' },
        { name: 'alpha', path: '/fake/a.md', frontmatter: {}, prompt: 'test' },
        { name: 'middle', path: '/fake/m.md', frontmatter: {}, prompt: 'test' },
      ];
      let writtenData: string = '';
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun() { return null; },
        decisionStats() { return new Map(); },
        readCensusFile() { return '{}'; },
        async writeFile(path: string, data: string) {
          writtenData = data;
        },
      };

      await runSkillEngagementAudit(ctx);
      const output = JSON.parse(writtenData);

      assert.equal(output.stale[0].skill, 'alpha');
      assert.equal(output.stale[1].skill, 'middle');
      assert.equal(output.stale[2].skill, 'zebra');
    });

    it('touched === staleCount', async () => {
      const now = Date.now();
      const mockSkills: Skill[] = [
        { name: 'stale-1', path: '/fake/s1.md', frontmatter: {}, prompt: 'test' },
        { name: 'stale-2', path: '/fake/s2.md', frontmatter: {}, prompt: 'test' },
      ];
      const ctx = {
        now,
        async listSkills() { return mockSkills; },
        async getLastSuccessfulRun() { return null; },
        decisionStats() { return new Map(); },
        readCensusFile() { return '{}'; },
        async writeFile() {},
      };

      const result = await runSkillEngagementAudit(ctx);
      assert.equal(result.touched, result.detail.staleCount);
      assert.equal(result.touched, 2);
    });
  });

  describe('registry object', () => {
    it('has correct name regex, destructive false, targets empty', () => {
      assert.equal(skillEngagementAuditJob.name, 'skill-engagement-audit');
      assert.match(skillEngagementAuditJob.name, /^[a-z-]+$/);
      assert.equal(skillEngagementAuditJob.destructive, false);
      assert.deepEqual(skillEngagementAuditJob.targets, []);
      assert.equal(skillEngagementAuditJob.host, 'pa');
      assert.equal(skillEngagementAuditJob.shedWhenDegraded, true);
      assert.equal(skillEngagementAuditJob.everyMs, 30 * 24 * 60 * 60 * 1000);
    });
  });
});
