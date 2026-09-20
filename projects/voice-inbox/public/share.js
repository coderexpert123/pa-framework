// Voice Inbox — public read-only conversation share page (AI-227).
//
// Loaded only from /s/:token (share.html). Strictly passive: one GET to
// /api/v1/share/:token, no auth, no polling, no writes. Every dynamic string
// lands via textContent — same injection boundary app.js documents for the
// authenticated PWA.

const STATE_LABELS = {
  received: 'Sent',
  transcribing: 'Sent',
  routed: 'Sent',
  running: 'Running',
  awaiting_input: 'Needs you',
  transcribe_failed: "Couldn't hear that",
  done: 'Done',
  failed: "Didn't work",
  cancelled: 'Cancelled',
};

// Plain-language labels for internal input-request kinds (secret/text/choice/
// oauth/file/confirm/form) — never show the raw kind string to an external viewer.
const KIND_LABELS = {
  secret: 'Private information',
  text: 'A reply',
  choice: 'A choice',
  oauth: 'Account sign-in',
  file: 'A file',
  confirm: 'A confirmation',
  form: 'A form',
};

// Plain-language labels for input-request statuses — never show the raw
// status string to an external viewer.
const STATUS_LABELS = {
  answered: 'Answered',
  pending: 'Waiting for a reply',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return diffMin + ' min ago';
  if (diffHr < 24) return diffHr + ' hr ago';
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return diffDay + ' days ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null) continue;
    el.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === undefined || child === null) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function showError(message) {
  document.getElementById('share-container').querySelectorAll('header, #share-turns')
    .forEach((el) => { el.hidden = true; });
  const errorBox = document.getElementById('share-error');
  document.getElementById('share-error-text').textContent = message;
  errorBox.hidden = false;
}

// ---------------------------------------------------------------------------
// Structured answer rendering (design audit M3, 2026-09-14): a minimal port of
// app.js's answer pipeline. splitAnswerBlocks / classifyBlock / answerTier /
// answerParagraphs / stripAnswerMarkers arrive as globals from answer-shapes.js
// (loaded before this module in share.html). Every node is built with
// h()/document.createTextNode — never innerHTML (the same injection boundary
// the rest of this page keeps).
// Deliberate differences from app.js's version: no copy buttons, no
// localStorage unhandled-shape backlog, and :::raw-html blocks are SKIPPED —
// model-generated HTML never renders on a public page (a plain-language
// notice is shown in its place).
// NOTE: this h() does not flatten array children or wire `on*` attributes —
// mapped children are spread, and click handlers go through addEventListener.
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) if (c) el.append(c);
  return el;
}

/** Disclosure chevron — same shape as app.js's chevron('M9 6l6 6-6 6'). */
function chevronSvg(size, tone, d, cls) {
  return svgEl('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: tone,
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', class: cls,
  }, svgEl('path', { d }));
}

/** Bare-URL detector: trims trailing sentence punctuation off the match. */
function extractLinks(text) {
  const re = /https?:\/\/[^\s<>()"']+/g;
  const out = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ link: false, text: text.slice(last, m.index) });
    let url = m[0];
    let trail = '';
    while (url.length && /[.,;:!?)\]]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
    out.push({ link: true, href: url, text: url });
    if (trail) out.push({ link: false, text: trail });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ link: false, text: text.slice(last) });
  return out;
}

/** Word-bounded single star or underscore emphasis: balanced markers only, applied to plain (non-bold, non-link) text. */
const EMPHASIS_RE = /(^|[\s(])([*_])(?!\2)(\S(?:.*?\S)?)\2(?=[\s).,;:!?]|$)/g;
function splitEmphasis(text) {
  const out = [];
  let last = 0, m;
  EMPHASIS_RE.lastIndex = 0;
  while ((m = EMPHASIS_RE.exec(text))) {
    const start = m.index + m[1].length;
    if (start > last) out.push({ em: false, text: text.slice(last, start) });
    out.push({ em: true, text: m[3] });
    last = m.index + m[0].length;
    EMPHASIS_RE.lastIndex = last;
  }
  if (last < text.length) out.push({ em: false, text: text.slice(last) });
  return out;
}

/**
 * Inline markdown for one line of answer text: **bold** -> <strong>, a single
 * star or underscore pair -> <em> (word-bounded, balanced), bare https:// ->
 * <a>. A stray unbalanced ** is stripped rather than shown; a stray
 * unbalanced single star or underscore is left as a literal character.
 */
function parseInlineText(raw) {
  const boldRe = /\*\*([^*]+?)\*\*/g;
  const segments = [];
  let last = 0, m;
  while ((m = boldRe.exec(raw))) {
    if (m.index > last) segments.push({ bold: false, text: raw.slice(last, m.index) });
    segments.push({ bold: true, text: m[1] });
    last = boldRe.lastIndex;
  }
  if (last < raw.length) segments.push({ bold: false, text: raw.slice(last) });

  const nodes = [];
  for (const seg of segments) {
    if (seg.bold) { nodes.push(h('strong', null, seg.text)); continue; }
    const plain = seg.text.split('**').join(''); // stray unbalanced **, stripped not shown
    for (const part of extractLinks(plain)) {
      if (part.link) { nodes.push(h('a', { href: part.href, target: '_blank', rel: 'noopener' }, part.text)); continue; }
      for (const em of splitEmphasis(part.text)) nodes.push(em.em ? h('em', null, em.text) : document.createTextNode(em.text));
    }
  }
  return nodes.length ? nodes : [document.createTextNode('')];
}

/** One paragraph/list-item's text: single \n as <br> (never collapsed to a space), then inline markdown per line. */
function renderLines(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(h('br'));
    out.push(...parseInlineText(line));
  });
  return out;
}

/** Max label-value/heading re-dispatch depth (pathological-nesting guard). */
const SHARE_ANSWER_MAX_DEPTH = 2;

/**
 * The renderBlocks port: code blocks render as <pre>; raw-html blocks render
 * as a plain-language notice (never model HTML on a public page); text blocks
 * classify per paragraph and dispatch to a shape renderer below.
 */
function renderShareBlocks(blocks, nodes, depth, onParagraphStart) {
  for (const block of blocks) {
    if (block.kind === 'code') {
      nodes.push(h('pre', { class: 'answer-pre' }, document.createTextNode(block.code)));
      continue;
    }
    if (block.kind === 'raw-html') {
      nodes.push(h('p', { class: 'answer' },
        "This section contains interactive content that's only viewable in the app."));
      continue;
    }
    for (const para of answerParagraphs(block.text)) {
      const shape = classifyBlock(para);
      if (onParagraphStart) onParagraphStart(shape, para);
      renderShareShape(shape, para, nodes, depth);
    }
  }
}

function renderShareShape(shape, para, nodes, depth) {
  switch (shape.kind) {
    case 'table': {
      const table = h('table', { class: 'answer-table' });
      if (shape.header) {
        table.append(h('thead', null,
          h('tr', null, ...shape.header.map((cell) => h('th', null, cell)))));
      }
      table.append(h('tbody', null,
        ...shape.rows.map((row) => h('tr', null, ...row.map((cell) => h('td', null, cell))))));
      nodes.push(table);
      return;
    }
    case 'label-value': {
      nodes.push(h('p', { class: 'answer' }, h('strong', null, shape.label)));
      if (shape.body && depth < SHARE_ANSWER_MAX_DEPTH) {
        renderShareBlocks(splitAnswerBlocks(shape.body), nodes, depth + 1);
      } else if (shape.body) {
        nodes.push(h('p', { class: 'answer' }, ...renderLines(shape.body)));
      }
      return;
    }
    case 'heading': {
      nodes.push(h('p', { class: 'answer' }, h('strong', null, shape.text)));
      if (shape.rest && depth < SHARE_ANSWER_MAX_DEPTH) {
        renderShareBlocks(splitAnswerBlocks(shape.rest), nodes, depth + 1);
      } else if (shape.rest) {
        nodes.push(h('p', { class: 'answer' }, ...renderLines(shape.rest)));
      }
      return;
    }
    case 'list': {
      if (shape.lead) nodes.push(h('p', { class: 'answer' }, ...renderLines(shape.lead)));
      nodes.push(h(shape.ordered ? 'ol' : 'ul', { class: 'answer-list' },
        ...shape.items.map((item) => h('li', null, ...renderLines(item)))));
      return;
    }
    default: {
      nodes.push(h('p', { class: 'answer' }, ...renderLines(para)));
    }
  }
}

/** Tiered-card open/close — local per card (this page renders once, no poll). */
function setShareAnswerOpen(toggle, labelText, detail, open) {
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  detail.hidden = !open;
  labelText.data = open ? 'Hide full answer' : 'Show full answer';
}

/** Section chips for a tiered card — port of app.js's chipRow (max 4 chips,
 *  heading/label-value/lead-list anchors only; click opens the detail and
 *  scrolls the anchored node into view with the same highlight flash). */
function shareChipRow(anchors, detailNodes, toggle, labelText, detail) {
  const chips = [];
  for (const a of anchors) {
    if (chips.length >= 4) break;
    let text = null;
    if (a.shape.kind === 'heading') text = a.shape.text;
    else if (a.shape.kind === 'label-value') text = a.shape.label.replace(/:\s*$/, '');
    else if (a.shape.kind === 'list' && a.shape.lead) text = a.shape.lead.replace(/:\s*$/, '');
    else continue;
    text = stripAnswerMarkers(text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > 24) text = text.slice(0, 24).replace(/\s+\S*$/, '') + '…';
    if (a.shape.kind === 'list') text += ' (' + a.shape.items.length + ')';
    chips.push({ text, startIndex: a.startIndex });
  }
  if (chips.length < 2) return null;
  return h('div', { class: 'chip-row' }, ...chips.map((c) => {
    const btn = h('button', { class: 'chip', type: 'button' }, c.text);
    btn.addEventListener('click', () => {
      if (detail.hidden) setShareAnswerOpen(toggle, labelText, detail, true);
      const target = detailNodes[c.startIndex];
      if (!target) return;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      target.style.transition = 'background-color 0.8s';
      target.classList.add('chip-flash');
      if (target._chipTimer) clearTimeout(target._chipTimer);
      target._chipTimer = setTimeout(() => { target.classList.remove('chip-flash'); }, 1100);
    });
    return btn;
  }));
}

/**
 * The tiered card for long answers (>15 estimated lines): IN SHORT lead +
 * section chips + a collapsed full-answer detail behind a quiet toggle — a
 * minimal port of app.js's tieredAnswerNodes. The lead prefers the stored
 * task.result_short (worker-written, never capped) and falls back to
 * answerTier()'s deterministic lead.
 */
function shareTieredNodes(task, tier) {
  const detailNodes = [];
  const anchors = [];
  renderShareBlocks(splitAnswerBlocks(task.result_summary), detailNodes, 0, (shape) => {
    anchors.push({ shape, startIndex: detailNodes.length });
  });

  const detailId = 'answer-detail-' + task.task_id;
  const labelText = document.createTextNode('Show full answer');
  const detail = h('div', { class: 'answer-detail', id: detailId },
    h('div', { class: 'answer-detail-inner' }, ...detailNodes));
  detail.hidden = true;
  const toggle = h('button', {
    class: 'linkish answer-toggle', type: 'button',
    'aria-expanded': 'false', 'aria-controls': detailId,
  },
    chevronSvg(12, 'currentColor', 'M9 6l6 6-6 6', 'answer-chevron'),
    h('span', null, labelText),
    h('span', { class: 'meta' }, ' · ' + tier.words + ' words'));
  toggle.addEventListener('click', () => {
    setShareAnswerOpen(toggle, labelText, detail, detail.hidden);
  });

  const lead = task.result_short && task.result_short.trim()
    ? stripAnswerMarkers(task.result_short) : tier.lead;
  const card = h('div', { class: 'tldr' },
    h('p', { class: 'tldr-lead' }, h('span', { class: 'tldr-tag' }, 'IN SHORT'), lead));
  const chips = shareChipRow(anchors, detailNodes, toggle, labelText, detail);
  if (chips) card.append(chips);
  return [card, toggle, detail];
}


function renderInputRequest(req) {
  const kindLabel = KIND_LABELS[req.kind] || 'A response';
  const statusLabel = STATUS_LABELS[req.status] || req.status;
  const rows = [h('p', { class: 'ask' }, req.status === 'pending' ? statusLabel : (req.prompt || ''))];
  const timePart = req.answered_at ? ' · ' + formatTime(req.answered_at) : '';
  rows.push(h('p', { class: 'meta faded' }, `${kindLabel} · ${statusLabel}${timePart}`));
  return h('div', { class: 'row-answer' }, ...rows);
}

function renderTurn(task) {
  const nodes = [];
  nodes.push(h('div', { class: 'turn-said' }, h('div', { class: 'said' }, task.request_text || '')));
  if (task.result_summary) {
    const tier = answerTier(task.result_summary);
    if (tier.tiered) {
      nodes.push(h('div', { class: 'turn-assistant' }, ...shareTieredNodes(task, tier)));
    } else {
      const detailNodes = [];
      renderShareBlocks(splitAnswerBlocks(task.result_summary), detailNodes, 0);
      nodes.push(h('div', { class: 'turn-assistant' }, ...detailNodes));
    }
  }
  const inputRequests = Array.isArray(task.input_requests) ? task.input_requests : [];
  for (const req of inputRequests) {
    nodes.push(renderInputRequest(req));
  }
  nodes.push(h('p', { class: 'meta faded' }, `${STATE_LABELS[task.state] || task.state} · ${formatTime(task.created_at)}`));
  return h('div', {}, ...nodes);
}

// U12: social-card meta — static defaults live in share.html for crawlers;
// this refreshes them to the loaded conversation once data arrives.
function updateMeta(title, description) {
  document.title = (title || 'Shared conversation') + ' — Voice Inbox';
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const ogDesc = document.querySelector('meta[property="og:description"]');
  const twTitle = document.querySelector('meta[name="twitter:title"]');
  const twDesc = document.querySelector('meta[name="twitter:description"]');
  if (ogTitle) ogTitle.setAttribute('content', (title || 'Shared conversation') + ' — Voice Inbox');
  if (ogDesc) ogDesc.setAttribute('content', description || 'A conversation with a personal assistant. Read-only share.');
  if (twTitle) twTitle.setAttribute('content', (title || 'Shared conversation') + ' — Voice Inbox');
  if (twDesc) twDesc.setAttribute('content', description || 'A conversation with a personal assistant. Read-only share.');
}

async function render() {
  const path = location.pathname;
  if (!path.startsWith('/s/')) {
    showError('This link is not a valid share URL. Share links start with /s/ followed by a token.');
    return;
  }
  const token = path.slice(3); // strip '/s/'
  if (!token) {
    showError('This link is not a valid share URL. Share links start with /s/ followed by a token.');
    return;
  }
  let res;
  try {
    res = await fetch(`/api/v1/share/${encodeURIComponent(token)}`);
  } catch {
    showError('This conversation is no longer shared or does not exist.');
    return;
  }
  if (!res.ok) {
    showError('This conversation is no longer shared or does not exist.');
    return;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    showError('This conversation is no longer shared or does not exist.');
    return;
  }
  if (!body || body.ok !== true || !body.conversation) {
    showError('This conversation is no longer shared or does not exist.');
    return;
  }
  const { summary, meta, turns } = body.conversation;
  const title = (meta && meta.title) || summary.request_text || 'Conversation';
  updateMeta(title, (Array.isArray(turns) && turns[0] && turns[0].request_text) || '');
  document.getElementById('share-title').textContent = title;
  document.getElementById('share-status').textContent = STATE_LABELS[summary.state] || summary.state;
  const recap = (meta && meta.recap) || summary.result_summary || '';
  document.getElementById('share-recap').textContent = recap;
  const nextAction = meta && meta.next_action;
  document.getElementById('share-next-action').textContent = nextAction ? `Next: ${nextAction}` : '';

  const turnsEl = document.getElementById('share-turns');
  turnsEl.replaceChildren();
  for (const task of Array.isArray(turns) ? turns : []) {
    turnsEl.append(renderTurn(task));
  }
}

render();
