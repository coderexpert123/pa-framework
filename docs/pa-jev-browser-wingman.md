# jev-browser-wingman and PA

How PA consumes `jev-browser-wingman`, an open-source-destined browser step tool that lives in its own repository and ships as an npm package.

## What it is

`jev-browser-wingman` is a companion MCP server and CLI. An agent may hand one bounded step on the already-open page to its `wingman_do` or `wingman_check` tools. The tool attaches to the running Chrome over CDP, never navigates and never opens tabs. It refuses sensitive surfaces (sign-in, banking, mail, and the configured host list) and returns `needs_confirmation` before any submit-like action. Playwright MCP stays the default and the fallback.

## Where it lives and how PA finds it

The package is a separate repository, published to npm. Before publish, an installing agent puts the `jev-browser-wingman` command on PATH (for example `npm link` in a source checkout). PA never imports the package at runtime.

- The plugin module `pa/src/lib/wingman-plugin.ts` is loaded by path through the package's machine-local config. It injects PA's one TypeSafe client, a read-only browser-session lock check and PA logging. It passes no extra sensitive hosts; the config's `sensitive_hosts` is the single source.
- Worker environments carry `PA_BROWSER_SESSION_LOCK_CONTEXT`, so the plugin can tell whether the run holding the browser-session lock is the run asking to act.
- `pa init --provision` adds the wingman MCP entry only when `jev-browser-wingman --version` succeeds; a registration-key collision retries with the existing entry alone.

PA scripts that load package code locate it only through `pa/scripts/wingman_pkg.mjs`. It honours `WINGMAN_PKG_DIR` / `WINGMAN_DIST_DIR` and otherwise resolves the globally installed package. A missing package prints one line naming the env var and exits 3.

## Machine-local config and the mode gate

The package reads one config file in its own home directory (`~/.jev-browser-wingman/config.json`), created by the installing agent. It is machine-local and never synced, so it may hold absolute paths. It pins the Chrome profile directory, the debug port, sensitive hosts and the window mode. Window modes: `offscreen` (default) places a headed window outside every display with anti-throttling flags; `normal`, `minimized` and `headless` are the other values.

## The staged cutover

Each CLI's Playwright MCP registration moves onto the shared Chrome one CLI at a time. A script prepares and checks every stage; each apply is operator-gated.

```
node pa/scripts/wingman_cutover.mjs preflight|snapshot|print-apply|apply|verify|rollback --client <claude|codex|opencode|agy|devin>
```

- `preflight` checks the entry, the profile and the absence of foreign Chrome holders.
- `snapshot` stores the entry and a cookie count; cookie values and domains are never written.
- `print-apply` shows the exact before/after diff the operator approves.
- `apply` rewrites the registration and refuses without an approval note.
- `verify` re-checks the wrapped entry, the doctor verdict and the default context; `rollback` restores the snapshot.

The wrap rule: the Playwright entry's command becomes `jev-browser-wingman with-chrome -- <original command>`, so the wrapper ensures the shared Chrome on the same profile, then forwards. Cookies survive because a CDP attach uses the browser's default context, and closing a CDP-attached browser only disconnects.

## Eligibility estimate

`node pa/scripts/wingman_eligibility.mjs` reads Chrome history and PA turn traces and prints one JSON object estimating what share of past navigations was sensitive. Output is aggregate counts and shares only; no URL, host or path appears.

## Gotchas

- Chrome 136+ ignores the remote-debugging port on its default user-data dir; the port never binds. Always use a dedicated profile directory.
- The shared Chrome starts at the first browser tool call, in an off-screen window by default. A `minimized` window stalls Playwright clicks (screenshots still work); keep the default.
- To see the off-screen window, activate it from the taskbar and maximise it (Win+Up). This path is a suggestion, not a verified procedure.
- Chrome saves the window position in the profile, so a later launch without a position flag — PA's own launcher included — can open mostly off-screen.
- While only some CLIs are wrapped, an unwrapped CLI's Playwright MCP cannot launch its own Chrome while the shared Chrome runs: Chrome allows one process per profile.
- `pa browser stop` and PA's headless-mode relaunch sweep every Chrome on the profile, including one that interactive sessions share.

## Related docs

- `docs/WORKERS_GUIDE.md` — the worker-facing bullet and the browser automation section.
