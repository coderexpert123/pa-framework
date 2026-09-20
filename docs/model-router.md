# Model router (`pa/src/lib/model-router/`, 2026-09-18; orchestrator contract 2026-09-19)

Optional per-turn router beside the existing judge ladder. A single TypeSafe classification decides which fleet worker serves a bot turn, replacing worker choice with a config-ranked policy table when enabled. Everything here is OFF by default: no `model_router` block in config.yaml means zero behavior and zero logging. Full knobs live in `config.example.yaml` (commented scaffold); the plans are `plans/2026-09-18-model-router-SPEC.md` and `plans/2026-09-19-router-as-orchestrator-SPEC.md`.

## Config block and staging gates

`model_router:` in `~/.pa/config.yaml` gates in two stages:

1. **Block absent** — disabled. Nothing logs; shadow writes nothing.
2. **Block present, `enabled: false`** — SHADOW mode. The router computes what it would have chosen, but the existing routing ladder still dispatches. One JSONL line per routed turn goes to `~/.pa/model-router-shadow.jsonl` (override: `shadow_path`).
3. **`enabled: true`** — the router DECIDES for unpinned turns. Shadow lines keep recording both sides so disagreement data accrues.

Stage 3 is further staged per SURFACE (`surfaces:`); an absent key means `shadow` for that surface, and model/effort selection is live from stage 3 without re-staging. Worker pins (topic defaults, `/agent`, worker pins) outrank the router while `deprecate_pins` is explicitly `false`; the default retires them for turn dispatch (§ Pin deprecation). Router-sourced values never write topic state.

## Taxonomy and the classifier — the one-ask contract

One TypeSafe call (`needs-classifier.ts`) asks every question in ONE request — never sequential asks. The two phase-1 questions stay byte-stable:

- **Capability tier**: `quick_lookup` → `standard` → `deep_reasoning` → `rich_toolchain`.
- **Effort score**: 1 (trivial) → 5 (hardest).

The orchestrator questions ride the same request; each is included only when its input is supplied:

- **`placement`** (`direct`/`current`/`other`/`new`/`split2`/`split3`) — asked when placement candidates are passed, even empty; `target`/`target2`/`target3` join only with a non-empty candidate list and validate only for splits.
- **`steer_wait`** (`steer`/`wait`) — asked only when an in-flight run exists for the topic.
- **`chain`** — one Choice question over the distinct table workers; the DECISION payload is its per-worker `probabilities` map, never the chosen option.

Parsing uses the lenient variant (`parseTypeSafeAnswersLenient`, `lenient: true`) so one missing or invalid answer cannot void the whole response — the strict all-or-nothing parse stays the default for every other caller (judge, evals). Fail-open binds at the PARSE boundary: placement absent or invalid → `current`; `steer_wait` absent or invalid → `wait`; chain absent or invalid → rank order (no chain). Only a tier/score failure fails the classification; a model omitting a NEW question is the expected case, and every new question has an absent-path test.

Egress caps bound what leaves the process: `state_max_chars` (default 4000) for the classified text, `context_max_chars` (2000) for the prior-turn digest, `topic_max_chars` (300) for topic name/description, plus at most `section_chars` (2400) of candidates and 360 chars of in-flight view. The classifier never throws — any failure fails open to the default worker. Command turns are pinned turns for the router: the ladder keeps the default worker and the router runs shadow-only (`pinPresent: true`), still classifying the command text so the would-have-chosen line accrues.

## Context sources

`context-reader.ts` builds the digest from one of two stores, READ-ONLY and fail-open:

- `telegram` — `~/.pa/conversation-history.jsonl`, filtered by `thread_id` only (chat_id is not stored in archive turns; the topic-scoped, single-user precedent makes thread_id sufficient). Streamed in fixed-size chunks, never loaded whole. The same stream captures the incumbent worker — the `worker` field on the newest matching line — which stickiness reads.
- `voice-inbox` — the ledger sqlite (`tasks` rows by `conversation_id`, schema v15). Opened `readonly`, `fileMustExist`, closed in `finally`. Schema v15 records the serving worker (`worker_cli`/`worker_model`/`worker_effort`), and the reader surfaces the newest non-empty `worker_cli` as the voice-inbox `incumbentWorker` — stickiness treats both stores alike.

Amendment note (phase-2 overlap): continuation-before-destination context is read by THIS reader only — the TypeSafe phase-2 spec consumes `TurnContext` and must not build a second reader.

## Policy table semantics

`table:` rows in config.yaml — **config order IS the rank**. "Cheapest" means earliest rank, never a price number. `resolveFromTable` (pure, deterministic) keeps rows satisfying the need (`max_tier` >= tier, `max_score` >= score) AND available. The first such row wins. **z.ai-peak-last**: rows for workers listed under `zai_workers:` move to the END of the candidate order while inside the `cost_tier.peak_window_utc` window (stable within their group), so shared-quota workers are only picked when nothing cheaper is available at peak.

Availability (default predicate): fleet member, not `manual_only`, not cooling down — rate-limits semantics; no entry = available, never guessed.

### Ordered-candidates mode (the probability chain)

`orderCandidateChain` (pure export) orders ALL need-satisfying rows by the ask's per-worker probabilities (descending), table rank as tiebreak, then z.ai-workers-last grouping inside the peak window. The chain is never pre-filtered to one row. `resolveFromTable` gains an optional `orderedRows` parameter: present, it scans that order and returns the first available row (no re-sorting); absent, today's rank-order behavior is byte-identical.

The router builds `chain` from the ordered rows filtered by the resolve-time availability snapshot and sets `chosen` from the first entry. A sticky keep REORDERS the chain to put the incumbent first — it never drops the rest. `runWithFailover` consumes the chain via `RunOptions.candidateOrder` (stable reorder; unnamed workers keep static order behind) and `ignoreWorkerPin` skips the `worker_pin` reorder; `preferredWorker` still wins when a caller passes one, per-attempt availability re-checks are untouched, and under `quota_aware_failover` the demoted-tail regrouping runs after the reorder. Fail-open keeps the static config order. The whole consumption is surface-gated: `candidateOrder` reaches the failover seam only when `surfaces.fallback: live`; dark mode records the chain in the shadow line and forwards nothing.

Conversation stickiness (default ON; `sticky: false` opts out) keeps the incumbent worker while a table row for it satisfies the need and it is available. Escapes are capability-UP only: the need exceeds the incumbent's envelope (`unsatisfiable`), the incumbent is unavailable (`unavailable`), or a non-z.ai row satisfies inside the peak window (`peak-zai-last`). The earliest satisfying incumbent row re-picks the model, and effort still re-projects per turn. Shadow lines record `sticky` and `stickBreakReason` so sticks versus escapes stay countable.

## Effort projection

`effort_projection:` maps the router's effort score onto each worker's EXISTING effort tunable (`effort-projection.ts`). Defaults: codex `{1:minimal,2:low,3:medium,4:medium,5:high}`; zclaude/claude/kgclaude low→max; agy encodes effort in the model row; agyc/devin are `tunable: none`. Outcomes are explicit — a knobless worker under a high need yields `recategorize` (never a silent downgrade); a missing mapping yields `nearest` with detail.

## Placement engine (`surfaces.placement`, flips LAST)

Candidates come from `voiceInboxPlacementCandidates(cap)` — a read-only, fail-open ledger accessor mirroring the conversation-state contract. One query takes the newest task row per `conversation_id`, folds titles from `conversation_meta`, orders by that row's `updated_at`, and caps at `candidate_cap` (default 25), dropping oldest-updated first. The CURRENT conversation's own candidate is never dropped — the reader owns that exemption and swaps it into the kept set. The cap truncation sets `truncated` in the shadow line beside the candidate count; goals (≤ `goal_chars`, 80) exist only in the prompt section, bounded by `section_chars` (2400, tail-first drop). Every ledger conversation is operator-started by construction, so no manual/auto flag exists and the reader structurally cannot return orchestrator or infra threads.

`applyRouterPlacement` (`router-placement.ts`, pure) turns the answer into one of four kinds. `in-place` covers direct/current; `move` targets a candidate's routed-to topic (`other`; an invalid target fails open in-place). `create` takes a DETERMINISTIC name from the turn text (first ≤6 meaningful words, ≤40 chars — never an LLM-authored name); `split` is a validated 2–3-part decomposition (deduped; below two valid parts it degrades to the single part). Wiring lives in main.ts and runs only on real operator turns when `surfaces.placement: live`; a placed turn carries `__synthetic: 'placement'` and is never re-placed. The origin's reply IS the announce — one ref-ID'd `→ moved to <name>` line per part, no worker dispatched in the origin.

One ask covers one LOGICAL turn: the destination reuses the carried needs/chain and resolves its worker deterministically against the DESTINATION's incumbent (voice-inbox `worker_cli`, telegram archive `worker`) — no second TypeSafe ask. Escapes stay capability-UP only. Shadow markers distinguish the fail-opens: `+invalid-target` (placement answered, target unusable) versus `+absent-placement` (the lenient parse found no usable placement answer).

## Steer/wait (`surfaces.steer`, flips second)

When an in-flight run exists (human, thread, and voice lanes; ≤3 entries, ids and status words only), the ask carries `steer_wait`. `wait` is today's behavior — the turn queues; the decision is only recorded. `steer` turns the current text into the correction for the running worker: kill (PID-captured), drain queued entries, fold, re-dispatch. The `/steer` mechanics live ONCE in `steer-exec.ts` `executeSteer` — the command handler and the router-steer path call the SAME function. One owner per turn: a router steer makes the same turn's PA_META `steer_thread` for that target drop with the frozen footer `_(steer already applied by routing)_` (per-turn in-process guard map).

## Pin deprecation (`deprecate_pins`, default ON)

Absent with the block present means TRUE; explicit `false` restores today's behavior. Effective only on router-decided turns, and only for TURN DISPATCH — command handlers still parse, reply, and write state, so flag-off reversal is exact. Under the flag: `/agent`'s value stops steering dispatch (standing notice), `/model`+`/effort` session tunables are not applied on routed turns, `topic_defaults` go unread (floor = first configured worker), and the cascade sets `ignoreWorkerPin`. Pins that landed earlier keep working as stickiness incumbents — the incumbent is what actually served, and stickiness keeps it while needs fit. On flagged routed turns the old judge ladder does NOT run (one TypeSafe ask per turn); it stays byte-for-byte for block-absent, disabled, `deprecate_pins: false`, and command turns.

## Availability cache (`availability.ts`)

`getCachedAvailability` wraps the router's two expensive reads — the config parse and the cooldown snapshot (one read serves all workers per refresh) — behind a TTL cache. `availability_ttl_ms` (default 5000) tunes it, `PA_MODEL_ROUTER_AVAILABILITY_TTL_MS` overrides, and `0` disables. Fault semantics are unchanged: unknown reads unavailable, never guessed-available. The cache feeds ONLY the router's resolve path; the failover ladder's per-attempt eligibility and worker checks stay uncached — they are the stale-probability guard.

## Metadata and cost provenance

`metadata.ts` carries hand-curated per-model facts (cost basis, strengths, latency, quota burn) used to VALIDATE and WARN, never to auto-rank. Every worker in the fleet bills a flat subscription or quota allowance — Devin's docs publish ACU-based pricing only (no per-token rates for `deepseek-v4-1-flash-max` as of 2026-09-18), so devin is represented flat/subscription with a dated note instead of fabricated per-M numbers. Revisit if vendor pricing changes.

## Shadow log and telemetry

- `~/.pa/model-router-shadow.jsonl` — one line per routed turn: `{at, topicKey, store, textSource, tier?, score?, confidence?, chosen?, baseline, pinPresent, disagreement, sticky?, stickBreakReason?, reason}` plus the orchestrator fields: `chain?` (ordered, availability-filtered `{worker, p}` entries), `placement?` (`{choice, targets, candidates, truncated}`), `steerWait?` (`{inflight, decision}`). Lines are capped at 1500 chars (reason truncated to 200); NO turn text in any field — topic key, worker names, ids and status words only; candidate content never enters the line.

### Per-surface staging and flip order

Each surface flips independently once its dark-window disagreement samples are individually reviewed: `fallback` first (the failover ladder consumes `candidateOrder`), `steer` second (a router steer may correct an in-flight run), `placement` LAST (placement replaces the orchestrator-persona branch on routed turns; the persona prompt and `/orchestrator` state stay intact for flag-off reversal). Dark means recorded-not-applied. Shadow records accrue during every stage, so the flip decision reads counts, not anecdotes.
- `~/.pa/model-router-telemetry.jsonl` — per-successful-dispatch usage line (`{at, worker, model?, durationMs, inputTokens?, outputTokens?}`) appended by the worker-exec hook when the block is present; best-effort, never alters the exit path, no turn text.

## Routing metadata provenance (2026-09-20)

Per-turn routing metadata rides the WS3 provenance channel (env → `RunOptions.getEnv` → `task_telemetry.py` → ledger), never a second channel. Seven `PA_ROUTING_*` keys — present with a closed-vocabulary value, or absent (never empty-string, never another value):

| Env key | Values |
|---|---|
| `PA_ROUTING_DECISION` | `router` \| `ladder` \| `command` |
| `PA_ROUTING_PLACEMENT` | `continued-here` \| `diverted` \| `new-conversation` \| `split` |
| `PA_ROUTING_TARGET` | a ledger conversation id (`vi-<12 hex>`), or absent |
| `PA_ROUTING_STEER` | `steer` \| `wait` |
| `PA_ROUTING_STEER_BY` | `router` \| `operator` — only alongside `PA_ROUTING_STEER` |
| `PA_ROUTING_EFFORT_PROJ` | `applied` \| `nearest` \| `recategorize` |
| `PA_ROUTING_FAILOVERS` | decimal integer ≥ 0, per-dispatch (cascade-owned) |

The six turn-level keys come from ONE pure producer, `buildRoutingProvenanceEnv`; the cascade composes them into `getEnv` at every attempt site and appends `PA_ROUTING_FAILOVERS` per hop, so the successful hop records the count. Three lanes stamp: human (`main.ts` → `dispatchMessage`), orchestrator-session (`dispatchOrchestratorTurn`), and threads — the spawn persists the turn-level env on `ThreadRecord.routing` (additive; persisted, not closed over — a queued thread may start minutes later) and the executor's `getEnv` spreads it. The task-executor lane (`t-*`) is out of scope — no ledger row to record into.

The ledger side is the seven `router_*` columns (schema v16, additive, NULLable; NULL = absent). Types: `router_decision/_placement/_target/_steer/_steer_by/_effort_proj` TEXT + `router_failovers` INTEGER. `task_telemetry.py` writes them in the SAME progress UPDATE as `worker_*` (never half-recorded); absent env → NULL (fail open); the last event wins, same as `worker_*` — a steer/re-resume re-stamps. Invariants: no turn text in any field (`PA_ROUTING_TARGET` is an id, never a topic name or announce text); the shadow JSONL schema is untouched; the share view drops all seven, while the authenticated PWA shows them behind the "How this was answered" affordance — a placement change (`diverted`/`new-conversation`/`split`) is the one default-visible line.

## Maintenance job

`model-router-cooldown-normalize` (daily, maintenance lane): clears rate-limit cooldowns expired >24h ago for self-healing classifications (terminal faults recorded, never cleared) and prunes shadow AND telemetry JSONL lines older than 90 days — per-LINE selection inside each file, atomically rewritten. `pa maintenance list` shows it; state in `~/.pa/maintenance-state.json`.

## Builder gotchas

- `lib/model-router/` is ONE level deeper than `lib/` — module imports need `../../` (three for bot-side consumers via pa/dist re-exports).
- Test filters are exact-basename: `npm test -- model-router-<x>.test.ts` must spell the file name exactly or the run silently skips it.
- The commit skill's fast path introduced for this wave is temporary — do not treat or document it as permanent routing behavior.
- Lock-wait and alert-path test seams landed alongside: build-lock waits up to 450s before failing open; alert-path tests stub via the alert seam, not real sends.

## Placement

Module code is PUBLIC framework surface (a second deployment benefits with config only; every fleet-specific value lives in config.yaml). Shadow/telemetry JSONL files are mechanism-PUBLIC, data-PRIVATE (they live under `~/.pa`, never the tree). Live table rows, `zai_workers` and effort_projection VALUES are PRIVATE config; `config.example.yaml` carries only the commented generic scaffold.
