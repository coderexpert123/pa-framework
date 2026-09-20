// Unit tests for screencast_bridge.mjs pure helpers (AI-246 WP-C + WP-G).
// Zero-dep: node:test + node:assert only. The live WS round-trip is covered
// by the stage-4 manual smoke (a zero-dep WS server is impractical).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs,
  readConfigKey,
  resolveConfig,
  pickTarget,
  shouldSendFrame,
  shouldKeepalive,
  decodeFrameData,
  screencastAckMessage,
  startScreencastMessage,
  frameUrl,
  liveUrl,
  emulationEnableMessages,
  inputPollUrl,
  parseInputPollResponse,
  injectCommandMessages,
} from './screencast_bridge.mjs';

// PA_HOME points at a dir that does not exist so the config-fallback scan
// can never read the operator's real ~/.pa/config.yaml mid-test.
const NO_PA_HOME = join(tmpdir(), 'screencast-bridge-no-such-pa-home');
const ENV = { PA_SCREENCAST_INGEST_TOKEN: 'tok-123', PA_HOME: NO_PA_HOME };

const FIXTURE_YAML = [
  'voice_inbox:',
  '  port: 8787',
  '  screencast_ingest_token: cfg-token-456',
  'browser:',
  '  cdp_port: 9333',
  '',
].join('\n');

function fixturePaHome(yaml = FIXTURE_YAML) {
  const dir = mkdtempSync(join(tmpdir(), 'screencast-bridge-'));
  writeFileSync(join(dir, 'config.yaml'), yaml);
  return dir;
}

test('parseArgs: valued flags and bare flags', () => {
  assert.deepEqual(parseArgs(['--task', 'vi-1', '--fps', '5', '--dry']), {
    task: 'vi-1',
    fps: '5',
    dry: true,
  });
});

test('resolveConfig: env defaults apply, CLI flags win', () => {
  const cfg = resolveConfig({ task: 'vi-1' }, ENV);
  assert.equal(cfg.cdpPort, 9222);
  assert.equal(cfg.viPort, 8787);
  assert.equal(cfg.quality, 60);
  assert.equal(cfg.maxWidth, 1024);
  assert.equal(cfg.maxHeight, 768);
  assert.equal(cfg.fps, 10);
  assert.equal(cfg.targetId, undefined);
  assert.equal(cfg.token, 'tok-123');

  const over = resolveConfig(
    { task: 'vi-2', 'cdp-port': '9333', fps: '2.5', 'target-id': 'T9' },
    { ...ENV, PA_BROWSER_CDP_PORT: '9223', VOICE_INBOX_PORT: '9999' }
  );
  assert.equal(over.cdpPort, 9333); // flag beats env
  assert.equal(over.viPort, 9999); // env beats default
  assert.equal(over.fps, 2.5);
  assert.equal(over.targetId, 'T9');
});

test('resolveConfig: --task and PA_SCREENCAST_INGEST_TOKEN are required', () => {
  assert.throws(() => resolveConfig({}, ENV), /--task is required/);
  assert.throws(() => resolveConfig({ task: true }, ENV), /--task is required/);
  assert.throws(
    () => resolveConfig({ task: 'vi-1' }, { PA_HOME: NO_PA_HOME }),
    /PA_SCREENCAST_INGEST_TOKEN is not set/
  );
});

test('resolveConfig: range validation', () => {
  assert.throws(() => resolveConfig({ task: 't', quality: '700' }, ENV), /--quality must be 0..100/);
  assert.throws(() => resolveConfig({ task: 't', 'cdp-port': '70000' }, ENV), /--cdp-port must be 1..65535/);
  assert.throws(() => resolveConfig({ task: 't', fps: '0' }, ENV), /--fps must be > 0/);
  assert.throws(() => resolveConfig({ task: 't', 'max-width': 'x' }, ENV), /--max-width must be an integer/);
});

const TARGETS = [
  { id: 'BG', type: 'service_worker', webSocketDebuggerUrl: 'ws://x/bg' },
  { id: 'P1', type: 'page', title: 'newest', webSocketDebuggerUrl: 'ws://x/p1' },
  { id: 'P2', type: 'page', title: 'older', webSocketDebuggerUrl: 'ws://x/p2' },
];

test('pickTarget: first type:"page" wins (recency order), non-page skipped', () => {
  assert.equal(pickTarget(TARGETS).id, 'P1');
  assert.equal(pickTarget(TARGETS, undefined).webSocketDebuggerUrl, 'ws://x/p1');
});

test('pickTarget: --target-id selects by id regardless of type', () => {
  assert.equal(pickTarget(TARGETS, 'P2').id, 'P2');
  assert.equal(pickTarget(TARGETS, 'BG').id, 'BG');
});

test('pickTarget: clear failures', () => {
  assert.throws(() => pickTarget(TARGETS, 'ZZ'), /no CDP target with id "ZZ"/);
  assert.throws(
    () => pickTarget([{ id: 'BG', type: 'service_worker' }]),
    /no page target on the CDP endpoint/
  );
  assert.throws(
    () => pickTarget([{ id: 'P', type: 'page' }]),
    /has no webSocketDebuggerUrl/
  );
  assert.throws(() => pickTarget({ not: 'array' }), /did not return a target list/);
});

test('shouldSendFrame: drops inside the fps window, keeps at/after it', () => {
  assert.equal(shouldSendFrame(0, Date.now(), 10), true); // first frame always kept
  assert.equal(shouldSendFrame(1000, 1099, 10), false); // 99ms < 100ms → drop
  assert.equal(shouldSendFrame(1000, 1100, 10), true); // exactly 1/fps → keep
  assert.equal(shouldSendFrame(1000, 1199, 5), false); // fps=5 → 200ms window
  assert.equal(shouldSendFrame(1000, 1200, 5), true);
});

test('shouldKeepalive: starved + has frame + ws open → repost', () => {
  assert.equal(shouldKeepalive(0, 20000, 12000, true, true), 'repost');
  assert.equal(shouldKeepalive(5000, 17001, 12000, true, true), 'repost');
});

test('shouldKeepalive: starved + no frame + ws open → screenshot', () => {
  assert.equal(shouldKeepalive(0, 20000, 12000, false, true), 'screenshot');
});

test('shouldKeepalive: not starved → none', () => {
  assert.equal(shouldKeepalive(19000, 20000, 12000, true, true), 'none');
  assert.equal(shouldKeepalive(8000, 20000, 12000, false, true), 'none'); // exactly at threshold
});

test('shouldKeepalive: ws closed → none regardless', () => {
  assert.equal(shouldKeepalive(0, 999999, 12000, true, false), 'none');
  assert.equal(shouldKeepalive(0, 999999, 12000, false, false), 'none');
});

test('decodeFrameData: base64 → Buffer', () => {
  const b64 = Buffer.from('fake-jpeg-bytes').toString('base64');
  const buf = decodeFrameData(b64);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString(), 'fake-jpeg-bytes');
});

test('screencastAckMessage: exact wire shape, no id', () => {
  assert.equal(
    JSON.stringify(screencastAckMessage(7)),
    '{"method":"Page.screencastFrameAck","params":{"sessionId":7}}'
  );
});

test('startScreencastMessage: exact wire shape', () => {
  assert.equal(
    JSON.stringify(startScreencastMessage(2, { quality: 60, maxWidth: 1024, maxHeight: 768 })),
    '{"id":2,"method":"Page.startScreencast","params":{"format":"jpeg","quality":60,"maxWidth":1024,"maxHeight":768}}'
  );
});

test('frameUrl/liveUrl: ingest endpoint shapes', () => {
  const cfg = { viPort: 8787, task: 'vi-9' };
  assert.equal(frameUrl(cfg), 'http://127.0.0.1:8787/api/v1/live/vi-9/frame');
  assert.equal(liveUrl(cfg), 'http://127.0.0.1:8787/api/v1/live/vi-9');
});

test('emulationEnableMessages: exact wire shapes on ids 4/5', () => {
  const [touch, emit] = emulationEnableMessages();
  assert.equal(
    JSON.stringify(touch),
    '{"id":4,"method":"Emulation.setTouchEmulationEnabled","params":{"enabled":true,"configuration":"mobile"}}'
  );
  assert.equal(
    JSON.stringify(emit),
    '{"id":5,"method":"Emulation.setEmitTouchEventsForMouse","params":{"enabled":true}}'
  );
});

test('inputPollUrl: since query + encoded task', () => {
  const cfg = { viPort: 8787, task: 'vi 9' };
  assert.equal(
    inputPollUrl(cfg, 0),
    'http://127.0.0.1:8787/api/v1/live/vi%209/input?since=0'
  );
  assert.equal(
    inputPollUrl(cfg, 42),
    'http://127.0.0.1:8787/api/v1/live/vi%209/input?since=42'
  );
});

test('parseInputPollResponse: object and JSON-string bodies', () => {
  const cmds = [{ seq: 3, type: 'tap', x: 1, y: 2 }];
  assert.deepEqual(parseInputPollResponse({ cmds, maxSeq: 3 }, 0), { cmds, maxSeq: 3 });
  assert.deepEqual(
    parseInputPollResponse('{"cmds":[],"maxSeq":9}', 4),
    { cmds: [], maxSeq: 9 }
  );
});

test('parseInputPollResponse: empty/204/malformed degrade to nothing-new', () => {
  for (const body of ['', null, undefined, 'not-json', 42, '42', '{}']) {
    assert.deepEqual(parseInputPollResponse(body, 7), { cmds: [], maxSeq: 7 });
  }
});

test('parseInputPollResponse: missing maxSeq derives from cmd seqs', () => {
  const cmds = [{ seq: 5 }, { seq: 8 }];
  assert.deepEqual(parseInputPollResponse({ cmds }, 2), { cmds, maxSeq: 8 });
  assert.deepEqual(parseInputPollResponse({ cmds: [] }, 6), { cmds: [], maxSeq: 6 });
});

test('injectCommandMessages: tap → pressed+released, awaits the release', () => {
  const { messages, awaits } = injectCommandMessages({ type: 'tap', x: 10, y: 20 }, 100);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((m) => m.method), [
    'Input.emulateTouchFromMouseEvent', 'Input.emulateTouchFromMouseEvent',
  ]);
  assert.deepEqual(messages.map((m) => m.params.type), ['mousePressed', 'mouseReleased']);
  assert.deepEqual(messages.map((m) => m.params.x), [10, 10]);
  assert.deepEqual(messages.map((m) => m.params.y), [20, 20]);
  assert.deepEqual(messages.map((m) => m.params.button), ['left', 'left']);
  assert.deepEqual(messages.map((m) => m.params.clickCount), [1, 1]);
  assert.deepEqual(messages.map((m) => m.id), [100, 101]);
  assert.deepEqual(awaits, [{ id: 101, method: 'Input.emulateTouchFromMouseEvent' }]);
});

test('injectCommandMessages: doubletap → two tap pairs, clickCount 1 then 2', () => {
  const { messages, awaits } = injectCommandMessages({ type: 'doubletap', x: 5, y: 6 }, 200);
  assert.deepEqual(messages.map((m) => m.params.type), [
    'mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased',
  ]);
  assert.deepEqual(messages.map((m) => m.params.clickCount), [1, 1, 2, 2]);
  assert.deepEqual(messages.map((m) => m.id), [200, 201, 202, 203]);
  assert.deepEqual(awaits, [{ id: 203, method: 'Input.emulateTouchFromMouseEvent' }]);
});

test('injectCommandMessages: longpress holds via sleepAfterMs on the press', () => {
  const { messages, awaits } = injectCommandMessages(
    { type: 'longpress', x: 1, y: 2, durationMs: 700 },
    100
  );
  assert.deepEqual(messages.map((m) => m.params.type), ['mousePressed', 'mouseReleased']);
  assert.deepEqual(messages.map((m) => m.method), [
    'Input.emulateTouchFromMouseEvent', 'Input.emulateTouchFromMouseEvent',
  ]);
  assert.deepEqual(awaits, [
    { id: 100, method: 'Input.emulateTouchFromMouseEvent', sleepAfterMs: 700 },
    { id: 101, method: 'Input.emulateTouchFromMouseEvent' },
  ]);
});

test('injectCommandMessages: scroll → Runtime.evaluate elementFromPoint + scrollBy', () => {
  const { messages, awaits } = injectCommandMessages(
    { type: 'scroll', x: 3, y: 4, deltaX: 0, deltaY: -240 },
    100
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, 'Runtime.evaluate');
  assert.ok(messages[0].params.expression.includes('elementFromPoint(x,y)'),
    'expression targets the element at (x,y)');
  assert.ok(messages[0].params.expression.includes('scrollBy(dx,dy)'),
    'expression scrolls by the deltas');
  assert.ok(messages[0].params.expression.includes('(3,4,0,-240)'),
    'expression calls the IIFE with the command values');
  assert.deepEqual(awaits, [{ id: 100, method: 'Runtime.evaluate' }]);
});

test('injectCommandMessages: pinch → dispatchTouchEvent two-finger', () => {
  const { messages, awaits } = injectCommandMessages(
    { type: 'pinch', x: 9, y: 9, scaleFactor: 1.5 },
    100
  );
  assert.equal(messages.length, 3);
  assert.equal(messages[0].method, 'Input.dispatchTouchEvent');
  assert.equal(messages[0].params.type, 'touchStart');
  assert.equal(messages[0].params.touchPoints.length, 2);
  assert.equal(messages[0].params.touchPoints[0].x, 9 - 20);
  assert.equal(messages[0].params.touchPoints[1].x, 9 + 20);
  assert.equal(messages[1].method, 'Input.dispatchTouchEvent');
  assert.equal(messages[1].params.type, 'touchMove');
  assert.equal(messages[1].params.touchPoints[0].x, 9 - 30);
  assert.equal(messages[1].params.touchPoints[1].x, 9 + 30);
  assert.equal(messages[2].method, 'Input.dispatchTouchEvent');
  assert.equal(messages[2].params.type, 'touchEnd');
  assert.equal(messages[2].params.touchPoints.length, 0);
  assert.deepEqual(awaits, [{ id: 102, method: 'Input.dispatchTouchEvent' }]);
});

test('injectCommandMessages: type → insertText', () => {
  const { messages, awaits } = injectCommandMessages({ type: 'type', text: 'hi there' }, 100);
  assert.deepEqual(messages, [
    { id: 100, method: 'Input.insertText', params: { text: 'hi there' } },
  ]);
  assert.deepEqual(awaits, [{ id: 100, method: 'Input.insertText' }]);
});

test('injectCommandMessages: key → down + char + up for printable, modifier bitmask', () => {
  const { messages, awaits } = injectCommandMessages(
    { type: 'key', key: 'a', code: 'KeyA', modifiers: ['shift'] },
    100
  );
  assert.deepEqual(messages.map((m) => m.params.type), ['rawKeyDown', 'char', 'keyUp']);
  assert.equal(messages[0].params.modifiers, 8); // shift bit
  assert.equal(messages[1].params.text, 'a');
  assert.equal(messages[1].params.key, 'a');
  assert.deepEqual(awaits, [{ id: 102, method: 'Input.dispatchKeyEvent' }]);
});

test('injectCommandMessages: key → no char event for chords and non-printables', () => {
  const ctrlC = injectCommandMessages(
    { type: 'key', key: 'c', code: 'KeyC', modifiers: ['ctrl'] },
    100
  );
  assert.deepEqual(ctrlC.messages.map((m) => m.params.type), ['rawKeyDown', 'keyUp']);
  assert.equal(ctrlC.messages[0].params.modifiers, 2); // ctrl bit

  const enter = injectCommandMessages({ type: 'key', key: 'Enter', code: 'Enter' }, 100);
  assert.deepEqual(enter.messages.map((m) => m.params.type), ['rawKeyDown', 'keyUp']);
});

test('injectCommandMessages: navigate/back/forward/reload', () => {
  assert.deepEqual(injectCommandMessages({ type: 'navigate', url: 'https://x' }, 100).messages, [
    { id: 100, method: 'Page.navigate', params: { url: 'https://x' } },
  ]);
  assert.deepEqual(injectCommandMessages({ type: 'back' }, 100).messages, [
    { id: 100, method: 'Runtime.evaluate', params: { expression: 'history.back()' } },
  ]);
  assert.deepEqual(injectCommandMessages({ type: 'forward' }, 100).messages, [
    { id: 100, method: 'Runtime.evaluate', params: { expression: 'history.forward()' } },
  ]);
  assert.deepEqual(injectCommandMessages({ type: 'reload' }, 100).messages, [
    { id: 100, method: 'Page.reload', params: {} },
  ]);
});

test('injectCommandMessages: unknown/malformed commands map to nothing', () => {
  for (const cmd of [{ type: 'hover' }, {}, { type: 7 }, null, 'tap']) {
    assert.deepEqual(injectCommandMessages(cmd, 100), { messages: [], awaits: [] });
  }
});

test('readConfigKey: parses a fixture config for the documented keys', () => {
  const env = { PA_HOME: fixturePaHome() };
  assert.equal(readConfigKey('screencast_ingest_token', env), 'cfg-token-456');
  assert.equal(readConfigKey('cdp_port', env), '9333');
});

test('readConfigKey: undefined for a missing key', () => {
  const env = { PA_HOME: fixturePaHome() };
  assert.equal(readConfigKey('no_such_key', env), undefined);
  // `port` exists in the fixture but is deliberately not a documented key —
  // the flat scan still finds it (it is just a string match); resolveConfig
  // simply never asks for it (spec S4).
  assert.equal(readConfigKey('port', env), '8787');
});

test('readConfigKey: undefined when the config file is missing', () => {
  assert.equal(readConfigKey('cdp_port', { PA_HOME: NO_PA_HOME }), undefined);
});

test('resolveConfig: env token wins over config token', () => {
  const cfg = resolveConfig(
    { task: 'vi-1' },
    { PA_HOME: fixturePaHome(), PA_SCREENCAST_INGEST_TOKEN: 'env-tok' }
  );
  assert.equal(cfg.token, 'env-tok');
});

test('resolveConfig: config fallback for token when env is unset', () => {
  const cfg = resolveConfig({ task: 'vi-1' }, { PA_HOME: fixturePaHome() });
  assert.equal(cfg.token, 'cfg-token-456');
});

test('resolveConfig: missing env AND config token still fatals', () => {
  assert.throws(
    () => resolveConfig({ task: 'vi-1' }, { PA_HOME: NO_PA_HOME }),
    /PA_SCREENCAST_INGEST_TOKEN is not set and ~\/.pa\/config\.yaml has no screencast_ingest_token/
  );
});

test('resolveConfig: config fallback for cdp-port when env is unset', () => {
  const cfg = resolveConfig(
    { task: 'vi-1' },
    { PA_HOME: fixturePaHome(), PA_SCREENCAST_INGEST_TOKEN: 'tok' }
  );
  assert.equal(cfg.cdpPort, 9333); // config cdp_port beats the 9222 default
  assert.equal(cfg.viPort, 8787); // VI port never scans config (spec S4)
});
