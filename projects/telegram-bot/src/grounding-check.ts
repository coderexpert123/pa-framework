/**
 * AI-101: detects a topic `description` that looks like it was clobbered by
 * the pendingDescription/voice-transcription flow rather than genuinely
 * curated — the exact shape of the 2026-08-05 incident (thread 7822 got the
 * literal text of a voice message; thread 2839 independently got a leaked
 * assistant reply). Pattern-based and deliberately narrow: it does NOT flag
 * a missing/empty description (a separate, much larger, pre-existing gap —
 * ~6 of 49 topics have none — that `backfillTopicDescriptions` already
 * handles best-effort; flagging it here would page daily from day one and
 * get muted, defeating the point). Only flags descriptions that actively
 * look wrong.
 */

const SUSPICIOUS_PREFIXES = [
  'it looks like',
  'description set',
  '[voice message]',
  '[audio file]',
  '[video note]',
];

export function isSuspiciousDescription(description: string | undefined): boolean {
  if (!description) return false; // missing is a different, separately-handled gap
  const trimmed = description.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();

  // Check the first line, not just the whole string — a clobbered multi-line
  // description (e.g. a question followed by a dumped [ATTACHMENT: ...] path,
  // topic 3246's incident) ends its FIRST line with '?' but not the string
  // as a whole.
  const firstLine = trimmed.split('\n', 1)[0].trimEnd();
  if (firstLine.endsWith('?')) return true;

  if (lower.includes('[attachment:')) return true;

  return SUSPICIOUS_PREFIXES.some((p) => lower.startsWith(p));
}
