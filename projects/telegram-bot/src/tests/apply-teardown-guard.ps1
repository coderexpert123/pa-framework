# Script to apply teardown guard pattern to all test files
# Run from <repo>/projects/telegram-bot

$files = @(
  "src/tests/conversation.test.ts",
  "src/tests/delivered-store.test.ts",
  "src/tests/dispatch-session.test.ts",
  "src/tests/dlq.test.ts",
  "src/tests/integration.test.ts",
  "src/tests/lock-stale-overwrite.test.ts",
  "src/tests/lock.test.ts",
  "src/tests/logic-redact.test.ts",
  "src/tests/orphan-reaper.test.ts",
  "src/tests/pending-dispatches.test.ts",
  "src/tests/poll-loop-callbacks.test.ts",
  "src/tests/poll-loop-integration-extra.test.ts",
  "src/tests/poll-loop-maintenance.test.ts",
  "src/tests/ref-lookup.test.ts",
  "src/tests/reply-context.test.ts",
  "src/tests/resend-store.test.ts",
  "src/tests/rules-critic.test.ts",
  "src/tests/topic-brains.test.ts",
  "src/tests/topic-names.test.ts",
  "src/tests/topic-workdir.test.ts",
  "src/tests/tunables-commands.test.ts",
  "src/tests/voice-poll-loop.test.ts",
  "src/tests/callbacks.test.ts",
  "src/tests/delivered-store-compact.test.ts",
  "src/tests/maintenance-jobs.test.ts",
  "src/tests/ref-id.test.ts"
)

$importLine = "import { waitForDrain } from './test-teardown-guard.js';"

foreach ($file in $files) {
  $root = (Get-Location).Path
  $filePath = Join-Path $root $file

  if (-not (Test-Path $filePath)) {
    Write-Host "Skipping $file (not found)"
    continue
  }

  Write-Host "Processing $file"

  $content = Get-Content $filePath -Raw

  # Check if import already exists
  if ($content -match "from.*test-teardown-guard") {
    Write-Host "  - Import already exists, skipping"
    continue
  }

  # Add import after the last import statement
  $content = $content -replace '(import .*?;)\s*\n', "`$1`n$importLine`n"

  # For conditional pattern (if ... delete process.env.PA_HOME)
  if ($content -match "if \(.*delete process\.env\.PA_HOME") {
    Write-Host "  - Found conditional pattern"
    # Add await waitForDrain(); before the if statement
    $content = $content -replace '(\s+)afterEach\(async \(\) => \{', "`$1afterEach(async () => {`$1  await waitForDrain();"
  } else {
    Write-Host "  - Found simple pattern"
    # Simple pattern - add await waitForDrain(); before delete
    $content = $content -replace '(afterEach\(async \(\) => \{\s*)(delete process\.env\.PA_HOME)', "`$1await waitForDrain();`n  `$2"
  }

  Set-Content $filePath $content -NoNewline
  Write-Host "  - Updated"
}

Write-Host "Done"
