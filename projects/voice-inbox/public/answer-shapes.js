'use strict';

/**
 * Voice Inbox answer shape layer (2026-09-11, vi-35a4487d5c04).
 *
 * PURE string logic: no DOM, no storage, no timers. This file is evaluated by
 * src/tests/answer-shapes.test.ts with the DOM globals shadowed to undefined,
 * and it must keep working exactly there. app.js consumes splitAnswerBlocks +
 * classifyBlock (+ the two diagnostics helpers) as globals; index.html loads
 * this file BEFORE app.js (both defer). The enumerator rule below mirrors
 * app.js's findEnumerators() — which stays byte-untouched — and the test pins
 * both the exact regex text and its behavior; do not reformat it.
 */

/** \r\n and lone \r normalize to \n at every entry point, so line logic
 *  never sees a carriage return (Windows paste paths, mixed editors). */
function normalizeAnswerText(text) {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
}

/** Blank-line paragraph split — the same rule app.js's paragraphs() uses. */
function answerParagraphs(text) {
  return normalizeAnswerText(text).split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Enumerator match — mirrors app.js's findEnumerators() exactly:
 * `1)`, `1.`, `-`, `•` or `*` counts only at the start of the text or
 * immediately after sentence punctuation (. ! ? :) plus whitespace, and only
 * when followed by whitespace itself — this is what keeps "about 13 km" or
 * "6:30-7:30 PM" from being mistaken for a list marker. (\s matches \n, so
 * "…itself:\n1) …" and "…cookies.\n2) …" both mark: multi-item numbered
 * lists keep promoting. A single mid-prose mark never promotes.)
 */
function answerEnumerators(text) {
  const re = /(?:^|(?<=[.!?:]\s))(?:(\d{1,3})[.)]|[-•*])\s+/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: re.lastIndex, ordered: m[1] !== undefined });
  return out;
}

/** The ≥2-mark list split — mirrors app.js's splitList() exactly. */
function answerSplitList(text) {
  const marks = answerEnumerators(text);
  if (marks.length < 2) return null;
  const ordered = marks[0].ordered;
  const lead = text.slice(0, marks[0].start).trim();
  const items = marks
    .map((mk, i) => text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : text.length).trim())
    .filter((s) => s.length > 0);
  return items.length >= 2 ? { lead, items, ordered } : null;
}

/**
 * Line-start dash item: `- ` at column 0 of its line. DASH ONLY here — digit
 * markers get their own, stricter route (answerLineDigitSplit, >=2 marks
 * required) since a single line-start digit reads as prose far more often
 * than a single dash does. Never mid-line, never indented, and a missing
 * space ("-5 degrees") is not an item. `•` and `*` at a line start
 * deliberately stay prose and land in the looksStructured backlog instead.
 */
const ANSWER_LINE_DASH_ITEM_RE = /^-\s/;

/**
 * The introduced-bullet rule (Warmup/Main/Cooldown in the Strava corpus):
 * the run of line-start dash items — ONE is enough, with or without a lead —
 * promotes the block to an unordered list. Text before the first dash line is
 * the lead; any non-dash line after the first item folds into the last item
 * (the same accepted mechanical shape splitList has for trailing prose).
 */
function answerLineDashSplit(para) {
  const lines = para.split('\n');
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ANSWER_LINE_DASH_ITEM_RE.test(lines[i])) { firstIdx = i; break; }
  }
  if (firstIdx === -1) return null;
  const lead = lines.slice(0, firstIdx).join('\n').trim();
  const items = [];
  for (let i = firstIdx; i < lines.length; i++) {
    if (ANSWER_LINE_DASH_ITEM_RE.test(lines[i])) items.push(lines[i].replace(ANSWER_LINE_DASH_ITEM_RE, '').trim());
    else if (items.length) items[items.length - 1] += '\n' + lines[i].trim();
  }
  return items.length ? { lead, items, ordered: false } : null;
}

/**
 * Line-start numbered item: `\d{1,3}[.)]` at column 0 of its line, followed
 * by whitespace. Digit-only mirror of the dash rule above, added because the
 * enumerator regex's `(?<=[.!?:]\s)` lookbehind only recognizes item 2+ when
 * the PRECEDING item ends in sentence punctuation — a short, phrase-style
 * numbered list ("1. Buy milk" / "2. Walk the dog", no trailing periods)
 * never reaches 2 marks there and fell through to prose, unlike an
 * equivalent dash list which promotes regardless of punctuation. Requires
 * >=2 line-start marks (not "one is enough" like the dash rule): a single
 * "1) ..." line reads as a mid-prose aside far more often than a single dash
 * does (SINGLE_NUMBERED_ALONE anti-regression).
 */
const LINE_DIGIT_ITEM_RE = /^\d{1,3}[.)]\s/;

function answerLineDigitSplit(para) {
  const lines = para.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (LINE_DIGIT_ITEM_RE.test(lines[i])) starts.push(i);
  }
  if (starts.length < 2) return null;
  const firstIdx = starts[0];
  const lead = lines.slice(0, firstIdx).join('\n').trim();
  const items = [];
  for (let i = firstIdx; i < lines.length; i++) {
    if (LINE_DIGIT_ITEM_RE.test(lines[i])) items.push(lines[i].replace(LINE_DIGIT_ITEM_RE, '').trim());
    else if (items.length) items[items.length - 1] += '\n' + lines[i].trim();
  }
  return items.length >= 2 ? { lead, items, ordered: true } : null;
}

/** A table row line: starts AND ends with `|` after trim. */
function isTableRowLine(line) {
  const t = line.trim();
  return t.length >= 2 && t.startsWith('|') && t.endsWith('|');
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** A `|---|:-:|----|` separator row: every cell is only dashes/colons
 *  (≥2 dashes each). A malformed separator simply means "no header". */
function isTableSeparatorLine(line) {
  const cells = splitTableRow(line);
  return cells.length >= 1 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * Classify one blank-line paragraph. Ordered detection, first match wins:
 * label-value → table → heading → list → prose.
 */
function classifyBlock(para) {
  const text = normalizeAnswerText(para);
  if (!text.trim()) return { kind: 'prose' };
  const lines = text.split('\n');
  const firstTrim = lines[0].trim();

  // label-value: the first line ends with `:` (trailing spaces allowed) and a
  // non-empty body follows — but a heading line or a table row line is never
  // a label (those classifiers own their shapes).
  if (lines.length >= 2 && firstTrim.endsWith(':') &&
      !/^#{1,6}\s/.test(firstTrim) && !isTableRowLine(lines[0])) {
    const body = lines.slice(1).join('\n').trim();
    if (body) return { kind: 'label-value', label: firstTrim, body };
  }

  // table: ≥2 lines and EVERY non-empty trimmed line starts and ends with
  // `|` (a mixed prose/table block stays prose and lands in the backlog —
  // classify never drops a line). A separator row marks the row above it as
  // the header; a leading separator means headerless.
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length >= 2 && nonEmpty.every(isTableRowLine)) {
    let header = null;
    let dataRows = nonEmpty;
    if (isTableSeparatorLine(nonEmpty[0])) {
      dataRows = nonEmpty.slice(1);
    } else if (nonEmpty.length >= 2 && isTableSeparatorLine(nonEmpty[1])) {
      header = splitTableRow(nonEmpty[0]);
      dataRows = nonEmpty.slice(2);
    }
    return { kind: 'table', header, rows: dataRows.map(splitTableRow) };
  }

  // heading: the existing rule — leading #{1,6} on the first line.
  const heading = /^#{1,6}\s+(.+)$/.exec(firstTrim);
  if (heading) {
    return { kind: 'heading', text: heading[1], rest: lines.slice(1).join('\n').trim() };
  }

  // list — (a) line-start dash items FIRST (see answerLineDashSplit): a
  // literal line-start `- ` is unambiguous, and checking it ahead of the
  // enumerator route avoids t-311/D2 — when a bold-label lead line ends in
  // `**` (never matches the enumerator lookbehind) but item 1 ends in
  // sentence punctuation, the enumerator route used to find marks starting
  // at item 2, silently folding the label AND item 1 into `lead` with a
  // literal `- ` still embedded in it; (b) the existing ≥2-enumerator rule,
  // exactly as app.js has it; (c) line-start numbered items (see
  // answerLineDigitSplit) — a lone "1) …" line still stays prose since that
  // route also needs >=2 marks.
  const viaLineDash = answerLineDashSplit(text);
  if (viaLineDash) return { kind: 'list', lead: viaLineDash.lead, items: viaLineDash.items, ordered: false };
  const viaEnumerators = answerSplitList(text);
  if (viaEnumerators) return { kind: 'list', lead: viaEnumerators.lead, items: viaEnumerators.items, ordered: viaEnumerators.ordered };
  const viaLineDigit = answerLineDigitSplit(text);
  if (viaLineDigit) return { kind: 'list', lead: viaLineDigit.lead, items: viaLineDigit.items, ordered: true };

  return { kind: 'prose' };
}

const LOOKS_ITEM_RE = /^(?:[-*]\s|\d{1,3}[.)](?:\s|$))/;

/**
 * True when a PROSE-classified block still shows structure the typed
 * components did not capture — this is the registration trigger: the block
 * renders as prose, but its shape lands in the vi.answer-shapes backlog.
 * ≥2 non-empty lines AND any of: ≥2 lines ending `:`; ≥30% of lines starting
 * an item marker; ≥2 indented (space/tab at column 0) non-empty lines; ≥2
 * lines containing 3+ `|`.
 */
function looksStructured(para) {
  const text = normalizeAnswerText(para);
  const rawLines = text.split('\n');
  const lines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return false;
  const n = lines.length;
  if (lines.filter((l) => l.endsWith(':')).length >= 2) return true;
  const itemStarts = lines.filter((l) => LOOKS_ITEM_RE.test(l)).length;
  if (itemStarts > 0 && itemStarts * 10 >= n * 3) return true;
  const indented = rawLines.filter((l) => l.trim().length > 0 && /^[ \t]/.test(l)).length;
  if (indented >= 2) return true;
  const pipey = lines.filter((l) => (l.match(/\|/g) || []).length >= 3).length;
  return pipey >= 2;
}

/**
 * Structural signature of one paragraph, derived ONLY from per-line shape:
 * C = code-ish (≥4-space indent), T = pipey (≥3 `|` in the line), I = item-ish
 * (line-start `- `/`* `/`• ` or digits + `.`/`)`), L = label-ish (ends `:`),
 * P = plain. Precedence per line: C, then T, then I, then L, then P. The
 * bucket sequence is run-length collapsed and `|`-joined: "L1|P2|I1". Two
 * paragraphs with the same shape produce the same fingerprint regardless of
 * wording. Empty input → "".
 */
function shapeFingerprint(para) {
  const text = normalizeAnswerText(para);
  const rawLines = text.split('\n').filter((l) => l.trim().length > 0);
  const buckets = rawLines.map((raw) => {
    const line = raw.trim();
    if (/^[ \t]{4,}\S/.test(raw)) return 'C';
    if ((line.match(/\|/g) || []).length >= 3) return 'T';
    if (/^(?:[-*•]\s|\d{1,3}[.)](?:\s|$))/.test(line)) return 'I';
    if (line.endsWith(':')) return 'L';
    return 'P';
  });
  let out = '';
  let run = 0;
  let prev = '';
  for (const b of buckets) {
    if (b === prev) {
      run += 1;
    } else {
      if (run > 0) out += (out ? '|' : '') + prev + run;
      prev = b;
      run = 1;
    }
  }
  if (run > 0) out += (out ? '|' : '') + prev + run;
  return out;
}

/**
 * Ordered answer blocks. Fenced ``` runs and :::raw-html runs are extracted
 * FIRST (a fence may span blank lines), then the remainder splits into
 * blank-line paragraphs.
 *   { kind: 'code', lang, code }  |  { kind: 'raw-html', html }  |
 *   { kind: 'text', text }
 * ``` fence rules: opening = a line starting with ``` at column 0; the rest of
 * that line is the language tag (may be empty). Closing = a line matching
 * /^```\s*$/ (bare backticks, trailing spaces allowed). An UNTERMINATED fence
 * takes the rest of the text as code and ends the block list. A ``` that is
 * not at a line start is inline text, never a fence.
 * :::raw-html fence rules (2026-09-14, the free-form lane — operator freedom
 * architecture): opening = the EXACT line /^:::raw-html\s*$/ at column 0 (no
 * language-tag variant — the marker is one fixed word); closing = /^:::\s*$/
 * (bare triple colon, trailing spaces allowed); the body is the model's HTML,
 * kept verbatim. An unterminated raw-html fence takes the rest of the text as
 * html and ends the block list, exactly like an unterminated ``` fence. The
 * renderer routes a raw-html block to a sandboxed iframe (app.js
 * renderRawHtmlBlock); everything around it renders normally.
 */
function splitAnswerBlocks(text) {
  const src = normalizeAnswerText(text);
  const lines = src.split('\n');
  const blocks = [];
  let buf = [];
  let i = 0;
  const flushText = () => {
    const paraText = buf.join('\n');
    buf = [];
    for (const p of answerParagraphs(paraText)) blocks.push({ kind: 'text', text: p });
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushText();
      const lang = line.slice(3).trim();
      const codeLines = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (/^```\s*$/.test(lines[i])) { closed = true; i += 1; break; }
        codeLines.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'code', lang, code: codeLines.join('\n') });
      if (!closed) return blocks;
    } else if (/^:::raw-html\s*$/.test(line)) {
      flushText();
      const htmlLines = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (/^:::\s*$/.test(lines[i])) { closed = true; i += 1; break; }
        htmlLines.push(lines[i]);
        i += 1;
      }
      blocks.push({ kind: 'raw-html', html: htmlLines.join('\n') });
      if (!closed) return blocks;
    } else {
      buf.push(line);
      i += 1;
    }
  }
  flushText();
  return blocks;
}

// ---------------------------------------------------------------------------
// Raw-html frame (2026-09-14, the free-form lane): PURE builders for the
// sandboxed iframe app.js renders a raw-html block into. The frame document
// (rawHtmlFrameDocument: CSP meta + base style, body = the model's HTML
// VERBATIM — never escaped, it IS html) rides to the iframe by GET /frames/raw
// (server.ts + frame-route.ts): base64url-encoded into the query, served
// verbatim under the route's OWN inline-only CSP RESPONSE header. That header
// is the whole point — a srcdoc frame inherits the app page's shell CSP
// (index.html, default-src 'self'), which a frame meta can only tighten, so
// inline styles/scripts stayed inert; the route's header lets the model's
// dynamism actually run while default-src 'none' keeps the frame network-dead.
// Over the encoded budget rawHtmlFrameSrc returns null and the caller falls
// back to the srcdoc render (structure only — the shell CSP keeps it inert)
// with a plain-language notice. Zero network either way (no external
// fonts/scripts/images; that is both the safety line and the offline
// guarantee).
// ---------------------------------------------------------------------------

/** The frame's own policy: inline style/script only, zero network. */
const RAW_FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** Minimal in-frame base: follow the system scheme, transparent background so
 *  the app's surface shows through, readable text either way. */
const RAW_FRAME_BASE_CSS =
  ':root{color-scheme:light dark}' +
  'html,body{margin:0;background:transparent;color:canvastext;' +
  'font:14px/1.5 system-ui,sans-serif}';

/** A raw-html block occupies its fixed-height frame, ~12 rendered lines at
 *  the same estimate the other shapes use — two frames tier, one does not. */
const RAW_HTML_ESTIMATE_LINES = 12;

/** Wrap model HTML into the sandboxed frame document: CSP meta + base style,
 *  body = the model's HTML VERBATIM (never escaped — it IS html). */
function rawHtmlFrameDocument(html) {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + RAW_FRAME_CSP + '">'
    + '<style>' + RAW_FRAME_BASE_CSS + '</style></head><body>'
    + String(html == null ? '' : html)
    + '</body></html>';
}

/** The /frames/raw route's encoded-payload budget: a frame document whose
 *  base64url encoding exceeds this falls back to the inert srcdoc render.
 *  TWIN of src/frame-route.ts's RAW_ROUTE_MAX_ENCODED — the frame-route test
 *  pins the two copies identical. The value keeps the whole frame URL under
 *  Node's 16 KB default request header cap with header margin. */
const RAW_ROUTE_MAX_ENCODED = 12000;

/** base64url (utf8-safe, unpadded) — the encoding /frames/raw decodes. btoa
 *  is latin1, so the utf8 bytes ride one per char. */
function base64urlUtf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The frame's src when the document fits the route budget: /frames/raw
 *  serves the ENCODED FRAME DOCUMENT (rawHtmlFrameDocument output) verbatim
 *  under the route's own inline-only CSP response header — what a srcdoc meta
 *  cannot do (it can only tighten the inherited shell CSP). Returns null over
 *  budget; the caller falls back to the inert srcdoc render. The session
 *  token is appended by app.js — session state never enters this pure layer. */
function rawHtmlFrameSrc(html) {
  const encoded = base64urlUtf8(rawHtmlFrameDocument(html));
  if (encoded.length > RAW_ROUTE_MAX_ENCODED) return null;
  return '/frames/raw?d=' + encoded;
}

// ---------------------------------------------------------------------------
// Tier estimation (2026-09-13, vi-ffb0a6d3cb44): PURE helpers that decide
// whether a result_summary renders flat (exactly as today) or behind a
// tiered answer card. app.js's stripInlineMarkers is NOT reusable here —
// this file loads before app.js (index.html) and runs standalone in the TS
// test, so the minimal marker strip below is a pinned duplicate (precedent:
// the enumerator rule exists byte-exactly in three places).
// 2026-09-13, vi-6ff65d97f391: answerLead lost its 240-char cap; it is now
// the uncapped fallback for rows with no stored result_short.
// ---------------------------------------------------------------------------

/** Collapsed characters per rendered line at 390px: 17px system text in a
 *  ~320px column (390 minus page padding and the 22px turn margin). */
const ANSWER_CHARS_PER_LINE = 46;

/** A result_summary estimated at MORE than this many rendered lines tiers. */
const ANSWER_TIER_LINE_THRESHOLD = 15;

/** Minimal inline-marker strip for estimation and lead text: raw-html fences
 *  are dropped WHOLE (the tiered card's IN SHORT lead never carries frame
 *  html; the full answer behind the disclosure holds the frames), markdown
 *  links [text](url) unwrap to their text (2026-09-13, vi-ecbf5d33801a — a
 *  rich answer's lead shows the link text, never the raw `[…](…)` shape),
 *  **bold** and `code` unwrap, word-bounded *em* /_em_ pairs unwrap, stray **
 *  is dropped, `#{1,6} ` heading marks and `- `/`• `/`* ` line-start bullet
 *  markers are removed (any line; a marker must be followed by whitespace, so
 *  "-5 degrees" and "6:30" survive), whitespace collapses. */
function stripAnswerMarkers(text) {
  return normalizeAnswerText(String(text == null ? '' : text))
    .replace(/^:::raw-html\s*\n[\s\S]*?^:::\s*$/gm, '')
    .replace(/^:::raw-html\s*\n[\s\S]*$/gm, '')
    .replace(/^:::raw-html\s*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+?)\*\*/g, '$1')
    .split('**').join('')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|[\s(])([*_])(?!\2)(\S(?:.*?\S)?)\2(?=[\s).,;:!?]|$)/g, '$1$3')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-•*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whitespace-split word count (0 for empty or whitespace-only input). */
function answerWordCount(text) {
  return normalizeAnswerText(text).trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/** Deterministic rendered-line estimate over the same block/shape read the
 *  renderer uses: code blocks count raw lines; tables count header?1:0 +
 *  rows; lists count lead + one line per item; every other shape (prose,
 *  heading, label-value) counts ceil(stripped chars / 46), floor 1. */
function estimateAnswerLines(text) {
  let lines = 0;
  for (const block of splitAnswerBlocks(text)) {
    if (block.kind === 'code') {
      lines += block.code.split('\n').length;
      continue;
    }
    if (block.kind === 'raw-html') {
      lines += RAW_HTML_ESTIMATE_LINES;
      continue;
    }
    for (const para of answerParagraphs(block.text)) {
      const shape = classifyBlock(para);
      if (shape.kind === 'table') {
        lines += (shape.header ? 1 : 0) + shape.rows.length;
      } else if (shape.kind === 'list') {
        lines += (shape.lead ? 1 : 0) + shape.items.length;
      } else {
        lines += Math.max(1, Math.ceil(stripAnswerMarkers(para).length / ANSWER_CHARS_PER_LINE));
      }
    }
  }
  return lines;
}

/** The IN SHORT lead for answers with no stored short version (the pre-v8
 *  fallback): 1-2 plain sentences, markers stripped, NEVER capped. Fragments
 *  are added WHOLE or not at all — the lead never ends mid-sentence and never
 *  carries a trimming ellipsis, however many characters it naturally takes.
 *  Sentence fragments match /^.*?[.!?](?=\s|$)/ (unbounded: a first sentence
 *  longer than 160 chars still splits at its true end instead of gluing the
 *  whole answer into one fragment); a remainder with no terminator at all is
 *  one unterminated fragment, taken whole. A first fragment shorter than 40
 *  chars (a stump opener like "Analysis complete.") is skipped when a second
 *  fragment exists. Fragments merge while the lead is <110 chars. */
function answerLead(text) {
  const s = stripAnswerMarkers(text);
  if (!s) return '';
  const fragments = [];
  let rest = s;
  while (rest.length > 0) {
    const m = /^.*?[.!?](?=\s|$)/.exec(rest);
    if (!m) { fragments.push(rest); break; }
    fragments.push(m[0]);
    rest = rest.slice(m[0].length).replace(/^\s+/, '');
  }
  let start = 0;
  if (fragments.length > 1 && fragments[0].length < 40) start = 1;
  let lead = fragments[start] || '';
  for (let i = start + 1; i < fragments.length && lead.length < 110; i++) {
    lead += ' ' + fragments[i];
  }
  return lead;
}

/** The single gate app.js calls: { tiered, lead, words }. tiered requires a
 *  non-empty word count AND an estimate strictly over the threshold. lead
 *  and words are populated only when tiered (the flat path never reads
 *  them). */
function answerTier(text) {
  const words = answerWordCount(text);
  const tiered = words > 0 && estimateAnswerLines(text) > ANSWER_TIER_LINE_THRESHOLD;
  return { tiered, lead: tiered ? answerLead(text) : '', words: tiered ? words : 0 };
}
