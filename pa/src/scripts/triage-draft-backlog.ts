import { listDrafts, markDraftMeta } from '../drafts.js';
import { appendAuditRecord } from '../lib/improvement-audit.js';

// ---------------------------------------------------------------------------
// One-off backlog triage (2026-07-11 full-autonomy regime — see
// plans/2026-07-11-autonomous-self-improver-full-autonomy.md, Phase E). Run
// once, after Phases A-D land, to clear the 54 drafts that piled up under the
// pre-autonomy gates (see self-improver.ts's now-fixed hasRealSideEffects /
// validateSkillFix root causes). Every draft still pending at that point
// predates the new regime and was never evaluated under it, so this is not a
// judgment call on each draft's merit — it's a reset. Anything still a real
// problem gets re-proposed fresh by the nightly loop and evaluated under the
// new gates/validation/thrash-control from Phases A-D.
//
// Safe to leave in the repo after the one-time run: re-running it once the
// backlog is empty is a no-op (0 pending drafts -> 0 changes, 0 audit
// records).
// ---------------------------------------------------------------------------

const BACKLOG_RESET_REASON =
  'backlog-reset-2026-07-11: predates fully-autonomous regime; loop re-proposes anything still recurring';

export async function triageDraftBacklog(): Promise<number> {
  const pending = await listDrafts('pending');
  let count = 0;
  for (const { skill, meta } of pending) {
    await markDraftMeta(skill.name, { status: 'rejected_stale' });
    await appendAuditRecord({
      ts: new Date().toISOString(),
      draft: skill.name,
      source_type: meta.source_type,
      target_skill: meta.target_skill,
      action: 'rejected_stale',
      risk_flags: meta.risk_flags ?? [],
      reason: BACKLOG_RESET_REASON,
    });
    count++;
  }
  return count;
}

// Guard so importing this module (e.g. from the test file) doesn't run the triage as a side
// effect — same CommonJS pattern as self-improver.ts's own entry-point guard (pa builds to CJS;
// no `"type": "module"` in pa/package.json, unlike the telegram-bot's ESM build).
if (require.main === module) {
  triageDraftBacklog()
    .then((count) => {
      console.log(`[triage-draft-backlog] Marked ${count} pending draft(s) rejected_stale (backlog-reset-2026-07-11).`);
    })
    .catch((err) => {
      console.error('[triage-draft-backlog] Failed:', err);
      process.exit(1);
    });
}
