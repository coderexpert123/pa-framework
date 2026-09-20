#!/usr/bin/env bash
# install_trial.sh — fresh-machine install trial driver (AI-264 Wave C).
#
# Executes docs/INSTALL.md §2.2 steps S1–S8 and §5 checklist item 7
# (`pa verify-install --json`) exactly as the doc specifies them, against a
# clone of the public framework repo. The invoking environment provides:
#   - cwd inside the cloned repo (or $1 = repo dir; default = cwd)
#   - PA_HOME pointed at a scratch directory (the trial must never write the
#     operator's real ~/.pa; when unset the script refuses and prints why)
#   - Node.js >= 22 on PATH
#
# DUPLICATION RISK: the step bodies below mirror docs/INSTALL.md BY HAND.
# When you change an INSTALL.md command, mirror it here in the same wave —
# grep this file's S-step comments against the doc. The mirror exists so the
# trial drives the documented commands verbatim instead of a re-derivation;
# a divergence between the two IS a trial finding.
#
# Expected result of the whole trial: the script prints
#   INSTALL_TRIAL_VERDICT=PASS (or PASS with degradedFloor=true, or DEGRADED
#   with degradedFloor=true) and exits 0; any FAIL exits 1.

set -uo pipefail

REPO_DIR="${1:-.}"
LOG_DIR="${INSTALL_TRIAL_LOG_DIR:-$REPO_DIR/.install-trial-logs}"
mkdir -p "$LOG_DIR"

fail() { echo "INSTALL_TRIAL_VERDICT=FAIL detail=$*" >&2; exit 1; }

if [ -z "${PA_HOME:-}" ]; then
  fail "PA_HOME is unset — point it at a scratch directory so the trial never writes the operator's real ~/.pa"
fi
echo "[trial] PA_HOME=$PA_HOME"
echo "[trial] repo=$REPO_DIR"

PAJS="$REPO_DIR/pa/dist/bin/pa.js"
pa() { node "$PAJS" "$@"; }

# S1 — get the code (the harness cloned already; record the commit id).
S1_ID="$(git -C "$REPO_DIR" log -1 --format=%H)" || fail "S1 git log failed"
case "${#S1_ID}" in 40) ;; *) fail "S1 expected a 40-char commit id, got '$S1_ID'";; esac
echo "[trial] S1 commit=$S1_ID"

# S2 — build the two packages (bash variant, verbatim from INSTALL.md).
cd "$REPO_DIR" || fail "repo dir missing"
(cd pa && npm install && npm run build && echo PA_BUILD_EXIT=0) > "$LOG_DIR/pa-build.log" 2>&1 || { tail -20 "$LOG_DIR/pa-build.log" >&2; fail "S2 pa build failed (see $LOG_DIR/pa-build.log)"; }
(cd projects/telegram-bot && npm install && npm run build && echo BOT_BUILD_EXIT=0) > "$LOG_DIR/bot-build.log" 2>&1 || fail "S2 bot build failed (see $LOG_DIR/bot-build.log)"
grep -q "PA_BUILD_EXIT=0" "$LOG_DIR/pa-build.log" || fail "S2 missing PA_BUILD_EXIT=0"
grep -q "BOT_BUILD_EXIT=0" "$LOG_DIR/bot-build.log" || fail "S2 missing BOT_BUILD_EXIT=0"
[ -f "$PAJS" ] || fail "S2 pa/dist/bin/pa.js missing after build"
[ -d "$REPO_DIR/projects/telegram-bot/dist" ] || fail "S2 projects/telegram-bot/dist missing after build"
echo "[trial] S2 ok"

# S3 — scaffold the runtime home.
pa init > "$LOG_DIR/init.log" 2>&1 || { tail -20 "$LOG_DIR/init.log" >&2; fail "S3 pa init failed"; }
for f in config.yaml secrets.env skills; do [ -e "$PA_HOME/$f" ] || fail "S3 expected $PA_HOME/$f after init"; done
grep -q "Next steps" "$LOG_DIR/init.log" || fail "S3 expected a 'Next steps' block"
echo "[trial] S3 ok"

# S4 — provision. The trial has no human to answer the ladder's asks, so every
# ask gets "no" from stdin (the INSTALL.md-sanctioned decline path: the
# degraded floor line IS the success state when the user declines everything).
# Bounded answers, not `yes no`: a never-EOF feeder dies on SIGPIPE when node
# closes stdin, which under pipefail fails the step even on success. And the
# lines must be PACED: the ladder's ask flow creates a fresh readline
# interface per question on shared stdin, so an all-at-once pipe gets fully
# buffered by the first interface and later questions starve (they never see
# a line and the ladder dies). One "no" every 0.4 s for ~20 s keeps each
# interface fed exactly once. pipefail is dropped for the pipeline so $? is
# pa's own exit (the feeder's inevitable final SIGPIPE must not mask it).
set +o pipefail
( for _ in $(seq 1 50); do echo no; sleep 0.4; done ) | pa init --provision > "$LOG_DIR/provision.log" 2>&1
S4_EXIT=$?
set -o pipefail
[ "$S4_EXIT" -eq 0 ] || { tail -20 "$LOG_DIR/provision.log" >&2; fail "S4 provision failed (exit=$S4_EXIT)"; }
grep -qE "state: (configured|degraded-floor)|can't think yet" "$LOG_DIR/provision.log" || fail "S4 no configured/degraded-floor state line"
[ -d "$PA_HOME/outbox" ] || fail "S4 expected $PA_HOME/outbox"
echo "[trial] S4 ok ($(grep -c "may the assistant connect" "$LOG_DIR/provision.log" || true) CLI ask(s) declined)"

# S5 — delivery/secrets floor. Skipped by design: the trial opts into no chat
# account; TELEGRAM_BOT_TOKEN absent is a WARN everywhere (D4).

# S6 — health check: nothing FAIL beyond the two Telegram-absence rows. D4
# says Telegram absence is a WARN, never a FAIL, but `pa health` itself still
# PRINTS [FAIL] bot-process / [FAIL] secrets(TELEGRAM_*) on a fresh install —
# the reclassification lives only inside `pa verify-install` (commands/
# verify-install.ts). This driver applies the identical reclassification so
# the documented S6 expectation holds; a health-side or doc-side fix is an
# upstream decision, not this script's.
pa health --no-color > "$LOG_DIR/health.log" 2>&1 || { tail -20 "$LOG_DIR/health.log" >&2; fail "S6 pa health failed"; }
grep -E "^\s*\[FAIL\]" "$LOG_DIR/health.log" |
  grep -Ev "^\s*\[FAIL\]\s+(bot-process\b|secrets\b.*TELEGRAM_)" > "$LOG_DIR/health-fails.txt" || true
[ ! -s "$LOG_DIR/health-fails.txt" ] || { cat "$LOG_DIR/health-fails.txt" >&2; fail "S6 health reported FAIL (non-Telegram)"; }
grep -E "^\s*\[FAIL\]\s+(bot-process\b|secrets\b.*TELEGRAM_)" "$LOG_DIR/health.log" >/dev/null 2>&1 \
  && echo "[trial] S6 Telegram-absence FAIL rows present and reclassified WARN per D4"
echo "[trial] S6 ok"

# S7 — machine profile: report includes a coexistence block; probe failures
# degrade to unknown, never error.
pa doctor > "$LOG_DIR/doctor.log" 2>&1 || { tail -20 "$LOG_DIR/doctor.log" >&2; fail "S7 pa doctor failed"; }
grep -qi "coexistence" "$LOG_DIR/doctor.log" || fail "S7 no coexistence block in doctor report"
echo "[trial] S7 ok"

# S8 — first real run (checklist note: copy the example pack first). A fresh
# install has no reminders.json, and the example skill no-ops on an empty
# store — seed one immediately-due probe reminder so S8 exercises the real
# delivery path, exactly as `pa verify-install`'s own skill probe does.
rm -rf "$PA_HOME/skills/reminders"
cp -r "$REPO_DIR/examples/skills/reminders" "$PA_HOME/skills/reminders" || fail "S8 copying example pack failed"
printf '[{"due_at":"%s","message":"[install trial] S8 probe reminder - safe to ignore","chat_id":"0","thread_id":0}]\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PA_HOME/skills/reminders/reminders.json" || fail "S8 seeding probe reminder failed"
S8_MARK="$LOG_DIR/s8-start.marker"
touch "$S8_MARK"
pa run reminders > "$LOG_DIR/run.log" 2>&1 || { tail -20 "$LOG_DIR/run.log" >&2; fail "S8 pa run reminders failed"; }
S8_FILE="$(find "$PA_HOME/outbox" -type f -newer "$S8_MARK" -size +0c 2>/dev/null | head -1)"
[ -n "$S8_FILE" ] || fail "S8 no non-empty outbox file newer than the run start"
echo "[trial] S8 ok ($S8_FILE)"

# Checklist 7 — verify-install --json; PASS, or PASS/DEGRADED with
# degradedFloor:true (the trial job never carries API keys, so a degraded
# floor is the honest floor result and is recorded in the artifact).
VERIFY_JSON="$LOG_DIR/verify-install.json"
pa verify-install --json > "$LOG_DIR/verify-stdout.log" 2> "$LOG_DIR/verify-stderr.log" || true
node -e '
  const fs = require("fs");
  const text = fs.readFileSync(process.argv[1], "utf8");
  const start = text.indexOf("{");
  if (start < 0) { console.error("no JSON object in verify-install stdout"); process.exit(1); }
  let r;
  try { r = JSON.parse(text.slice(start)); }
  catch (e) { console.error("unparseable verify-install JSON: " + e.message); process.exit(1); }
  fs.writeFileSync(process.argv[2], JSON.stringify(r, null, 2));
  const ok = r.verdict === "PASS" || (r.verdict === "DEGRADED" && r.degradedFloor === true);
  console.log("INSTALL_TRIAL_VERDICT=" + r.verdict + " degradedFloor=" + (r.degradedFloor === true));
  for (const c of r.checks || []) console.log("  " + c.status + " " + c.id + " — " + c.detail);
  process.exit(ok ? 0 : 1);
' "$LOG_DIR/verify-stdout.log" "$VERIFY_JSON" || {
  cp "$LOG_DIR/verify-stdout.log" "$LOG_DIR/verify-install.json.failed" 2>/dev/null
  fail "checklist 7 verify-install verdict not PASS/DEGRADED(degradedFloor) — see $LOG_DIR"
}
echo "[trial] artifacts in $LOG_DIR"
