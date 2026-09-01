# Development Guide

Working on the framework itself: building the packages, running the test suites, and sharing one checkout across several terminals or AI agents. The full multi-session protocol — path reservations, git discipline, clobber recovery — lives in [docs/multi-session-protocol.md](multi-session-protocol.md).

## Building

The two TypeScript packages build independently, each in place:

```bash
cd pa && npm install && npm run build && cd ..
cd projects/telegram-bot && npm install && npm run build && cd ../..
```

`pa/scripts/build.mjs` and the bot's copy compile each package into its own `dist/`. Both take the `@build` reservation described below before they run.

## Running tests

```bash
cd pa && npm test                        # full pa suite
cd projects/telegram-bot && npm test     # full bot suite
npm test -- build-lock                   # one file, matched by basename
npm run test:quarantined                 # only quarantined tests
```

- Tests execute from each package's compiled `dist/`, so build first after changing source.
- A positional filter matches a test file's basename. Quarantined files are never run by name — use `npm run test:quarantined` for those.
- The runner fails the suite if any test file reports zero tests (the "dark file" guard). A silently skipped file reads as a failure, never as a pass.
- Prefer the package's own `npm test` over a hand-built `node --test` command. The wrapper preloads a setup file that isolates tests from a real `~/.pa` installation.
- The spawned tests' `TMP`/`TEMP` point at `PA_TEST_TMP_DIR` when that directory exists — see [docs/CONFIGURATION.md](CONFIGURATION.md) if your system temp sits on a slow disk.

## Builds and tests serialize automatically (`@build`)

`npm run build` and `npm test`, in both packages, acquire a shared `@build` reservation before running and release it when done. If another build or test run already holds it, yours prints `waiting for @build (held by ...)` and continues on its own once the holder finishes. That line is the coordination working, not a hang.

One lock covers both because a test suite reads `dist/` for its entire run. A concurrent build could rewrite the tree underneath it.

Behavior at current defaults:

- The wait polls up to 15 minutes, then proceeds **without** the lock and says so. A stale reservation degrades serialization; it never blocks work indefinitely.
- Coordination is a no-op before `pa init` (`~/.pa` absent) or before `pa/dist` exists. A fresh clone and CI therefore never claim anything.
- `PA_BUILD_LOCK=0` skips the reservation. Use it for scoped runs inside an orchestrated batch of agents, where several builders would otherwise serialize behind one another — never for a full suite or a pre-push gate.

Full rationale and rules: [docs/multi-session-protocol.md](multi-session-protocol.md) Rule 4. Every knob: [docs/CONFIGURATION.md](CONFIGURATION.md), "Resource tuning env vars".

## Several agents, one checkout

The CLI ships the primitives for running multiple AI agents or terminals against one working tree:

- `pa claims` — list active path reservations plus everything modified in the last 15 minutes.
- `pa claim <paths> --session <label> --note "<what you are doing>"` — reserve the files you are about to edit. `pa release <id>` frees one early. Reservations are advisory, expire on their own, and a conflicting claim exits non-zero naming the holder.

When more than one agent edits concurrently, read [docs/multi-session-protocol.md](multi-session-protocol.md) end to end before relying on reservations alone.
