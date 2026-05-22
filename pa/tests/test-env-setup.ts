// Sets global environment flags before any test file loads.
// Prevents real external side-effects (Telegram sends, etc.) during test runs.
process.env.PA_NOTIFY_DISABLED = '1';
