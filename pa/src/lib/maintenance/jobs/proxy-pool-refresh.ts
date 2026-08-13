import type { MaintenanceJob } from '../types.js';
import { proxyRefreshIntervalMs } from '../../telegram-proxy.js';

export const proxyPoolRefreshJob: MaintenanceJob = {
  name: 'proxy-pool-refresh',
  host: 'bot',
  // FUNCTION form, deliberately: the cadence is config-derived (cached,
  // seeded by telegram-proxy.ts's getSourceConfig()) and the bot binds this
  // declaration verbatim via object spread — a static number here would
  // silently flatten the config-derived cadence for the live bot too
  // (regression found 2026-08-13: the bound copy inherited a hardcoded 5m
  // and `pa maintenance list`'s display value drifted from reality).
  everyMs: () => proxyRefreshIntervalMs(),
  description:
    'Re-scan TELEGRAM_PROXY_SOURCE_URL and rewrite the healthy SOCKS5 pool at ' +
    '~/.pa/telegram-proxies.json. No-op unless a source is configured AND the direct route ' +
    'is currently blocked — a working direct route costs zero proxy scans. Not shed under ' +
    'DEGRADED: it only does work while Telegram is unreachable directly, and shedding the ' +
    'thing that restores connectivity during an outage would be self-defeating (matches the ' +
    "existing behavior — no degraded gate exists on today's equivalent timer).",
  destructive: false,
  shedWhenDegraded: false,
  targets: [],
  async run() {
    return { touched: 0, detail: { unbound: true } };
  },
};
