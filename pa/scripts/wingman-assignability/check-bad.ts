import type { JevAsk } from 'jev-browser-wingman/contract';
import type { TypeSafeRequest, AskOptions, TypeSafeResult } from '../../src/lib/typesafe-client.js';
declare const drifted: (r: TypeSafeRequest, o: AskOptions) => Promise<TypeSafeResult | { ok: false; error: 'quota'; latencyMs: number; retries: number }>;
const ask: JevAsk = drifted;
void ask;
