import { listDrafts } from '../drafts.js';

export async function draftsCommand(
  filter?: 'pending' | 'rejected' | 'approved'
): Promise<void> {
  const status = filter ?? 'pending';
  const drafts = await listDrafts(status);

  if (drafts.length === 0) {
    console.log(`No ${status} skill drafts.`);
    return;
  }

  const nameW = 30;
  const sourceW = 14;
  const dateW = 12;
  const reasonW = 60;

  const header = [
    'Name'.padEnd(nameW),
    'Source'.padEnd(sourceW),
    'Proposed'.padEnd(dateW),
    'Reason',
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const { skill, meta } of drafts) {
    const date = meta.proposed_at.slice(0, 10);
    const reason = meta.reason.length > reasonW
      ? meta.reason.slice(0, reasonW - 3) + '...'
      : meta.reason;

    console.log([
      skill.name.padEnd(nameW),
      meta.source_type.padEnd(sourceW),
      date.padEnd(dateW),
      reason,
    ].join('  '));
  }

  console.log(`\n${drafts.length} draft(s). Run 'pa approve <name>' or 'pa reject <name>'.`);
}
