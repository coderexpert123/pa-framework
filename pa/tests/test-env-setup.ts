// Sets global environment flags before any test file loads.
// Prevents real external side-effects (Telegram sends, etc.) during test runs.
process.env.PA_NOTIFY_DISABLED = '1';

// Machine-wide worker admission control (AI-096) shares its slot pool across
// the concurrently-running test-file processes (the blackboard path is baked
// at import, before per-test PA_HOME overrides apply). Under the production
// default of 3 slots, parallel test files' real executeWorker spawns contend
// and spuriously time out ("All worker slots busy") on loaded machines —
// observed 5+ times across 2026-07-10 alone. Raise the cap for tests;
// worker-slots.test.ts exercises admission control itself and sets/deletes
// this explicitly per test, so it is unaffected by this default.
process.env.PA_MAX_CONCURRENT_WORKERS = process.env.PA_MAX_CONCURRENT_WORKERS || '64';
