import { join } from 'path';
import { paHome } from '../paths.js';
import { loadConfig } from '../config.js';
import {
  ensureBrowserChrome,
  stopBrowserChrome,
  DEFAULT_BROWSER_CDP_PORT,
} from '../lib/browser-launcher.js';

/**
 * `pa browser ensure [--headed|--headless] [--port N]` — launch or attach PA's
 * CDP Chrome and print the handle as JSON on stdout. This is the task-lane
 * entry point (AI-246 v4): workers call it before their first browser action,
 * the bot pre-injects PLAYWRIGHT_MCP_CDP_ENDPOINT into every dispatch, and the
 * port probe makes the call idempotent — a second ensure reuses the first's
 * Chrome. Chrome persists after the command exits (detached + unref'd); the
 * credential profile accumulates across tasks.
 *
 * The command NEVER takes the `skill-exclusive:browser-session` blackboard
 * lock (spec S1: a CLI that exits stops heartbeating and the row goes stale
 * within ~13 min anyway). The lock stays owned by `pa run`; ensure only reads
 * it to refuse a mode-mismatch relaunch while a run is live.
 *
 * Exit codes: 0 success, 1 failure, 2 argument parse error.
 * On failure a {"ok":false,"error":...} line is printed so stdout stays
 * JSON-parseable either way.
 */
export async function browserEnsureCommand(args: string[] = []): Promise<void> {
  if (args.includes('--headed') && args.includes('--headless')) {
    console.error('Usage: pa browser ensure [--headed|--headless] [--port N]');
    process.exitCode = 2;
    return;
  }
  const mode: 'headed' | 'headless' = args.includes('--headless') ? 'headless' : 'headed';

  let portOverride: number | undefined;
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1) {
    const n = parseInt(args[portIdx + 1] ?? '', 10);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      console.error('Error: --port requires a valid port number (1024-65535)');
      process.exitCode = 2;
      return;
    }
    portOverride = n;
  }

  // Config supplies the default port; a missing/broken config only fails the
  // command when no explicit --port was given.
  let configPort: number | undefined;
  try {
    configPort = (await loadConfig()).browser?.cdp_port;
  } catch (err) {
    if (portOverride === undefined) throw err;
  }
  const port = portOverride ?? configPort ?? DEFAULT_BROWSER_CDP_PORT;

  try {
    const handle = await ensureBrowserChrome({
      port,
      profileDir: join(paHome(), 'browser-profile'),
      mode,
    });
    console.log(JSON.stringify({
      ok: true,
      endpoint: handle.endpoint,
      port: handle.port,
      pid: handle.pid ?? null,
      mode: handle.mode,
      startedByUs: handle.startedByUs,
      modeOverride: handle.modeOverride === true,
    }));
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
    process.exitCode = 1;
  }
}

/**
 * `pa browser stop` — kill the Chrome recorded in ~/.pa/browser-chrome.pid
 * (PID tree only, never by image name — D6) and print {"ok":true,"killed":[pids]}.
 * Chrome normally persists across tasks; this is the manual teardown for
 * freeing the port / resetting the profile session.
 */
export async function browserStopCommand(): Promise<void> {
  const killed = await stopBrowserChrome();
  console.log(JSON.stringify({ ok: true, killed }));
}
