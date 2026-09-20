# Voice-inbox operations (launch & supervision)

Auto-load pointer: `projects/voice-inbox/CLAUDE.md` links here. Extracted under the
brain-file size budget doctrine (`docs/CONVENTIONS.md`, "Brain-file organization") on
2026-09-10. This file covers how the app and its edge relay are launched and kept
running; the scoped brain keeps the request/response contracts.

## Server lifecycle: watchdog, stop, build-staleness self-heal

Server lifecycle — the `server.lock` watchdog, stopping the process, and
build-staleness self-heal — moved to `docs/voice-inbox-server-lifecycle.md`
(split 2026-09-17 under the brain-file size budget doctrine). It covers how
`server.lock` is written and read, the 45-second bind-confirm timeout, and
the single-flight mutex behind it. It also covers how to stop the process
without getting stuck on a non-forceful `taskkill`, and how the watchdog
detects and self-heals a stale build.

## Relay poller overlap (fixed 2026-09-10, commit `6f9208f`)

The edge relay's poller could run more than one live instance at once under load. This
section records the diagnosed mechanism and the fix, so a reader can judge current
behavior from the code itself, not from a status line that may already be out of date.

Root cause: `relay_start.ps1` launched the poller with `Start-Process` and did not wait
for it or register any lock itself, so a new Task Scheduler tick could fire before the
previous tick's node process had reached its own `acquireLock` call. Task Scheduler's
`MultipleInstancesPolicy` (`IgnoreNew`, confirmed on the build machine) only governs the
instantly-exiting `wscript.exe` wrapper — it never sees the detached `powershell`/`node`
chain that wrapper launches, so it gave no real protection against two pollers
overlapping. Under measured disk-starvation cold-start latency (33+ seconds as of
2026-09-10, per that day's disk-saturation investigation), a tick could find no valid
lock entry yet and start a second poller. This was the verified mechanism behind an
observed pile-up of ten concurrent pollers. It was not a bug in `lockIsLive`'s
`process.kill(pid, 0)` check, which was independently confirmed correct against a real
detached child on the same machine.

The fix closes the window at its source instead of racing to detect it afterward.
`relay_start.ps1` now writes `{pid,ts}` to `relay-poller.lock` itself, synchronously,
right after `Start-Process -PassThru` returns the child's PID — before that process has
run a single line — the same shape `run_server.ps1` uses for `server.lock`.
`relay_poller.mjs`'s `acquireLock` recognizes a lock that already names its own PID as
this launcher placeholder, not a foreign holder to contest, and takes ownership instead.

Its lock acquisition (read, then write) is still not atomic, so it now re-reads the file
immediately after writing to catch a concurrent writer that landed after it. Finding its
own PID gone, it correctly reports losing the race rather than believing it holds a lock
it does not. Both halves were proven against a case that failed on the pre-fix code
(reproducing the race) and passes on the fix. Live proof is one poller process matching
the lock file, plus a 200 from the public health endpoint.

## Reading what a worker was actually handed

A conversation briefing is prose the server hands a worker so a bare follow-up like
"make it shorter" does not need to ask what "it" refers to. Whether one actually reached
a worker has to be checked against what was archived, not assumed from the code.

Find the task id for the follow-up first: the ledger's `tasks` table, or the tail of
`~/.pa/voice-inbox/route-queue.jsonl` (the cross-process queue the server writes and the
bot's drain consumes) while the entry is still queued. Then look up that task id in the
permanent conversation archive, `~/.pa/conversation-history.jsonl`, or run `pa recall
"Conversation so far" --json` to search the same archive by content instead of by id.

Read the archived synthetic turn for that task and confirm it opens with a line shaped
`Conversation so far (<conversation id>): <N> earlier turn(s), oldest first.` and
includes at least one `You asked:` line quoting a prior turn, not the follow-up itself.
A turn missing that opening line, or one quoting only the follow-up, means the briefing
never reached the worker — treat that as a routing or budget defect, not a worker
mistake.

## The --summary formatting instruction

The `--summary` guidance inside that same text (2026-09-09 formatting wave) now asks
the worker for plain sentences, a blank line between distinct points, and numbered or
dashed lines for options/steps, with no markdown headings or asterisks. The change
exists because workers had been complying with the old keep-everything wording
literally. Some produced one unbroken line (one answer ran 2,249 chars with zero
newlines), while others left raw `**bold**` that the PWA then displayed as-is.

This is the producer-side half; the PWA's timeline rendering is the
deterministic-renderer half built in parallel. Either alone is a partial fix, since
older queued answers and any consumer other than this PWA still need the sentence/list
shape a renderer would otherwise have to guess at.

The 2026-09-11 wave (operator steer vi-ecb325779906) added a content exclusion:
internal housekeeping (brain upkeep, claims, gate runs, telemetry, coordination
between running sessions) never appears in the operator-facing summary. It is handled
silently in the working session, or raised through the attention channel (`pa ping`)
only when the operator must act. The PWA's collapsed work-log block stays the one
place plumbing text remains visible.

The 2026-09-13 wave (vi-6ff65d97f391) added a second operator-facing output to the
same instruction: alongside `--summary`, workers now pass `--short "<one or two plain
sentences>"` to `task_complete.py`. The short version is a complete standalone summary
of the answer, never a truncated start of the long one.

Funding the new sentence inside the injection template meant compressing the
enumerations already there — the summary, housekeeping and title/recap sentences lost
their example lists. The template must stay under the bot's steer limit; the compressed
text's stress render measures 3942 characters against the 3950 `ROUTE_TEXT_MAX`
ceiling, verified before the edit landed.

`--short` is never capped or trimmed: no stage of the pipeline applies a character
limit to it. The PWA shows the stored value as the IN SHORT lead (markers stripped),
and falls back to its own uncapped deterministic lead for answers completed before
the column existed.

## 2026-09-13 refinement: plain-words short, rich markdown answers

The operator refined the two-version contract by voice (vi-ecbf5d33801a): the short
version is not a one-or-two-sentence summary and carries no word or character target —
it is however many simple sentences it takes to actually explain the answer to an
average non-technical user, written in the product's own terms. The injection sentence
now teaches `--short "<the answer in plain words>"`, and `task_complete.py --short`'s
help text matches.

Answers meanwhile actively use rich markup. The old "no markdown" sentence became
"Format richly for the answer card (it renders markdown)" listing the shapes the card
supports: ### headings, **bold**, - or 1) lists, pipe tables with a |---| separator
row, code fences, [text](url) or bare links. The renderer draws all of these as real
HTML elements, with markdown links restricted to http(s) so `javascript:` URLs stay
literal text. The 2026-09-09 "no markdown" instruction above is superseded from this
wave on.

The answer card follows the device's light or dark setting (2026-09-16). A custom-HTML
answer that fixes its own colours stays readable in only one of the two schemes. Custom HTML
answers should therefore never hard-code colours.

Funding was measured, not found: the plain-words short sentence is +129 chars and the
formatting sentence +106, paid for by compressing six adjacent sentences; the stress
render measures 3917 against the 3950 `ROUTE_TEXT_MAX` ceiling. The measure script
asserted every old string still matched the live template before projecting
(`scratch/measure_route_text_vi_ecbf5d33801a.py` — scratch is gitignored; the SPEC in
`projects/voice-inbox/plans/2026-09-13-inshort-plain-words-rich-html-SPEC.md` carries
the exact strings).

## 2026-09-13 wave: routing fix, renderer inline shapes, re-measured budget

The injection twins (`route_task.py`, `bridge-writer.ts`, and the golden copy in
`test_worker_scripts.py`, pinned byte-identical) now list confirm/yes-no among the
operator-input kinds, so workers learn a yes/no question can be a typed widget, not a
chat stall. The fallback re-dispatch note matches: a worker re-injected by the
deterministic fallback (AI-221) is told that if a prior pass left a yes/no confirmation
pending in chat, it should claim the task and raise the app card via `task_input.py`
(kind confirm), never gate the decision in chat.

With the confirm/yes-no addition funded, the stress render measures 3933 against the
3950 `ROUTE_TEXT_MAX` ceiling — still under, re-verified with the byte-sync suite.

The wave's end state for answers: the 2026-09-09 "no markdown" guidance stays
superseded — the answer card renders rich markdown (### headings, **bold**, - or 1)
lists, pipe tables, code fences, links), and the renderer draws markdown links, inline
code, and table cells inline as real elements rather than leaving the markup literal.

## 2026-09-15 wave: verdict-short, structured answers, steer budget re-funded

The `--short` contract tightened (P0 of the answer-presentation plan): one or two
plain sentences carrying the verdict, not the reasoning. The 2026-09-13
"complete standalone explanation" wording above is superseded, and the
`task_complete.py --short` help text matches the new shape.

`task_complete.py` gained `--structured <json>`: a machine-readable companion to
`--summary` written to `tasks.result_structured` (schema v12). The PWA renders a
labeled-block fallback for it and falls back to markdown when it is NULL or
unparseable. Worker guidance for the flag is a compact pointer to
`task_complete.py --help`, kept short on purpose: the stress render's headroom
under `ROUTE_TEXT_MAX` is back to roughly 20 characters, so future template
growth needs a re-funding pass before it lands.

## Transcription drain: deploy order and a stuck `transcribing` task (2026-09-16)

Voice recordings are transcribed by the telegram bot process, and the bot's route drain holds a voice task's routing entry until the transcript lands. Each process picks up its half on its own schedule. The bot self-restarts onto a newer build when idle. The server's watchdog restarts it onto a newer build within a minute or two. The long-lived `pa catchup --loop` keeps its code until it is restarted.

Deploy the bot half first. A server serving the new routing instructions to a bot without the drain sends routing workers a text that tells them never to transcribe, and then only the fallback job transcribes.

For a task sitting in `transcribing` for more than a couple of minutes, first confirm the bot's process started after `projects/telegram-bot/dist/.build-stamp` was written. Then search `~/.pa/app.log.jsonl` for module `voice-inbox-transcribe-drain` lines naming the task. A `task.failed` event with `code: 'infra'` means an attempt failed, and the next attempt waits 2, 5 or 10 minutes after it. Four such events, or one plus 45 minutes of age, end the task as `transcribe_failed` with a page.
