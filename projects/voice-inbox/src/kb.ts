/**
 * Knowledge-base reader for GET /api/v1/kb (vi-19787afc4b2e).
 *
 * Two fixed, machine-local sources — the server is the same machine, and NO
 * request input ever reaches a path here:
 *   - topics:  `<paHome()>/topic-brains/<id>/BRAIN.md` (one doc per topic
 *     brain; same layout recall.ts indexes);
 *   - domains: the Ecosystem KB directory — recall.ts's `PA_KB_SOURCES_PATH`
 *     knob when set (that value is a FILE; its directory is the KB), else the
 *     fixed machine root `D:/My Repos/notes/Ecosystem KB`.
 *
 * The parser drops agent-facing chrome (HTML comments, blockquote lines, the
 * `Other topics:` / `Central brain:` footer lines) so the human-facing view
 * is human by construction. A missing root directory yields an empty list,
 * never an error; only unexpected read/parse failures propagate (the route
 * turns them into 500 `knowledge base unavailable`).
 *
 * Test seam: `readKnowledgeBase(roots?)` takes optional roots, the same
 * pattern web-push-store.ts uses for its storage dir. Tests NEVER rely on
 * the defaults — they always pass fixture dirs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paHome } from './config.js';

export interface KbSection {
  heading: string;
  lines: string[];
}

export interface KbDoc {
  id: string;
  title: string;
  summary: string | null;
  /** The topic-brain comment's `consolidated=<iso>` value; null for domains. */
  consolidated: string | null;
  sections: KbSection[];
}

export interface KnowledgeBase {
  topics: KbDoc[];
  domains: KbDoc[];
}

export interface KbRoots {
  topicsDir: string;
  domainsDir: string;
}

const KB_FILE_MAX_BYTES = 256 * 1024; // larger files are skipped
const KB_SECTION_MAX_LINES = 200;
const KB_TOPICS_MAX = 60;
const KB_DOMAINS_MAX = 20;

export function defaultKbRoots(): KbRoots {
  // Domains ride recall.ts's C10 knob when set (PA_KB_SOURCES_PATH is a FILE;
  // its directory is the KB), else the plan's fixed machine root.
  const env = process.env.PA_KB_SOURCES_PATH;
  return {
    topicsDir: join(paHome(), 'topic-brains'),
    domainsDir: env ? dirname(env) : 'D:\\My Repos\\notes\\Ecosystem KB',
  };
}

/**
 * Parse one markdown doc. Title: first `# ` line (fallback provided by the
 * caller, usually the filename). Summary: first `> Summary: ` line; when
 * absent, the FIRST preamble line that survives the drop rules (domain files
 * have no Summary line but open with a one-line description). consolidated:
 * the topic-brain comment's `consolidated=<value>`. Sections split on `^## `;
 * preamble (before the first `## `) is otherwise dropped. Per section: blank
 * lines dropped, HTML comments / blockquotes / footer boilerplate dropped,
 * ATX heading markers stripped (`### Entry` keeps its text), non-empty lines
 * kept, capped at KB_SECTION_MAX_LINES. Sections left empty by the drops are
 * omitted; a doc with zero sections is kept (title + summary card).
 */
function parseKbDoc(id: string, raw: string, titleFallback: string): KbDoc {
  let title: string | null = null;
  let summary: string | null = null;
  let consolidated: string | null = null;
  const sections: KbSection[] = [];
  let current: KbSection | null = null;
  const preambleKept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      current = { heading: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current === null) {
      if (!title && /^#\s+/.test(line)) title = line.replace(/^#\s+/, '').trim();
      if (!summary && /^>\s*Summary:\s?/.test(line)) {
        summary = line.replace(/^>\s*Summary:\s?/, '').trim();
      }
      const cons = /<!--\s*topic-brain:[^\n]*\bconsolidated=([^\s>]+)/.exec(line);
      if (cons) consolidated = cons[1];
      if (/^\s*<!--/.test(line)) continue;
      if (/^\s*>/.test(line)) continue;
      if (/^\s*(Other topics:|Central brain:)/.test(line)) continue;
      const preambleText = line.trim();
      if (preambleText !== '') preambleKept.push(preambleText);
      continue;
    }
    if (/^\s*<!--/.test(line)) continue;
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(Other topics:|Central brain:)/.test(line)) continue;
    const text = line.trim();
    if (text === '') continue;
    current.lines.push(text.replace(/^#{1,6}\s+/, ''));
  }
  if (!summary && preambleKept.length > 0) summary = preambleKept[0];
  const kept: KbSection[] = [];
  for (const section of sections) {
    const lines = section.lines.slice(0, KB_SECTION_MAX_LINES);
    if (lines.length > 0) kept.push({ heading: section.heading, lines });
  }
  return {
    id,
    title: title && title !== '' ? title : titleFallback,
    summary,
    consolidated,
    sections: kept,
  };
}

function readMdFiles(dir: string): Array<{ id: string; raw: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; raw: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile()) continue;
    if (!/\.md$/i.test(entry.name)) continue;
    const file = join(dir, entry.name);
    if (statSync(file).size > KB_FILE_MAX_BYTES) continue;
    try {
      out.push({ id: entry.name.replace(/\.md$/i, ''), raw: readFileSync(file, 'utf8') });
    } catch {
      continue;
    }
  }
  return out;
}

function readTopicDocs(dir: string): KbDoc[] {
  if (!existsSync(dir)) return [];
  const docs: KbDoc[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'BRAIN.md');
    if (!existsSync(file)) continue;
    if (statSync(file).size > KB_FILE_MAX_BYTES) continue;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    docs.push(parseKbDoc(entry.name, raw, entry.name));
  }
  // consolidated DESC (newest first); missing-consolidated sorts LAST
  // (oldest). Lexicographic ISO comparison — brains emit one fixed offset,
  // so cross-offset skew is accepted (documented approximation).
  docs.sort((a, b) => {
    if (a.consolidated && b.consolidated && a.consolidated !== b.consolidated) {
      return a.consolidated < b.consolidated ? 1 : -1;
    }
    if (a.consolidated && !b.consolidated) return -1;
    if (!a.consolidated && b.consolidated) return 1;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1;
  });
  return docs.slice(0, KB_TOPICS_MAX);
}

function readDomainDocs(dir: string): KbDoc[] {
  const files = readMdFiles(dir);
  const docs = files.map((f) => parseKbDoc(f.id, f.raw, f.id));
  docs.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1));
  return docs.slice(0, KB_DOMAINS_MAX);
}

/** Read both KB groups. Missing root dirs yield empty lists, never a throw. */
export function readKnowledgeBase(roots?: KbRoots): KnowledgeBase {
  const r = roots ?? defaultKbRoots();
  return { topics: readTopicDocs(r.topicsDir), domains: readDomainDocs(r.domainsDir) };
}
