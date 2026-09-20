/**
 * The `/frames/raw` route's decision layer (2026-09-14, the raw-html freedom
 * lane made interactive): decode + validate the base64url `d` param the PWA
 * renderer attaches to a sandboxed raw-html frame, and own the route's CSP
 * string. server.ts mounts it in the pre-router zone (next to /api/v1/stream
 * and /s/:token) — not routes.ts — because the route is not an API route and
 * must carry ITS OWN response CSP: a srcdoc frame inherits the shell page's
 * CSP (index.html, default-src 'self'), which a frame meta can only tighten,
 * so model-authored inline styles/scripts rendered inert. Served from here,
 * the response header grants inline-only dynamism while `default-src 'none'`
 * keeps the frame network-dead. The over-cap fallback (the srcdoc render)
 * carries the same policy as a meta — which is why structure-only rendering
 * still works there.
 *
 * The query token is checked by the server.ts mount (authenticateSession —
 * the /api/v1/stream precedent: iframe navigations cannot set Authorization
 * headers); this layer is deliberately session-free and pure.
 */

/** Inline style/script only, zero network. TWIN of public/answer-shapes.js's
 *  RAW_FRAME_CSP (the fallback srcdoc's meta) — frame-route.test.ts pins the
 *  two copies identical. */
export const RAW_FRAME_CSP_HEADER =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** The encoded-payload budget: a `d` longer than this is refused 413 before
 *  decoding, and the renderer falls back to the inert srcdoc render above it.
 *  The value keeps the whole frame URL under Node's 16 KB default request
 *  header cap with margin for the other request headers. TWIN of public/
 *  answer-shapes.js's RAW_ROUTE_MAX_ENCODED — frame-route.test.ts pins the
 *  two copies identical. */
export const RAW_ROUTE_MAX_ENCODED = 12_000;

export type RawFrameDecision = { ok: true; html: string } | { ok: false; status: 400 | 413 };

/** Decode + bound-check `d`: the FULL frame document (built by
 *  rawHtmlFrameDocument — base style, meta CSP, model html verbatim) is
 *  encoded by the client and served VERBATIM on success, so the document
 *  shape stays single-sourced in the public layer. Alphabet-strict (the
 *  client never pads; anything else is a hand-crafted URL) → 400;
 *  over-budget → 413 (the same copy readBody uses). */
export function decodeRawFrameParam(d: string | null): RawFrameDecision {
  if (d === null) return { ok: false, status: 400 };
  if (d.length > RAW_ROUTE_MAX_ENCODED) return { ok: false, status: 413 };
  if (!/^[A-Za-z0-9_-]*$/.test(d)) return { ok: false, status: 400 };
  return { ok: true, html: Buffer.from(d, 'base64url').toString('utf8') };
}
