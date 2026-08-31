// Single parser for `git status --porcelain` (v1). Three independent
// reimplementations existed until 2026-08-23 and exactly one was wrong
// (`commands/claim.ts` trimmed before slicing, so every ` M path` line lost
// the path's first character and was silently dropped by the caller's
// `fs.stat` — `plans/2026-08-23-coordination-audit.md` finding 1). Do not
// add a fourth.

export interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
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
      rest = rest.slice(1, -1);
    }
    const path = rest.replace(/\\/g, '/').replace(/^\.\//, '');
    entries.push({ x, y, path });
  }
  return entries;
}

export function parsePorcelainPaths(output: string): string[] {
  return parsePorcelainEntries(output).map((e) => e.path);
}
