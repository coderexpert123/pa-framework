/**
 * Canonical inline-keyboard builders for human-in-the-loop decisions, shared by pa
 * (the self-improver attaches them to its notices via `notifyUser({ replyMarkup })`)
 * and the bot (which parses the presses in `projects/telegram-bot/src/callbacks.ts`).
 *
 * 2026-08-24 (buttons program, the buttons-program spec P5).
 * `buildHITLKeyboard` is a verbatim move of the bot's `logic.ts` builder, whose
 * keyboard was built and tested but NEVER SENT (no production caller could reach
 * `sendMessageWithKeyboard`, and pa's notify path had no reply_markup support).
 * Its output must stay byte-identical — `projects/telegram-bot/src/tests/hitl-buttons.test.ts`
 * and `pa/tests/hitl-keyboard.test.ts` both assert the exact callback strings; those two
 * assertions are the drift alarm between producer and parser.
 *
 * Callback grammar (spec §3.2, FROZEN): `pm:<auditId≤40>:approve|reject|diff` and
 * `dr:<name≤40>:approve|reject|show`. Both are operator-gated on the bot side.
 */

export interface HitlKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Approve/Reject/Show-diff for a risk-flagged applied change. `pm:<auditId>:<action>`. */
export function buildHITLKeyboard(auditRecord: { risk_flags?: string[]; ts?: string }): HitlKeyboard | undefined {
  if (!auditRecord.risk_flags || auditRecord.risk_flags.length === 0) {
    return undefined;
  }

  // Check for high-risk flags that require HITL approval
  const highRiskFlags = ['critical-skill', 'declares-secrets'];
  const hasHighRiskFlag = auditRecord.risk_flags.some(flag => highRiskFlags.includes(flag));

  if (!hasHighRiskFlag) {
    return undefined;
  }

  // Use timestamp as audit record ID for callback_data
  const auditId = auditRecord.ts || 'unknown';

  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `pm:${auditId}:approve` },
        { text: '❌ Reject', callback_data: `pm:${auditId}:reject` },
      ],
      [
        { text: '📄 Show diff', callback_data: `pm:${auditId}:diff` },
      ],
    ],
  };
}

const DRAFT_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Approve/Reject/Show for a draft left `pending` by a failed validation. `dr:<name>:<action>`.
 *  Returns undefined when `name` does not match /^[A-Za-z0-9_-]{1,40}$/ (64-byte callback budget). */
export function buildDraftKeyboard(name: string): HitlKeyboard | undefined {
  if (!DRAFT_NAME_RE.test(name)) return undefined;
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `dr:${name}:approve` },
        { text: '❌ Reject', callback_data: `dr:${name}:reject` },
      ],
      [
        { text: '📄 Show', callback_data: `dr:${name}:show` },
      ],
    ],
  };
}
