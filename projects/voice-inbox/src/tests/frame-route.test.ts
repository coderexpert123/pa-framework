/**
 * /frames/raw route tests (2026-09-14, the raw-html freedom lane made
 * interactive): the decision layer in frame-route.ts (decode/validate/
 * budget) plus the pins that keep the route honest — the twin constants the
 * server shares with the public renderer (answer-shapes.js) by design, and
 * source pins on the server.ts mount itself (server.ts has no HTTP test
 * harness, so the mount wiring is pinned the same way app.js renderers are).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRawFrameParam, RAW_FRAME_CSP_HEADER, RAW_ROUTE_MAX_ENCODED } from '../frame-route.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

describe('decodeRawFrameParam', () => {
  it('decodes the frame document verbatim, utf8-exact', () => {
    const doc = '<!doctype html><html><body><p>π · ✓</p></body></html>';
    assert.deepEqual(decodeRawFrameParam(b64url(doc)), { ok: true, html: doc });
  });

  it('accepts the unpadded base64url alphabet only; anything else is a 400', () => {
    assert.deepEqual(decodeRawFrameParam(null), { ok: false, status: 400 });
    for (const bad of ['a+b/c', 'a=b', '%3D', 'd e']) {
      assert.deepEqual(decodeRawFrameParam(bad), { ok: false, status: 400 }, bad);
    }
  });

  it('refuses over-budget payloads with 413 before decoding', () => {
    assert.deepEqual(
      decodeRawFrameParam('a'.repeat(RAW_ROUTE_MAX_ENCODED + 1)),
      { ok: false, status: 413 }
    );
  });

  it('accepts exactly-at-budget (the client fallback sits on the same number)', () => {
    assert.deepEqual(decodeRawFrameParam('a'.repeat(RAW_ROUTE_MAX_ENCODED)),
      { ok: true, html: Buffer.from('a'.repeat(RAW_ROUTE_MAX_ENCODED), 'base64url').toString('utf8') });
  });
});

describe('route twin pins (server ↔ public renderer)', () => {
  const shapesSrc = readFileSync(join(PKG_ROOT, 'public', 'answer-shapes.js'), 'utf8');

  it('the response CSP header equals the fallback srcdoc meta CSP', () => {
    const m = /const RAW_FRAME_CSP = "([^"]+)"/.exec(shapesSrc);
    assert.ok(m, 'RAW_FRAME_CSP not found in answer-shapes.js');
    assert.equal(RAW_FRAME_CSP_HEADER, m[1]);
    assert.equal(RAW_FRAME_CSP_HEADER,
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  });

  it('the encoded budget is the same number on both sides', () => {
    const m = /const RAW_ROUTE_MAX_ENCODED = (\d+)/.exec(shapesSrc);
    assert.ok(m, 'RAW_ROUTE_MAX_ENCODED not found in answer-shapes.js');
    assert.equal(RAW_ROUTE_MAX_ENCODED, Number(m[1]));
    // Kept under Node's 16 KB default request header cap with header margin.
    assert.equal(RAW_ROUTE_MAX_ENCODED, 12000);
  });
});

describe('the server.ts mount (source pins — no HTTP harness)', () => {
  const serverSrc = readFileSync(join(PKG_ROOT, 'src', 'server.ts'), 'utf8');

  it('mounts /frames/raw before the static dispatch, sends the CSP header, authenticates the token', () => {
    assert.ok(serverSrc.includes("url.pathname === '/frames/raw'"), 'route mount missing');
    assert.ok(serverSrc.includes("'content-security-policy': RAW_FRAME_CSP_HEADER"),
      'the route must send the inline-only CSP response header');
    assert.ok(/authenticateSession\(db, `Bearer \$\{frameToken\}`\)/.test(serverSrc),
      'the route must authenticate the query token (unsandboxed-embedder guard)');
    assert.ok(
      serverSrc.indexOf("url.pathname === '/frames/raw'") <
      serverSrc.indexOf("!url.pathname.startsWith('/api/')"),
      'the route must be matched before the static dispatch'
    );
  });

  it('the SW passes frame fetches straight to the network (never cached, never shell-fallback)', () => {
    const swSrc = readFileSync(join(PKG_ROOT, 'public', 'sw.js'), 'utf8');
    const passthrough = swSrc.indexOf("url.pathname === '/frames/raw'");
    assert.ok(passthrough !== -1, 'sw.js /frames/raw passthrough missing');
    assert.ok(/return;/.test(swSrc.slice(passthrough, passthrough + 200)),
      'the passthrough must return without respondWith');
  });
});
