/**
 * test-env-scrub.ts — deployment-env scrub for test spawns (AI-199, 2026-09-03).
 *
 * `pa run` injects every secrets.env value into LLM-worker environments, so any
 * test run executed from inside a worker shell (the push skill's gate is the
 * live case) inherits the operator's deployment config as process.env. Runtime
 * code reads some of those values and changes EXTERNALLY-VISIBLE behavior:
 * with PA_RICH_MESSAGES=1 inherited, worker replies went out over
 * /sendRichMessage instead of /sendMessage and the identical 12 subtests
 * failed on every gate run — while local shells and CI (neither of which has
 * secrets.env) stayed green. Investigation + evidence recorded internally
 * (2026-09-03 push-gate env investigation).
 *
 * Policy: the suite is only ever verified on CI WITHOUT these variables set,
 * so stripping them from the spawned suite's environment makes gate runs
 * measure the same behavior CI measures. It cannot break the suite (CI-parity
 * argument) and never touches operational vars the runners themselves pass
 * down (PA_BUILD_LOCK, PA_ALLOW_STALE_DIST, PA_TEST_TMP_DIR).
 *
 * Loaded at runtime by both run-tests.mjs wrappers via their CJS loader from
 * pa/dist; a missing compiled module (pre-build bootstrap) runs unscrubbed,
 * the same fallback policy as the @build lock loader.
 *
 * When adding a variable here: name the read-site in a comment, and remember
 * tests that need a value set it themselves (in-process assignment beats any
 * inherited value).
 */
export const DEPLOYMENT_ENV_SCRUB: readonly string[] = [
  // rich-message.ts shouldUseRichMessage — reply ROUTING (/sendRichMessage vs
  // /sendMessage). CONFIRMED mechanism of the AI-199 gate failures.
  'PA_RICH_MESSAGES',
  // callbacks.ts — operator-gated buttons would be ALLOWED if inherited.
  'PA_OPERATOR_USER_ID',
  // Bot token fallbacks; tests always pass their own token explicitly.
  'TELEGRAM_BOT_TOKEN',
  // Allowed-chat-id parsing (multi-chat gating).
  'TELEGRAM_CHAT_ID',
  // Alert routing targets (notify.ts).
  'PA_ALERTS_CHAT_ID',
  // Prompt identity content (context.ts).
  'PA_USER_NAME',
  // context.ts KB pointer injection.
  'PA_KB_SOURCES_PATH',
  // typesafe-client.ts resolveTypeSafeApiKey — an inherited real key would let
  // a test reach the live TypeSafe API; tests pass their own apiKey.
  'TYPESAFE_API_KEY',
  // typesafe-client.ts typeSafeBaseUrl — a test-only stub-server seam.
  'TYPESAFE_BASE_URL',
  // Session-identity markers (2026-09-17): detectBusProvider reads these to
  // pick the provider — a suite launched inside a real session inherits them
  // and every `pa claim`/`whoami` then resolves an image provider, paying a
  // full Get-CimInstance process snapshot per call (claim-command's
  // non-numeric --wait test ran 2-4.6s vs its 2s budget under load). CI never
  // has them; tests that need one set it in-process.
  'CHISEL_SESSION_DB',   // detectBusProvider → 'devin'
  'CLAUDECODE',        // detectBusProvider → 'claude'
  'KGCLAUDE_SESSION',  // detectBusProvider → 'kgclaude' (outranks CLAUDECODE)
  'ANTIGRAVITY_AGENT', // detectBusProvider → 'agy'
  'CODEX_CLI_PATH',    // detectBusProvider → 'codex'
  'OPENCODE',          // detectBusProvider → 'opencode'
  'GEMINI_SESSION_ID', // detectBusProvider → 'gemini' (deprecated CLI, still read)
  'GEMINI_CLI_PATH',   // detectBusProvider → 'gemini'
  'PA_WORKER',         // detectBusProvider provider override + worker exec env
  'PA_BUS_PROVIDER',   // detectBusProvider top-of-chain override
  'PA_BUS_ADDRESS',    // resolveSessionBusAddress pin
  'PA_BUS_SESSION',    // resolveSessionBusAddress session key
  'PA_BUS_REPO',       // resolveSessionBusAddress repo override
  'PA_SESSION',        // claim.ts session fallback + bus session key
  'PA_WORKER_DISPATCH_ID', // claim.ts dispatchId/pid auto-fill
  'PA_TASK_ID',        // claim.ts taskId auto-fill
];

/** Return a copy of `env` with every deployment-config variable removed. */
export function stripDeploymentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of DEPLOYMENT_ENV_SCRUB) delete out[key];
  return out;
}
