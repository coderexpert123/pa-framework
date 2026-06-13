import { listSkills } from '../skills.js';
import { getLastRun } from '../logger.js';

export async function listCommand(): Promise<void> {
  const skills = await listSkills();

  if (skills.length === 0) {
    console.log('No skills found. Create one at ~/.pa/skills/<name>/skill.md');
    return;
  }

  const nameWidth = Math.max(10, ...skills.map((s) => s.name.length));

  console.log(
    'Skill'.padEnd(nameWidth) + '  ' +
    'Schedule'.padEnd(18) + '  ' +
    'Topic'.padEnd(12) + '  ' +
    'Last Run'.padEnd(20) + '  ' +
    'Status'
  );
  console.log('-'.repeat(nameWidth + 70));

  for (const skill of skills) {
    const lastRun = await getLastRun(skill.name);
    const cron = skill.frontmatter.cron || '-';
    const topic = skill.frontmatter.topic || 'default';
    const lastTime = lastRun
      ? new Date(lastRun.timestamp).toLocaleString()
      : 'never';
    const status = lastRun ? lastRun.status : '-';

    console.log(
      `${skill.name.padEnd(nameWidth)}  ${cron.padEnd(18)}  ${topic.padEnd(12)}  ${lastTime.padEnd(20)}  ${status}`
    );
  }
}
