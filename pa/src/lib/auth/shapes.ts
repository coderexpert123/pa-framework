/**
 * The five auth-broker shapes and their widget mapping (auth broker Phase A,
 * 2026-09-10 build spec §3.1). `InputKind` here is a LOCAL string-union
 * copy — this module never imports the voice-inbox package. pa and
 * voice-inbox are separate packages; pa only ever reaches voice-inbox
 * through the dynamic import in `ledger-bridge.ts` (D10), and this module
 * has no need for that seam at all — it is pure mapping logic.
 */

export const AUTH_SHAPES = ['S1', 'S2', 'S3', 'S4', 'S5'] as const;
export type AuthShape = (typeof AUTH_SHAPES)[number];

/** Default expiry (seconds), used when `--expires` is absent. */
export const SHAPE_DEFAULT_EXPIRY_SECONDS: Record<AuthShape, number> = {
  S1: 43200,
  S2: 900,
  S3: 3600,
  S4: 3600,
  S5: 43200,
};

/** Local copy of the voice-inbox widget-kind vocabulary — see file header. */
export type InputKind = 'secret' | 'text' | 'choice' | 'oauth' | 'file' | 'confirm';

export interface WidgetForShapeOpts {
  provider?: string;
  userCode?: string;
  confirmable?: boolean;
  options?: string[];
}

export interface WidgetForShapeResult {
  kind: InputKind;
  params: Record<string, unknown>;
}

/**
 * Map a shape + CLI opts onto the widget kind and params the ledger's
 * `createInputRequest` expects (§3.1's table):
 *
 *   S1  oauth   { provider, confirmable? }
 *   S2  oauth   { provider, user_code, confirmable? } — a *display* shape in
 *       Phase A (D6): the caller already ran its own device-flow exchange
 *       and supplies the code it printed; Phase A never runs its own
 *       device-flow driver.
 *   S3  secret  {} — "read a code on the phone, type it into the app"
 *   S4  secret  {} — "type an API key / password / token"
 *   S5  confirm {} when no options are given, else choice { options }
 */
export function widgetForShape(shape: AuthShape, opts: WidgetForShapeOpts): WidgetForShapeResult {
  switch (shape) {
    case 'S1': {
      const params: Record<string, unknown> = { provider: opts.provider };
      if (opts.confirmable !== undefined) params.confirmable = opts.confirmable;
      return { kind: 'oauth', params };
    }
    case 'S2': {
      const params: Record<string, unknown> = { provider: opts.provider, user_code: opts.userCode };
      if (opts.confirmable !== undefined) params.confirmable = opts.confirmable;
      return { kind: 'oauth', params };
    }
    case 'S3':
    case 'S4':
      return { kind: 'secret', params: {} };
    case 'S5':
      if (opts.options && opts.options.length > 0) {
        return { kind: 'choice', params: { options: opts.options } };
      }
      return { kind: 'confirm', params: {} };
    default:
      throw new Error(`widgetForShape: unknown shape ${shape as string}`);
  }
}
