import { restore, list } from '../lib/coexistence.js';
import type { CoexistenceEntry } from '../lib/coexistence.js';

/**
 * `pa coexistence` — list and restore PA's registered, reversible edits to
 * the user's existing CLI configs (Wave C / WP-C2).
 *
 * - `pa coexistence list [--json]`  registry rows: what PA touched, where.
 * - `pa coexistence restore <id>`   copy the pre-edit config bytes back over
 *                                   the live config (byte-identical; the
 *                                   registry row is spent on success).
 * - `pa coexistence restore --all`  restore every registry row.
 *
 * The never-overwrite rule lives in the engine (lib/coexistence.ts): a
 * collision throws KeyCollisionError and the caller routes to the ask flow
 * (WP-C3) — never a silent overwrite. This command reads the registry and
 * replays snapshots; it never writes a config surface directly.
 */

function renderEntry(e: CoexistenceEntry): string {
  const keys = e.addedKeys.length > 0 ? e.addedKeys.join(',') : '(none)';
  return `id=${e.id} cli=${e.cli} surface=${e.surface} addedKeys=${keys} ts=${e.timestamp}`;
}

export async function coexistenceCommand(args: string[] = []): Promise<void> {
  const [sub, ...rest] = args;

  if (sub === 'list') {
    const entries = await list();
    if (rest.includes('--json')) {
      console.log(JSON.stringify({ entries }, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log('no coexistence registry entries — PA has not modified any CLI config');
      return;
    }
    for (const e of entries) console.log(renderEntry(e));
    return;
  }

  if (sub === 'restore') {
    const json = rest.includes('--json');
    const idArgs = rest.filter((a) => a !== '--json');
    const all = idArgs.includes('--all');
    const ids = idArgs.filter((a) => a !== '--all');
    if (ids.length === 0 && !all) {
      console.error('usage: pa coexistence restore <id...> [--all] [--json]');
      process.exitCode = 1;
      return;
    }
    const entries = await list();
    const targets = all ? entries.map((e) => e.id) : ids;
    if (targets.length === 0) {
      if (json) console.log(JSON.stringify({ restored: [], failed: [] }, null, 2));
      else console.log('no coexistence registry entries to restore');
      return;
    }
    const restored: Array<{ id: string; surface: string; byteIdentical: boolean }> = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of targets) {
      try {
        const r = await restore(id);
        restored.push({ id, ...r });
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (json) {
      console.log(JSON.stringify({ restored, failed }, null, 2));
    } else {
      for (const r of restored) {
        console.log(`restored ${r.id} (${r.surface}) byteIdentical=${r.byteIdentical}`);
      }
      for (const f of failed) console.error(`failed ${f.id}: ${f.error}`);
    }
    if (failed.length > 0) process.exitCode = 1;
    return;
  }

  console.error('usage: pa coexistence <list|restore> ...');
  process.exitCode = 1;
}
