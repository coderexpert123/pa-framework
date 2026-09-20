/**
 * relay-setup.test.mjs — pure unit tests for scripts/relay_setup.mjs
 * (edge-relay wave WP-R3). NO network, NO wrangler spawn, NO writes: every
 * case runs the exported pure seams over pinned fixture text, plus the REAL
 * tracked example files (wrangler.toml.example, relay.config.example.json) so
 * the tests consume real producer output, never hand-built stand-ins.
 *
 * Machine rule: this file is plain .mjs registered as a real node:test suite
 * (the dark-file detector fails a zero-test file) — see § Node tests in
 * ~/.claude/machine-notes.md and the repo's scoped-run convention
 * (`PA_BUILD_LOCK=0 npm test -- relay-setup.test.mjs`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  MSG_DUAL_ACCOUNT,
  MSG_HEALTHZ,
  MSG_NOT_LOGGED_IN,
  MSG_OFFLINE,
  MSG_SUBDOMAIN,
  MSG_TOKEN_BAD,
  MSG_TOKEN_PERMS,
  MSG_TOKEN_WRONG_ACCOUNT,
  appendToSecretsEnv,
  buildLiveConfig,
  buildRelayPollerLauncherVbs,
  classifyTokenAuth,
  humanizeWranglerError,
  maskSecret,
  parseDeployUrl,
  parseSecretsValue,
  parseTomlStringField,
  resolveWranglerAuth,
  subdomainMissing,
} from '../../scripts/relay_setup.mjs';

// The no-leaked-child-process check must observe the module RIGHT AFTER its
// first import, before the test runner arms anything of its own — evaluated
// at module scope, asserted inside a test below.
const resourcesAfterImport = process.getActiveResourcesInfo();

test('importing relay_setup.mjs spawns nothing and starts nothing', () => {
  assert.ok(!resourcesAfterImport.includes('ChildProcess'));
  assert.ok(!resourcesAfterImport.includes('TCPSocketWrap'));
  assert.ok(!resourcesAfterImport.includes('Timeout'));
});

// --- buildLiveConfig (real tracked example = real producer output) ----------

test('buildLiveConfig fills name + bucket and leaves every other line byte-identical', () => {
  const exampleText = readFileSync(new URL('../wrangler.toml.example', import.meta.url), 'utf8');
  const out = buildLiveConfig(exampleText, { name: 'my-relay', bucketName: 'my-relay-relay-bucket' });
  const inLines = exampleText.split('\n');
  const outLines = out.split('\n');
  assert.equal(outLines.length, inLines.length, 'line count must not change');
  let changed = 0;
  for (let i = 0; i < inLines.length; i++) {
    if (inLines[i] === outLines[i]) continue;
    changed += 1;
    assert.ok(
      /^name[ \t]*=/.test(inLines[i]) || /^bucket_name[ \t]*=/.test(inLines[i]),
      `unexpected line changed: ${JSON.stringify(inLines[i])}`
    );
  }
  assert.equal(changed, 2);
  assert.ok(outLines.includes('name = "my-relay"'));
  assert.ok(outLines.includes('bucket_name = "my-relay-relay-bucket"'));
});

test('buildLiveConfig preserves CRLF on the replaced lines', () => {
  const crlf = 'name = "old"\r\nmain = "worker.js"\r\nbucket_name = "old-b"\r\n';
  const out = buildLiveConfig(crlf, { name: 'new', bucketName: 'new-b' });
  assert.equal(out, 'name = "new"\r\nmain = "worker.js"\r\nbucket_name = "new-b"\r\n');
});

test('buildLiveConfig rejects a template missing the name/bucket lines', () => {
  assert.throws(() => buildLiveConfig('main = "worker.js"\n', { name: 'x', bucketName: 'y' }), /unusable/);
});

// --- parseDeployUrl -----------------------------------------------------------

test('parseDeployUrl extracts the URL from a realistic deploy stdout', () => {
  const stdout = [
    'Uploaded voice-inbox-relay (2.31 sec)',
    'Deployed voice-inbox-relay triggers (0.62 sec) — currently viewed version',
    '  https://voice-inbox-relay.example-subdomain.workers.dev',
    'Current Version ID: 9f4e0c1a-1111-2222-3333-444444444444',
  ].join('\n');
  assert.equal(
    parseDeployUrl(stdout),
    'https://voice-inbox-relay.example-subdomain.workers.dev'
  );
});

test('parseDeployUrl returns null on a no-URL sample', () => {
  assert.equal(parseDeployUrl('Total Upload: 12 KiB\nnothing here'), null);
  assert.equal(parseDeployUrl(''), null);
  assert.equal(parseDeployUrl(null), null);
});

// --- subdomainMissing ----------------------------------------------------------

test('subdomainMissing detects the pinned subdomain row', () => {
  assert.equal(
    subdomainMissing('✘ [ERROR] A workers.dev subdomain is not configured for this account.'),
    true
  );
  assert.equal(
    subdomainMissing('✘ [ERROR] Something else failed entirely.'),
    false
  );
  assert.equal(subdomainMissing(''), false);
  assert.equal(subdomainMissing(null), false);
});

// --- buildRelayPollerLauncherVbs (2026-09-10 launch-cadence wave, WP-B) ------

const SAMPLE_PKG_DIR = 'C:\\repo\\projects\\voice-inbox';
const SAMPLE_PS1_PATH = 'C:\\repo\\projects\\voice-inbox\\scripts\\relay_start.ps1';
const SAMPLE_LOCK_PATH = 'C:\\Users\\example\\.pa\\voice-inbox\\relay-poller.lock';

test('buildRelayPollerLauncherVbs sets shell.CurrentDirectory before any shell.Run', () => {
  const text = buildRelayPollerLauncherVbs(SAMPLE_PKG_DIR, SAMPLE_PS1_PATH, SAMPLE_LOCK_PATH);
  const cwdIdx = text.indexOf('shell.CurrentDirectory');
  const runIdx = text.indexOf('shell.Run');
  assert.ok(cwdIdx >= 0, 'CurrentDirectory assignment not found');
  assert.ok(runIdx >= 0, 'shell.Run not found');
  assert.ok(cwdIdx < runIdx, 'CurrentDirectory must be set before any shell.Run');
});

test('buildRelayPollerLauncherVbs guards with WScript.Quit 0 before the powershell.exe launch', () => {
  const text = buildRelayPollerLauncherVbs(SAMPLE_PKG_DIR, SAMPLE_PS1_PATH, SAMPLE_LOCK_PATH);
  const quitIdx = text.indexOf('WScript.Quit 0');
  const runIdx = text.indexOf('shell.Run "powershell.exe');
  assert.ok(quitIdx >= 0, 'guard line not found');
  assert.ok(runIdx >= 0, 'powershell.exe launch line not found');
  assert.ok(quitIdx < runIdx, 'the guard must run before spawning powershell.exe');
});

test('buildRelayPollerLauncherVbs bakes the lock path passed in', () => {
  const text = buildRelayPollerLauncherVbs(SAMPLE_PKG_DIR, SAMPLE_PS1_PATH, SAMPLE_LOCK_PATH);
  assert.ok(text.includes(`lockPath = "${SAMPLE_LOCK_PATH}"`));
});

test('buildRelayPollerLauncherVbs carries ReadJsonPid and the double-filtered PidIsLiveNode', () => {
  const text = buildRelayPollerLauncherVbs(SAMPLE_PKG_DIR, SAMPLE_PS1_PATH, SAMPLE_LOCK_PATH);
  assert.ok(text.includes('Function ReadJsonPid(path)'));
  assert.ok(text.includes('Function PidIsLiveNode(pid)'));
  assert.ok(text.includes('/FI ""PID eq'));
  assert.ok(text.includes('/FI ""IMAGENAME eq node.exe""'));
  assert.ok(text.includes('| find /I ""node.exe""'));
  // This file's variable is `shell`, not `WshShell` — the only permitted rename.
  assert.ok(text.includes('shell.Run(cmdText, 0, True)'));
});

test('buildRelayPollerLauncherVbs is CRLF-joined', () => {
  const text = buildRelayPollerLauncherVbs(SAMPLE_PKG_DIR, SAMPLE_PS1_PATH, SAMPLE_LOCK_PATH);
  assert.ok(text.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'every line break must be CRLF, not a bare LF');
});

// --- humanizeWranglerError: each detection row → its message row ---------------

test('humanizeWranglerError maps each failure-table detection row to its pinned message', () => {
  // offline row
  assert.equal(
    humanizeWranglerError('getaddrinfo ENOTFOUND api.cloudflare.com'),
    MSG_OFFLINE
  );
  assert.equal(
    humanizeWranglerError('connect ECONNREFUSED 127.0.0.1:443'),
    MSG_OFFLINE
  );
  // subdomain row
  assert.equal(
    humanizeWranglerError('✘ [ERROR] A workers.dev subdomain is not configured for this account.'),
    MSG_SUBDOMAIN
  );
  // name-taken row
  assert.equal(
    humanizeWranglerError(
      '✘ [ERROR] The worker name "voice-inbox-relay" is already assigned to a different worker.',
      { workerName: 'voice-inbox-relay' }
    ),
    'The worker name "voice-inbox-relay" is taken on your account. Re-run with: node scripts/relay_setup.mjs --name voice-inbox-relay-2'
  );
  // whoami row (generic) vs dual-account row (no CF_RELAY_* pair)
  const notAuthText = '✘ [ERROR] You are not authenticated. Run `wrangler login` to authenticate.';
  assert.equal(humanizeWranglerError(notAuthText), MSG_DUAL_ACCOUNT);
  assert.equal(humanizeWranglerError(notAuthText, { hasTokenPair: true }), MSG_NOT_LOGGED_IN);
  // healthz row is a step-10 condition, not tool text — assert its pinned constant
  assert.equal(
    MSG_HEALTHZ,
    'The relay deployed but is not answering yet (free-tier deploys can lag ~30 s). ' +
      'Wait a minute and re-run — everything else is already done.'
  );
});

test('humanizeWranglerError maps the 403 row to the missing-permissions message in token mode', () => {
  assert.equal(
    humanizeWranglerError('✘ [ERROR] A request to the Cloudflare API failed with status 403', {
      hasTokenPair: true,
    }),
    MSG_TOKEN_PERMS
  );
  assert.notEqual(
    humanizeWranglerError('✘ [ERROR] A request to the Cloudflare API failed with status 403'),
    MSG_TOKEN_PERMS
  );
});

// --- the three pinned token-mode messages (step 2) -----------------------------

test('classifyTokenAuth pins the three token-mode failure messages', () => {
  // machine-proof shape: bogus token → /user/tokens/verify + codes 6003/6111
  const bogusProofText =
    'Fetching credentials...\n' +
    '- /user/tokens/verify\n' +
    '✘ [ERROR] Invalid request headers [code: 6003]\n' +
    'Invalid format for Authorization header [code: 6111]';
  assert.equal(classifyTokenAuth(bogusProofText, 'acct123'), MSG_TOKEN_BAD);
  // authenticated but wrong account (account id absent from output)
  assert.equal(
    classifyTokenAuth('👋 You are logged in with an API Token\n│ Other Account │ ffff0000ffff0000 │', 'acct123'),
    MSG_TOKEN_WRONG_ACCOUNT
  );
  // authenticated AND relay account id present → ok (null)
  assert.equal(
    classifyTokenAuth('👋 You are logged in with an API Token\n│ Relay Acct │ acct123 │', 'acct123'),
    null
  );
  // spawn-level network failure surfaces the offline row
  assert.equal(classifyTokenAuth('spawn npx ENOENT', 'acct123'), MSG_OFFLINE);
  assert.equal(MSG_TOKEN_BAD, 'The relay API token did not authenticate. Check CF_RELAY_API_TOKEN in ' +
    '~/.pa/secrets.env, or re-create it in the Cloudflare dashboard.');
  assert.equal(MSG_TOKEN_WRONG_ACCOUNT, "That API token belongs to a different Cloudflare account. Point CF_RELAY_ACCOUNT_ID at " +
    "the token's account, or create the token on the relay account.");
  assert.equal(MSG_TOKEN_PERMS, 'The relay API token is missing permissions. It needs exactly: Workers Scripts Edit, ' +
    'Workers R2 Storage Edit, Account Settings Read.');
});

// --- appendToSecretsEnv / parseSecretsValue ------------------------------------

test('appendToSecretsEnv appends once and is idempotent on re-run', () => {
  assert.equal(appendToSecretsEnv('', 'VOICE_INBOX_RELAY_SECRET', 'abc'), 'VOICE_INBOX_RELAY_SECRET=abc\n');
  assert.equal(
    appendToSecretsEnv('OTHER=1\n', 'VOICE_INBOX_RELAY_SECRET', 'abc'),
    'OTHER=1\nVOICE_INBOX_RELAY_SECRET=abc\n'
  );
  // no trailing newline in the existing file → one is added, key appended once
  assert.equal(
    appendToSecretsEnv('OTHER=1', 'VOICE_INBOX_RELAY_SECRET', 'abc'),
    'OTHER=1\nVOICE_INBOX_RELAY_SECRET=abc\n'
  );
  // idempotent: key already present → text unchanged, value never rotated
  const once = appendToSecretsEnv('OTHER=1\n', 'K2', 'v2');
  assert.equal(appendToSecretsEnv(once, 'K2', 'DIFFERENT'), once);
  // a commented-out line does not count as present
  assert.equal(appendToSecretsEnv('# K2=commented\n', 'K2', 'v'), '# K2=commented\nK2=v\n');
});

test('parseSecretsValue reads KEY=value lines and skips comments', () => {
  assert.equal(parseSecretsValue('# c\nVOICE_INBOX_RELAY_SECRET=abc\n', 'VOICE_INBOX_RELAY_SECRET'), 'abc');
  assert.equal(parseSecretsValue('K="quoted"', 'K'), 'quoted');
  assert.equal(parseSecretsValue("K='sq'", 'K'), 'sq');
  assert.equal(parseSecretsValue('K=  spaced  \n', 'K'), 'spaced');
  assert.equal(parseSecretsValue('# K=commented\n', 'K'), null);
  assert.equal(parseSecretsValue('', 'K'), null);
});

// --- resolveWranglerAuth (four cases + masking) --------------------------------

test('resolveWranglerAuth returns the token env object when BOTH keys are present (env wins)', () => {
  const token = 'tok-secret-abcd1234';
  const account = 'a1b2c3d4deadbeef00';
  const fromEnv = resolveWranglerAuth({
    env: { CF_RELAY_API_TOKEN: token, CF_RELAY_ACCOUNT_ID: account },
    secretsEnvText: `CF_RELAY_API_TOKEN=fromfile\nCF_RELAY_ACCOUNT_ID=acct2\n`,
  });
  assert.equal(fromEnv.mode, 'token');
  assert.equal(fromEnv.authEnv.CLOUDFLARE_API_TOKEN, token);
  assert.equal(fromEnv.authEnv.CLOUDFLARE_ACCOUNT_ID, account);
  assert.equal(fromEnv.tokenSource, 'environment');

  const fromFile = resolveWranglerAuth({
    env: {},
    secretsEnvText: `CF_RELAY_API_TOKEN=${token}\nCF_RELAY_ACCOUNT_ID=${account}\n`,
  });
  assert.equal(fromFile.mode, 'token');
  assert.equal(fromFile.authEnv.CLOUDFLARE_API_TOKEN, token);
  assert.equal(fromFile.authEnv.CLOUDFLARE_ACCOUNT_ID, account);
});

test('resolveWranglerAuth: neither key → login mode', () => {
  const auth = resolveWranglerAuth({ env: {}, secretsEnvText: '' });
  assert.equal(auth.mode, 'login');
  assert.equal(auth.halfSet, false);
});

test('resolveWranglerAuth: a half-set pair falls back to login mode and never silently deploys', () => {
  const token = 'tok-secret-abcd1234';
  const onlyToken = resolveWranglerAuth({ env: { CF_RELAY_API_TOKEN: token }, secretsEnvText: '' });
  assert.equal(onlyToken.mode, 'login');
  assert.equal(onlyToken.halfSet, true);
  assert.deepEqual(onlyToken.missing, ['CF_RELAY_ACCOUNT_ID']);

  const onlyAccount = resolveWranglerAuth({ env: { CF_RELAY_ACCOUNT_ID: 'acct' }, secretsEnvText: '' });
  assert.equal(onlyAccount.mode, 'login');
  assert.equal(onlyAccount.halfSet, true);
  assert.deepEqual(onlyAccount.missing, ['CF_RELAY_API_TOKEN']);
});

test('resolveWranglerAuth: no return value or log line ever contains the token value outside authEnv', () => {
  // NOTE (spec contradiction, reported to the orchestrator): the spec requires
  // BOTH "returns the token env object" AND "no return value contains the
  // token value" — mutually exclusive when runWrangler needs the raw token.
  // Resolution: the raw token rides ONLY authEnv.CLOUDFLARE_API_TOKEN; every
  // other field, every display string, and login-mode returns never carry it,
  // and all printed output uses maskSecret.
  const token = 'tok-secret-abcd1234';
  const account = 'a1b2c3d4deadbeef00';
  const fromFile = resolveWranglerAuth({
    env: {},
    secretsEnvText: `CF_RELAY_API_TOKEN=${token}\nCF_RELAY_ACCOUNT_ID=${account}\n`,
  });
  const serialized = JSON.stringify(fromFile).replace(`"CLOUDFLARE_API_TOKEN":"${token}"`, '""');
  assert.ok(!serialized.includes(token), 'token must appear only inside authEnv.CLOUDFLARE_API_TOKEN');
  // login-mode returns (incl. half-set) never carry any input value at all
  assert.ok(!JSON.stringify(resolveWranglerAuth({ env: { CF_RELAY_API_TOKEN: token }, secretsEnvText: '' })).includes(token));
  assert.ok(!JSON.stringify(resolveWranglerAuth({ env: {}, secretsEnvText: `CF_RELAY_API_TOKEN=${token}\n` })).includes(token));
  // displayed form masks the token to its last 4 chars
  assert.equal(fromFile.maskedToken, '…' + token.slice(-4));
  assert.ok(!fromFile.maskedToken.includes(token));
  assert.equal(maskSecret(token), '…1234');
});

// --- parseTomlStringField ------------------------------------------------------

test('parseTomlStringField reads the live-config fields', () => {
  assert.equal(parseTomlStringField('name = "a"\nbucket_name = "b"', 'name'), 'a');
  assert.equal(parseTomlStringField('name = "MAILBOX"\nclass_name = "X"', 'class_name'), 'X');
  assert.equal(parseTomlStringField('nope', 'name'), null);
  assert.equal(parseTomlStringField('name = "x"\r\n', 'name'), 'x');
});
