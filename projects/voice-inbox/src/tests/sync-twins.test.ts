/**
 * Twin-sync tests (AI-201 WP-F, 2026-09-06; extended AI-220 WP-A,
 * 2026-09-10): the app carries hand-duplicated shared texts that no build
 * step reconciles —
 *
 *   1. the timeline fallback strings, owned by src/contracts.ts
 *      `EVENT_FALLBACK` and duplicated verbatim in public/app.js (the PWA has
 *      no build step, so the client carries the one allowed copy);
 *   2. the target-topic injection text, which exists in TWO codebases by
 *      design: `buildTargetInjectionText` (src/bridge-writer.ts, API reroute)
 *      and `TARGET_INJECTION_TEMPLATE` (scripts/route_task.py, worker
 *      decisions);
 *   3. the answer-pointer sentence (auth broker Phase A, §3.7(b)):
 *      `buildAnswerPointerText` (src/bridge-writer.ts) and the pointer line
 *      inside `task_input.py`'s `cmd_check` (python owner, unchanged).
 *   4. the shell version: `SHELL_VERSION` in public/app.js must equal the
 *      version inside `SHELL_CACHE` in public/sw.js — the SSE stale-shell
 *      handshake (vi-7790f35108f8) compares the declared client version
 *      against the on-disk cache name, so a drift misjudges every client.
 *   5. the thread status words: `THREAD_STATUS_TEXT` in public/app.js must equal
 *      `THREAD_STATUS_WORDS` in src/thread-status.ts (thread lifecycle, 2026-09-17).
 *
 * Extraction mirrors the python precedent in tests/test_worker_scripts.py,
 * which byte-syncs its copies against src/ledger.ts. Editing one side of
 * any pair without the other fails here — extend the interpolation map in
 * the second test if the TS expression list grows.
 *
 * A shared text segment must go in as a `${}` interpolation INSIDE the
 * backtick literal — never as a `+`-joined call sitting outside the
 * backticks (AI-conversation-context §1.4, 2026-09-10). The extraction
 * regex below (`` `((?:[^`\\]|\\.)*)`|\$\{([^}]+)\}` ``) only matches
 * backtick literals and `${}` interpolations; a bare `someCall(x) +` between
 * backticks matches neither alternative and is silently skipped, so the two
 * languages could diverge with a green pin.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_FALLBACK, TASK_EVENT_KINDS, NOTIF_BODY_MAX } from '../contracts.js';
import { buildAttachmentsSegment, buildAnswerPointerText } from '../bridge-writer.js';
import { TASK_STATES } from '../ledger.js';
import { THREAD_STATUS_TOKENS, THREAD_STATUS_WORDS } from '../thread-status.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function readSource(relativePath: string): string {
  return readFileSync(join(PKG_ROOT, relativePath), 'utf8');
}

describe('sync twins: hand-duplicated shared text stays byte-equal', () => {
  it('public/app.js EVENT_FALLBACK copy byte-equals the src/contracts.ts map', () => {
    const contractsSource = readSource(join('src', 'contracts.ts'));
    const appSource = readSource(join('public', 'app.js'));

    const tsBody = /export const EVENT_FALLBACK: Record<TaskEventKind, string> = \{([\s\S]*?)\};/.exec(
      contractsSource
    )?.[1];
    const clientBody = /\nconst EVENT_FALLBACK = \{([\s\S]*?)\};/.exec(appSource)?.[1];
    assert.ok(tsBody, 'EVENT_FALLBACK literal not found in src/contracts.ts');
    assert.ok(clientBody, 'EVENT_FALLBACK literal not found in public/app.js');

    // The two copies must be byte-identical, not merely semantically equal:
    // a wording drift in one timeline fallback would silently change what the
    // operator reads depending on which copy renders.
    assert.equal(clientBody, tsBody, 'public/app.js EVENT_FALLBACK drifted from src/contracts.ts');

    // And the map stays complete against the live vocabulary.
    assert.equal(Object.keys(EVENT_FALLBACK).length, TASK_EVENT_KINDS.length);
    for (const kind of TASK_EVENT_KINDS) {
      assert.ok(
        EVENT_FALLBACK[kind].length > 0,
        `EVENT_FALLBACK[${kind}] must stay a non-empty fallback string`
      );
    }
  });

  it('route_task.py TARGET_INJECTION_TEMPLATE renders byte-equal to buildTargetInjectionText', () => {
    // --- python side: join the template's double-quoted literals in order ----
    const pySource = readSource(join('scripts', 'route_task.py'));
    const pyParenBody = /TARGET_INJECTION_TEMPLATE = \(([\s\S]*?)\)\n/.exec(pySource)?.[1];
    assert.ok(pyParenBody, 'TARGET_INJECTION_TEMPLATE block not found in scripts/route_task.py');

    const pyLiterals: string[] = [];
    for (const match of pyParenBody.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      pyLiterals.push(match[1].replace(/\\(.)/g, '$1'));
    }
    assert.ok(pyLiterals.length > 0, 'no string literals parsed from the python template');
    const pyTemplate = pyLiterals.join('');

    // --- TS side: walk the return expression, literal / interpolation -------
    const tsSource = readSource(join('src', 'bridge-writer.ts'));
    const fnBody =
      /export function buildTargetInjectionText\([\s\S]*?\): string \{([\s\S]*?)\n\}/.exec(tsSource)
        ?.[1];
    assert.ok(fnBody, 'buildTargetInjectionText not found in src/bridge-writer.ts');
    const returnExpr = /return \(([\s\S]*)\);/.exec(fnBody)?.[1];
    assert.ok(returnExpr, 'return expression not found in buildTargetInjectionText');

    const INTERP_MAP: Record<string, string> = {
      'input.taskId': 'TASK',
      'input.reason': 'REASON',
      'input.requestText': 'REQUEST',
      'briefing': 'BRIEFING',
      'framing': 'FRAMING',
      'attachments': 'ATTACHMENTS',
    };
    function mapInterpolation(expr: string): string {
      const trimmed = expr.trim();
      if (INTERP_MAP[trimmed] !== undefined) return INTERP_MAP[trimmed];
      const script = /^joinPath\(dir,\s*'([^']+)'\)$/.exec(trimmed);
      if (script) return `SCRIPTS/${script[1]}`;
      throw new Error(
        `unknown interpolation in buildTargetInjectionText: "${trimmed}" — ` +
          'extend the sync-twins interpolation map'
      );
    }

    let tsTemplate = '';
    // ${...} interpolations sit INSIDE the backtick literals, so each literal
    // is itself split into text runs and mapped interpolations, in order.
    for (const match of returnExpr.matchAll(/`((?:[^`\\]|\\.)*)`|\$\{([^}]+)\}/g)) {
      if (match[1] !== undefined) {
        let last = 0;
        for (const part of match[1].matchAll(/\$\{([^}]+)\}/g)) {
          tsTemplate += match[1].slice(last, part.index ?? 0).replace(/\\([`$\\])/g, '$1');
          tsTemplate += mapInterpolation(part[1]);
          last = (part.index ?? 0) + part[0].length;
        }
        tsTemplate += match[1].slice(last).replace(/\\([`$\\])/g, '$1');
      } else if (match[2] !== undefined) {
        tsTemplate += mapInterpolation(match[2]);
      }
    }
    assert.ok(tsTemplate.length > 0, 'no template segments parsed from the TS side');

    // --- normalize both to the same placeholder alphabet and compare ---------
    const normalizePython = (text: string): string =>
      text
        .replaceAll('{repo}/projects/voice-inbox/scripts/', 'SCRIPTS/')
        .replaceAll('{task_id}', 'TASK')
        .replaceAll('{reason}', 'REASON')
        .replaceAll('{request_text}', 'REQUEST')
        .replaceAll('{briefing}', 'BRIEFING')
        .replaceAll('{framing}', 'FRAMING')
        .replaceAll('{attachments}', 'ATTACHMENTS');

    const pyNorm = normalizePython(pyTemplate);
    assert.ok(
      !/\{[a-z_]+\}/.test(pyNorm),
      `unmapped python placeholder remains: ${/\{[a-z_]+\}/.exec(pyNorm)?.[0]}`
    );
    assert.equal(
      tsTemplate,
      pyNorm,
      'route_task.py and bridge-writer.ts render different target injection texts'
    );
  });

  it('buildAnswerPointerText renders byte-equal to task_input.py\'s check pointer line', () => {
    // --- python side: the cmd_check answered-branch print's f-string pair ---
    const pySource = readSource(join('scripts', 'task_input.py'));
    const pyMatch = /print\(f"([^"]*)"\n\s*"([^"]*)"\)/.exec(pySource);
    assert.ok(pyMatch, 'answered-branch pointer print not found in scripts/task_input.py');
    const pyNorm = (pyMatch[1] + pyMatch[2])
      .replaceAll("{request['request_id']}", 'REQ')
      .replaceAll("{request['answer_pointer']}", 'PTR');
    assert.ok(!/\{[a-z_[\]']+\}/.test(pyNorm), `unmapped python placeholder remains: ${pyNorm}`);

    // --- TS side: buildAnswerPointerText's template literal -----------------
    const tsSource = readSource(join('src', 'bridge-writer.ts'));
    const tsMatch = /export function buildAnswerPointerText\([\s\S]*?\{\s*return `([^`]*)`;/.exec(tsSource);
    assert.ok(tsMatch, 'buildAnswerPointerText not found in src/bridge-writer.ts');
    const tsNorm = tsMatch[1]
      .replaceAll('${input.requestId}', 'REQ')
      .replaceAll('${input.answerPointer}', 'PTR');
    assert.ok(!/\$\{[^}]+\}/.test(tsNorm), `unmapped TS interpolation remains: ${tsNorm}`);

    assert.equal(
      tsNorm,
      pyNorm,
      'buildAnswerPointerText and task_input.py render different answer-pointer sentences'
    );

    // And the live render, as an independent check on the actual function
    // (not just its parsed source).
    assert.equal(
      buildAnswerPointerText({ requestId: 'ir-0123456789ab', answerPointer: '/tmp/x/ir-0123456789ab.txt' }),
      'Answer for ir-0123456789ab is at /tmp/x/ir-0123456789ab.txt — read it; never repeat its value in chat.'
    );
  });

  it('buildAttachmentsSegment renders byte-equal to route_task.py build_attachments_segment', () => {
    // Shared wording: the suffix const, extracted from BOTH sources the same
    // way the TARGET_INJECTION_TEMPLATE test extracts its literals.
    const tsSource = readSource(join('src', 'bridge-writer.ts'));
    const tsSuffix = /export const ATTACHMENTS_SEGMENT_SUFFIX =\s*'([^']*)';/.exec(tsSource)?.[1];
    assert.ok(tsSuffix, 'ATTACHMENTS_SEGMENT_SUFFIX not found in src/bridge-writer.ts');
    const pySource = readSource(join('scripts', 'route_task.py'));
    const pyParen = /ATTACHMENTS_SEGMENT_SUFFIX = \(([\s\S]*?)\)\n/.exec(pySource)?.[1];
    assert.ok(pyParen, 'ATTACHMENTS_SEGMENT_SUFFIX block not found in scripts/route_task.py');
    const pySuffix = [...pyParen.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1].replace(/\\(.)/g, '$1')).join('');
    assert.ok(pySuffix.length > 0, 'no literals parsed from the python suffix');
    assert.equal(tsSuffix, pySuffix, 'attachments segment wording drifted between TS and python');

    // Golden path lists against the live TS render (the python twin's golden
    // render is pinned python-side in tests/test_worker_scripts.py).
    assert.equal(buildAttachmentsSegment([]), '');
    assert.equal(
      buildAttachmentsSegment(['D:/x/a.png', 'D:/x/b.mp4']),
      'Attachments (2): D:/x/a.png; D:/x/b.mp4. Open them from disk when the task needs them; ' +
        'audio or video attachments can be transcribed with transcribe_voice.py. '
    );
  });

  it('public/app.js SHELL_VERSION equals sw.js SHELL_CACHE version (vi-7790f35108f8)', () => {
    // The SSE stale-shell handshake keys off the client's declared SHELL_VERSION;
    // a drift from sw.js's actual SHELL_CACHE version would make every current
    // client look stale (or every stale one look current) to the server's replay.
    const appVersion = /const SHELL_VERSION = '(v\d+)';/.exec(readSource(join('public', 'app.js')))?.[1];
    const swVersion = /const SHELL_CACHE = 'voice-inbox-shell-(v\d+)';/.exec(readSource(join('public', 'sw.js')))?.[1];
    assert.ok(appVersion, 'SHELL_VERSION constant not found in public/app.js');
    assert.ok(swVersion, 'SHELL_CACHE declaration not found in public/sw.js');
    assert.equal(
      appVersion,
      swVersion,
      'public/app.js SHELL_VERSION drifted from public/sw.js SHELL_CACHE — the stale-shell replay would misjudge every client'
    );
  });

  it('NOTIF_BODY_MAX literal is the same in contracts.ts, public/app.js and public/sw.js (vi-77c9ccd3865e)', () => {
    // The notification preview cap exists once per no-build-step surface; a
    // drift would clip the same notification at different lengths depending
    // on which copy ran.
    const re = /NOTIF_BODY_MAX = (\d+)/;
    const contracts = re.exec(readSource(join('src', 'contracts.ts')))?.[1];
    const app = re.exec(readSource(join('public', 'app.js')))?.[1];
    const sw = re.exec(readSource(join('public', 'sw.js')))?.[1];
    assert.ok(contracts && app && sw, 'NOTIF_BODY_MAX literal missing in one of contracts.ts / app.js / sw.js');
    assert.equal(Number(contracts), NOTIF_BODY_MAX);
    assert.equal(app, contracts, 'public/app.js NOTIF_BODY_MAX drifted from src/contracts.ts');
    assert.equal(sw, contracts, 'public/sw.js NOTIF_BODY_MAX drifted from src/contracts.ts');
  });

  it('public/app.js STATE_TEXT keys pin exactly to src/ledger.ts TASK_STATES (AI-219)', () => {
    // The PWA's STATE_TEXT is a hardcoded 9-key object literal duplicating the
    // ledger's TASK_STATES vocabulary. The PWA has no build step, so a new
    // state added to the ledger would render as the generic UNKNOWN_STATE_TEXT
    // ('Working') on every client until someone remembers to extend STATE_TEXT
    // — and a state removed from the ledger would leave a dead key. Pin the key
    // sets exactly: same states, no extra, no missing.
    const appSource = readSource(join('public', 'app.js'));
    const stateTextBody = /\nconst STATE_TEXT = \{([\s\S]*?)\};/.exec(appSource)?.[1];
    assert.ok(stateTextBody, 'STATE_TEXT literal not found in public/app.js');
    const clientStates = new Set(
      [...stateTextBody.matchAll(/^\s*([A-Za-z_]+):/gm)].map((m) => m[1])
    );
    assert.ok(clientStates.size > 0, 'no keys parsed from public/app.js STATE_TEXT');

    const ledgerSource = readSource(join('src', 'ledger.ts'));
    const taskStatesBody = /export const TASK_STATES = \[([\s\S]*?)\] as const;/.exec(
      ledgerSource
    )?.[1];
    assert.ok(taskStatesBody, 'TASK_STATES literal not found in src/ledger.ts');
    const ledgerStates = new Set(
      [...taskStatesBody.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1])
    );
    assert.ok(ledgerStates.size > 0, 'no entries parsed from src/ledger.ts TASK_STATES');

    // Cross-check the parsed ledger list against the live export, so a future
    // refactor (e.g. moving TASK_STATES to contracts.ts) can't silently leave
    // the regex matching a stale copy.
    assert.deepEqual(
      [...ledgerStates].sort(),
      [...TASK_STATES].sort(),
      'parsed src/ledger.ts TASK_STATES does not match the live export'
    );

    assert.deepEqual(
      [...clientStates].sort(),
      [...ledgerStates].sort(),
      'public/app.js STATE_TEXT keys drifted from src/ledger.ts TASK_STATES — ' +
        `client has [${[...clientStates].join(', ')}], ledger has [${[...ledgerStates].join(', ')}]`
    );
  });

  it('public/app.js THREAD_STATUS_TEXT byte-equals src/thread-status.ts THREAD_STATUS_WORDS (thread lifecycle)', () => {
    // The server derives the thread status token; the PWA only maps the token
    // to a word. Both the key set and every word must match, or the router
    // offer and the screen would name one status two ways.
    const appSource = readSource(join('public', 'app.js'));
    const statusSource = readSource(join('src', 'thread-status.ts'));
    const clientBody = /\nconst THREAD_STATUS_TEXT = \{([\s\S]*?)\};/.exec(appSource)?.[1];
    const serverBody = /export const THREAD_STATUS_WORDS: Readonly<Record<ThreadStatusToken, string>> = \{([\s\S]*?)\};/.exec(statusSource)?.[1];
    assert.ok(clientBody, 'THREAD_STATUS_TEXT literal not found in public/app.js');
    assert.ok(serverBody, 'THREAD_STATUS_WORDS literal not found in src/thread-status.ts');
    const parse = (body: string): Record<string, string> =>
      Object.fromEntries([...body.matchAll(/^\s*([a-z_]+): '([^']*)',?$/gm)].map((m) => [m[1], m[2]]));
    const client = parse(clientBody);
    const server = parse(serverBody);
    assert.deepEqual(Object.keys(server), [...THREAD_STATUS_TOKENS], 'parsed THREAD_STATUS_WORDS keys drifted from the live THREAD_STATUS_TOKENS export');
    assert.deepEqual(server, { ...THREAD_STATUS_WORDS }, 'parsed THREAD_STATUS_WORDS does not match the live export');
    assert.deepEqual(client, server, 'public/app.js THREAD_STATUS_TEXT drifted from src/thread-status.ts THREAD_STATUS_WORDS');
  });
});
