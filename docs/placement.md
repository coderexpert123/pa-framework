# Placement: Deciding Where a Feature Lives

## What placement decides

A feature is anything this system maintains as a unit: a skill, a script, a module, a project, or a document. A skill is a named automation defined by a markdown file plus its scripts, run on a schedule or on demand. The assistant is the automation system this framework runs: it takes instructions, dispatches work to language-model workers, and reports back. Every feature has exactly one canonical home. The canonical home is the copy that counts as authoritative; all other copies are builds, deployments, or runtime copies.

Placement is the act of choosing that home between the only two trees this framework has. The public mirror is the published framework that any reader may copy. The private repo is the working repository of one operator, the person the assistant serves, and it holds that deployment's data and wiring. The rule is that placement is decided once, when the feature is built, and recorded then. The sync boundary enforces the home mechanically: the publish gate refuses a file that is new to the public mirror and matches no public-eligible registry row, and flags it for the maintainer.

A feature nobody placed keeps the home it first landed in. That neglect is how personal detail reaches published code. Placement therefore applies to every feature the system maintains, not only to new ones.

## The four tiers

Placement sorts features into four tiers, ordered from most generic to most personal. The tier describes what a feature is made of, and the tier decides its home. A feature takes the most personal tier that any of its parts requires: one hardcoded account detail makes an otherwise generic module a tier-three feature. An adapter is a component that translates between this framework and something outside it, such as a vendor API, a website, or a local tool. Clients, parsers, wrappers, and drivers are all adapters.

| Tier | Definition | Home |
|---|---|---|
| 1 — Framework core | Code every deployment needs: dispatch and scheduling, locking, the conversational front end, alerting, and the maintenance framework (the part that schedules cleanup, watchdog, and retention jobs) | Public mirror |
| 2 — Generic integration substrate | Adapters whose generic half is complete, meaning no account-specific values baked in: authentication flows, API clients, parser engines, send-and-retry plumbing | Public mirror, split per the rule below |
| 3 — Vendor adapter with personal wiring | An adapter that works only because account-specific settings are baked into it | Public mirror only after de-personalization and a terms-of-service review |
| 4 — Personal vertical | Encodes one operator's behavior, data, or subject domains | Private repo |

The split in the second tier has a name: adapter-split. The generic half of an adapter, its flows and parsers, is published. Its instantiation, meaning the account values that point the adapter at one particular account, stays out of the public mirror. Those values live in the private repo's configuration or in the runtime state directory, the per-machine folder holding secrets and live state, never in published code. This rule is what makes the third tier recoverable: de-personalization moves the baked-in account values into that configuration.

The terms-of-service review is a gate with a procedure, run by the maintainer proposing the promotion; a maintainer is whoever is changing the framework, a person or an agent session. Trigger: a vendor adapter is about to be published and the vendor offers no documented public API for what the adapter does. Procedure: read the vendor terms for automated access, redistribution, and rate limits, and record the outcome in the registry row's evidence. The registry is the standing index of placement calls, defined fully in the last section. Outcome: a pass clears the promotion; a fail or an unclear read keeps the adapter private and leaves the row pending-operator with the open question in its evidence.

## The three tests

Three tests settle a placement call. Apply them in order and record each answer. The answers, with the evidence behind them, become the registry row's evidence field. A clean answer to a test is not a doubt: doubt is what remains when an answer cannot be defended, when two answers conflict, or when a test cannot be applied. Three agreeing answers fix the placement, and the most-personal-part rule above picks the exact tier within it; anything else goes to the doubt rule below.

### The horizontal test

Ask whether a second user of this framework would benefit from the feature with only configuration changes. Configuration means settings files, environment values, and entries in the lookup tables the framework loads at start, wherever this deployment keeps them; it never means source edits. A yes places the feature in the public mirror. A no has two exits.

If the personal part could be separated from a generic mechanism, the feature stays private until the split line is named. The split line is the sentence that says which part is public and which part stays private, and naming it is what makes the feature a candidate for the third tier. If the feature is personal by essence, meaning it encodes one operator's behavior, data, or subject domains and no separation would ever serve a second user, it is a personal vertical. A personal vertical is private as its nature; no split line is owed and none is pending.

### The de-personalization gate

The gate checks what a feature hardcodes before that feature is published. Run it at initial placement for any public candidate, and again whenever a published feature changes or gains a new value. It must find no operator names or handles, no fixed conversation or topic identifiers, no personal filesystem paths, and no vendor-plus-account pairing. A conversation or topic identifier is the number a chat platform assigns to a chat, or to a thread inside one. A vendor-plus-account pairing is a code path that is valid only for one account at one vendor.

Failing the gate has one outcome: the feature, or the leaking part of it, stays out of the public mirror until the hardcoded values move into configuration. A feature that cannot pass without a refactor is a tier-three feature owing that refactor. Secrets reach a feature only through the environment. Routing decisions, meaning which conversation, topic, or destination a message or alert goes to, live in configuration, never in code.

### The doubt rule

Unresolved doubt must escalate; silent resolution is the failure this rule exists to prevent. An interactive session asks the operator and records the answer in the registry row, with the operator and the date as the provenance. An autonomous run must not guess: it defaults the feature to private, marks the row pending-operator, and surfaces the question in the review digest. The review digest is the scheduled report collecting open questions for the operator; the question must reach the store that digest reads, so an unanswered question resurfaces instead of aging out. A leaked personal detail is worse than stranded reuse, which is why the default runs toward private.

## Three surfaces

A feature can appear on three surfaces. The private repo is the working repository and its history. The public mirror is the published framework that any reader may copy; framework files that say public tree mean this same mirror. The runtime state directory is the per-machine folder holding secrets, live state, and the deployed copies of skills.

The runtime surface is never the canonical home of anything. A feature deployed to the runtime must have its definition in a repo. That definition is either a project original or a public example copy. A project original is a directory in the private repo's projects tree that owns the feature. A public example copy is a sanitized template in the public mirror's examples tree, showing the feature's shape without deployment data.

The project original is the canonical home; the example copy is a published view of it, and whoever changes the original refreshes the copy in the same change. Populating the mirror is mechanical, not manual: this framework ships a sync command, public-sync, that copies from the private repo only the paths the boundary file allows. The boundary file is .gitignore-public at the repo root, a whitelist of path patterns. The file is generated from the placement registry's Boundary lines section; adding the row there and regenerating is how a feature becomes eligible to leave. A runtime copy with no repo definition is a finding, a recorded gap that the audit process captures; the fix is to land the definition.

## The documentation split

Documentation is a feature like any other, and it follows the same boundary as code. Deployment internals, incident history, wiring notes, and per-machine procedure live in a scoped brain file beside the private deployment. A brain file is per-subsystem operating notes that agents load before changing that subsystem. Catalogs, references, and how-it-works explanations are public documents, generalized so a reader outside this deployment can use them. Public documents never reference private paths.

Removing such a reference has mechanical consequences. The generic phrasing runs longer than the path it replaces, so a document near its size budget takes the compact form — the design record for a date and topic — and the budget suite gates any scrub near a ceiling. The reference census covers published files only: a glob-shaped path or a document not yet mirrored escapes it, so a sweep before first publication greps the superset rather than re-running the census.

## Recording a verdict

Record the placement call in two places when the feature is built. The build document, meaning the written plan or report for the unit of work that produced the feature, carries one line naming the verdict, the reason, and the tier. Build documents are versioned files kept in the private repo, one per unit of work. The verdict is one of three values: PUBLIC for a canonical home in the public mirror, PRIVATE for the private repo, or SPLIT when both apply. A SPLIT verdict carries the split line naming which part is public and which stays private.

The registry is the standing index of these calls: one row per feature, with its surfaces, verdict, split line, evidence, provenance meaning where the decision came from, and a status. The status is active, pending-operator for a doubt still open, or phase-2-gap for a repair owed in a later wave. It lives in the private repo as a versioned markdown file beside the other private indexes; this document does not print the exact path, because public documents never reference private paths. The word registry is reserved for this index; routing lookups and other runtime tables are configuration, not the registry. The feature's author adds the row at build time, and an audit fills or corrects rows later.

An audit is a retrospective census sweep that re-checks every row against what is on disk and fills the rows that have no decision. The maintainers run it when the registry is first created and again after large changes to the framework; it is not a continuous gate. Rows an audit produces cite that audit; rows a live decision produces cite the commit hash or the build document that made the call.

| Step | When | What you write | Where it goes |
|---|---|---|---|
| 1 | At build time, once the tier is fixed | The verdict line: verdict, reason, tier | The build document for the work unit |
| 2 | At build time, same moment | The registry row with its evidence and provenance | The registry file in the private repo |
| 3 | On doubt, interactive session | The operator's answer as provenance, status active | The same registry row |
| 4 | On doubt, autonomous run | status pending-operator, question sent to the review digest | The same registry row and the digest |

These are the rules the system holds itself to, stated as musts. What checks them is the audit and the row statuses, not a continuous gate. A promotion without a recorded gate pass, and a doubt resolved silently, are both findings the next audit captures.
