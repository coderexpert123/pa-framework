#!/usr/bin/env node
/**
 * Dev/emergency pairing-code mint (AI-201 WP-B, §6) — bot-independent, so the
 * app never depends on a live bot change to be usable.
 *
 * Writes the SAME canonical pairing-codes.json entry the bot's /pair handler
 * writes (shape pinned in src/identity.ts — bare JSON array of pending
 * codes) and prints the code to stdout:
 *
 *   node scripts/mint_pairing.mjs --user-id 424242 --chat-id -1001234567890 \
 *        [--first-name "Op"] [--ttl-minutes 10]
 *
 * TTL defaults to voice_inbox.pairing_ttl_minutes from ~/.pa/config.yaml
 * (10). The code is identity plumbing, not a secret: single-use, 10-minute
 * TTL, sha256-hashed at rest once exchanged (§6 states this explicitly).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — matches src/identity.ts
const CODE_LENGTH = 8;

function paHome() {
  return process.env.PA_HOME || join(homedir(), '.pa');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function mintCode() {
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(4)) {
      if (out.length >= CODE_LENGTH) break;
      if (byte < 248) out += CHARSET[byte % CHARSET.length];
    }
  }
  return out;
}

async function pairingTtlMinutes() {
  try {
    const { parse } = await import('yaml');
    const raw = readFileSync(join(paHome(), 'config.yaml'), 'utf8');
    const parsed = parse(raw);
    const block = parsed && typeof parsed === 'object' ? parsed['voice_inbox'] : undefined;
    const n = block && typeof block === 'object' ? Number(block['pairing_ttl_minutes']) : NaN;
    return Number.isInteger(n) && n >= 1 ? n : 10;
  } catch {
    return 10; // no config / no yaml package: the §6 default
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userId = Number(args['user-id']);
  const chatId = Number(args['chat-id']);
  if (!Number.isInteger(userId) || userId <= 0) {
    console.error('usage: mint_pairing.mjs --user-id <telegram user id> --chat-id <chat id> [--first-name N] [--ttl-minutes N]');
    process.exit(2);
  }
  if (!Number.isInteger(chatId) || chatId === 0) {
    console.error('usage: mint_pairing.mjs --user-id <telegram user id> --chat-id <chat id> [--first-name N] [--ttl-minutes N]');
    process.exit(2);
  }

  const ttlMinutes = args['ttl-minutes'] !== undefined ? Number(args['ttl-minutes']) : await pairingTtlMinutes();
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1) {
    console.error('--ttl-minutes must be a positive integer');
    process.exit(2);
  }

  const now = Date.now();
  const entry = {
    code: mintCode(),
    telegram_user_id: userId,
    telegram_chat_id: chatId,
    first_name: typeof args['first-name'] === 'string' ? args['first-name'] : null,
    created_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + ttlMinutes * 60_000).toISOString(),
  };

  const dir = join(paHome(), 'voice-inbox');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pairing-codes.json');

  let pending = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) pending = parsed;
    } catch {
      pending = []; // torn file: start a fresh array rather than fail the mint
    }
  }
  pending.push(entry);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);

  console.log(`PAIRING CODE: ${entry.code}`);
  console.error(`minted for user ${userId}, chat ${chatId}, expires ${entry.expires_at} (${ttlMinutes} min)`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
