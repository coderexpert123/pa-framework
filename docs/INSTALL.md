# Install

One page to hand to your AI assistant. It installs this framework on your
computer, asks before it touches anything you already have, and tells you what
it did.

- **Section 1 is for you** — plain language, nothing technical.
- **Sections 2–5 are for the AI assistant** that performs the install. It
  follows the steps in order and checks the result of each one.

---

## 1. What you are installing (read this, or have your assistant read it aloud)

<!-- user-facing -->

This framework lets you run your own helper software on your own computer.
You talk to it in a chat app or on the command line, and it does recurring
jobs for you: reminders, digests of your mail, and any routine you describe
as a short instruction file. One copy of your instructions can run on any of
several popular AI command-line helpers, so if one is busy or rate-limited,
another does the work.

What it needs: a computer you keep switched on, the free Node.js runtime
(version 22 or newer), and at least one supported AI command-line helper. If
you have none yet, the install can set up a free one with you.

What it will not do: it never changes your existing helper settings without
telling you, and it never keeps a change it cannot undo. Every change it
makes is written down in a running list, and one command restores your
previous setup exactly.

Messaging is optional. Without any chat account, everything still works and
answers land as files in a folder on your computer.

Some extra instruction packs (daily summaries, watchguards, and similar
routines) are included but switched off. Nothing runs unless you turn it on.

<!-- /user-facing -->

---

## 2. Agent-facing install runbook

> The installing agent follows this section. Every step has an affirmative
> expected result; if a step fails, deliver the matching failure report from
> its "If it fails" line to the user verbatim, then stop. Do not skip ahead.

### 2.1 Prerequisite probes (run all, report all)

| # | Probe | Command (PowerShell) | Command (POSIX) | Expected result |
|---|---|---|---|---|
| P1 | OS | `$PSVersionTable.OS` / `%OS%` | `uname -s` | Windows, macOS, or Linux — all three supported |
| P2 | Node | `node --version` | `node --version` | first line starts with `v22.` or higher (`v23.`, `v24.` fine) |
| P3 | Python (optional) | `python --version` | `python3 --version` | `Python 3.11` or higher; absence is a WARN, not a stop (only Python-based sample skills need it) |
| P4 | Worker CLIs on PATH | `where.exe claude,codex,opencode,devin 2>$null` | `for c in claude codex opencode devin; do command -v $c; done` | prints at least one hit, or nothing — either outcome is fine; the ladder (§3) adapts |

If P2 fails: **"Your computer needs a free update named Node.js version 22 or
newer before this can be installed. Say the word and I will guide you
through getting it."**
If P4 finds nothing: expected — say **"I did not find a helper app on this
machine yet. I can set up a free one during install."**

### 2.2 Ordered steps

**S1 — Get the code.**

```powershell
git clone https://github.com/coderexpert123/pa-framework.git
cd pa-framework
git log -1 --format=%H
```

```bash
git clone https://github.com/coderexpert123/pa-framework.git
cd pa-framework && git log -1 --format=%H
```

Expected: a 40-character commit id prints. If it fails: **"I could not
download the code. The most common cause is no internet connection — may I
retry?"**

**S2 — Build the two packages.**

```powershell
cd pa; npm install; npm run build; echo "PA_BUILD_EXIT=$LASTEXITCODE"; cd ..
cd projects/telegram-bot; npm install; npm run build; echo "BOT_BUILD_EXIT=$LASTEXITCODE"; cd ../..
```

```bash
(cd pa && npm install && npm run build && echo PA_BUILD_EXIT=0) || echo PA_BUILD_EXIT=1
(cd projects/telegram-bot && npm install && npm run build && echo BOT_BUILD_EXIT=0) || echo BOT_BUILD_EXIT=1
```

Expected: `PA_BUILD_EXIT=0` and `BOT_BUILD_EXIT=0`, and the files
`pa/dist/bin/pa.js` and `projects/telegram-bot/dist/` exist. A Node version
mismatch shows up here as compile errors — re-run probe P2 first. If it
fails: **"The setup step failed while preparing the program. I have saved
the error text so we can look at it together."**

**S3 — Scaffold the runtime home.**

```powershell
node pa/dist/bin/pa.js init
```

```bash
node pa/dist/bin/pa.js init
```

Expected: `~/.pa/config.yaml`, `~/.pa/secrets.env` and `~/.pa/skills/`
now exist, and the command prints a "Next steps" block. If it fails:
**"The first-run setup did not finish. Nothing was changed outside its own
new folder, so retrying is safe."**

**S4 — Provision (runs the capability ladder, §3).** The assistant answers
the ladder's questions WITH the user, one question at a time — never
defaulting past a question.

```powershell
node pa/dist/bin/pa.js init --provision
```

```bash
node pa/dist/bin/pa.js init --provision
```

Expected, all of: a discovery line per CLI found (`claude`, `codex`,
`opencode`, `devin`); the ask flow (§3) completed with real answers; either
`state: configured` with the chosen set, or the exact floor line
`Your assistant runs but can't think yet`; and `~/.pa/outbox/` exists. If
the user declines everything, the floor line IS the success state — do not
treat it as an error. If the command itself fails: **"The part where I
connect things to each other stopped partway. Everything it had changed up
to that point is listed by `pa coexistence list`, and each item can be
undone."**

**S5 — Delivery and secrets floor.** Edit `~/.pa/secrets.env` only if the
user opted into a chat account during the ladder; otherwise skip.
`TELEGRAM_BOT_TOKEN` absent is a WARN in every later check, never a FAIL
(decision D4). Delivery floor: `~/.pa/outbox/` is created by S4 regardless.

**S6 — Health check.**

```powershell
node pa/dist/bin/pa.js health
```

```bash
node pa/dist/bin/pa.js health
```

Expected: `bot-process` and `secrets` rows may show as WARN or FAIL here —
both are Telegram-absence, expected before the bot and token are set up, and
`verify-install` counts them as WARN, never as a failure. Every other row
must be PASS, WARN, or OK; nothing else may FAIL. If a different row fails:
**"The self-check found something it does not like. The report names the
exact row — I will read it to you and we fix that one thing."**

**S7 — Machine profile.** `node pa/dist/bin/pa.js doctor` — expected: the
report includes a `coexistence` block listing every setting PA wrote into
your existing helpers (empty if none yet). A failed probe degrades to
`unknown`, never an error.

**S8 — First real run.** Pick one example skill (`pa list` shows them; all
examples are safe local ones):

```powershell
node pa/dist/bin/pa.js run <skill-name>
```

```bash
node pa/dist/bin/pa.js run <skill-name>
```

Expected: the run completes and a non-empty file appears under
`~/.pa/outbox/` with a modification time after the run started. If it
fails: **"The test run did not produce its output file. I will show you the
run log so we can see where it stopped."**

---

## 3. The capability ladder (what S4 does, in order)

1. **Discover.** Probe PATH for `claude`, `codex`, `opencode`, `devin`;
   probe the environment for provider keys by presence only (never printed).
2. **Ask.** For each found CLI: "you already use X — may the assistant
   connect to it?" Any conflict with an existing setting in your helper's
   configuration stops and asks; nothing is overwritten.
   - **Keys-only branch:** if the user has only an API key plus a provider
     address and no CLI installed, the installer picks a harness that
     accepts that key directly — the key determines the harness, no CLI
     needed first.
   - **Escape hatch:** the ask flow always ends with
     `something else? describe it` — the user describes their setup in
     their own words and the installer maps it to the nearest supported
     shape. The user's answer outranks every default.
3. **Configure.** Chosen CLIs are wired additively. Every edit is
   snapshotted first into `~/.pa/coexistence-registry.json`, is reversible
   with `pa coexistence restore`, and shows up in `pa doctor`'s
   coexistence block. Generated configuration resolves per-OS and contains
   no machine-specific absolute locations.
4. **Preserve ask (once).** "Keep a copy of your assistant's own changes?"
   — yes turns on the git-workflow preserve path (§4).
5. **Degraded floor.** Zero workers connected: the install still completes
   and prints exactly `Your assistant runs but can't think yet` plus the
   hint to add one later and re-run `pa init --provision`. Delivery still
   works: notifications land as files under `~/.pa/outbox/` — no chat
   account required.

Optional disabled-by-default skills: personal-routine extracts (daily
briefing, watchdogs) ship under `examples/skills/` and stay off until the
user enables one explicitly.

## 4. Keeping a copy of the assistant's changes

When the user says yes to the preserve ask, changes are preserved through
the git-workflow skills — never raw git — and are sent to the USER'S OWN
fork, opened as a pull request against the public repository. The main
branch is gated; contributions arrive as pull requests only. The ask-flow
text states this destination; nothing ever pushes directly.

## 5. Final acceptance checklist (the agent runs this itself)

1. `pa health` — every row OK or WARN, except the `bot-process` and
   `secrets` rows, which may show as FAIL on a fresh install (Telegram
   absence, expected before setup); `verify-install` counts those two as
   WARN, never a failure.
2. One example skill fired end-to-end: non-empty outbox file (or chat
   delivery if opted in).
3. One real worker reply, or the verbatim floor message
   `Your assistant runs but can't think yet`.
4. Pre-existing helper configurations are byte-identical to their
   snapshots except the registry's `addedKeys` — `pa coexistence list`
   shows every entry; `pa doctor` agrees.
5. Restore path proven once on a scratch install: `pa coexistence restore`
   returns the file byte-identical.
6. The user-facing report passes the jargon gate:
   `pa docs-lint --jargon <report-file>` prints `jargon findings: 0`.
7. Run `pa verify-install --json` — expected `"verdict": "PASS"`, with
   `"degradedFloor": true` allowed alongside PASS. A FAIL names the failing
   check in `checks[].id` with a plain-language `detail`. The skill probe is
   `--skill <name>`; it defaults to `reminders`, so copy one example pack
   first (`cp -r examples/skills/reminders ~/.pa/skills/`) when the install
   did not already place one.
