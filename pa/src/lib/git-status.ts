// Single parser for `git status --porcelain` (v1). Three independent
// reimplementations existed until 2026-08-23 and exactly one was wrong
// (`commands/claim.ts` trimmed before slicing, so every ` M path` line lost
// the path's first character and was silently dropped by the caller's
// `fs.stat` — the 2026-08-23 coordination audit, finding 1). Do not
// add a fourth.

export interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
}

/** Decode git's C-style quoting on porcelain paths (core.quotepath): named escapes
 *  plus \NNN octal bytes (UTF-8). Without this, a non-ASCII filename survives only as
 *  an escape string — every consumer downstream (drift gates, edit audit) then looks
 *  up a path that never exists on disk and scans it silently clean. (2026-09-18
 *  verifier finding; decode lives here, not per-caller.) */
function unquoteCStyle(quoted: string): string {
  const simple: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', "'": "'", '\\': '\\' };
  const bytes: number[] = [];
  const textChunks: string[] = [];
  let flush = () => { if (bytes.length) { textChunks.push(Buffer.from(bytes).toString('utf8')); bytes.length = 0; } };
  for (let i = 0; i < quoted.length; i++) {
    const c = quoted[i];
    if (c !== '\\' || i + 1 >= quoted.length) { flush(); textChunks.push(c); continue; }
    const n = quoted[i + 1];
    const octal = /^[0-7]{3}$/.exec(quoted.slice(i + 1, i + 4));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
    if (n in simple) { flush(); textChunks.push(simple[n]); i += 1; continue; }
    // Unknown escape — keep it literal rather than corrupt the path.
    flush(); textChunks.push(c);
  }
  flush();
  return textChunks.join('');
}

export function parsePorcelainEntries(output: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    const arrowIdx = rest.indexOf(' -> ');
    if (arrowIdx !== -1) rest = rest.slice(arrowIdx + 4);
    if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
      rest = unquoteCStyle(rest.slice(1, -1));
    }
    const path = rest.replace(/\\/g, '/').replace(/^\.\//, '');
    entries.push({ x, y, path });
  }
  return entries;
}

export function parsePorcelainPaths(output: string): string[] {
  return parsePorcelainEntries(output).map((e) => e.path);
}
