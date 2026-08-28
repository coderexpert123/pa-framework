/**
 * ANSI escape code stripper for bot relay.
 *
 * Removes CSI sequences (colors, cursor movement, etc.) from CLI output
 * before relaying to Telegram, ensuring clean MarkdownV2 rendering.
 *
 * CSI format: ESC + '[' + parameters + intermediate bytes + final byte
 * Pattern: \x1b\[[0-9;?]*[ -/]*[@~]
 *
 * Also strips any lone ESC bytes that weren't part of a valid CSI sequence
 * (belt-and-braces cleanup).
 *
 * @param text - CLI output that may contain ANSI escape codes
 * @returns Clean text with all ANSI sequences removed
 */
export function stripAnsi(text: string): string {
  // Remove CSI sequences: ESC '[' + params + final byte
  // Covers SGR (colors), cursor moves, erases, etc.
  // Final byte is typically a letter (m for SGR, K/J for erase, H/F for cursor)
  const withoutCsi = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

  // Remove any orphaned ESC bytes that weren't part of valid CSI
  return withoutCsi.replace(/\x1b/g, '');
}
