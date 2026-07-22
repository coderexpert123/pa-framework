import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify as stringifyYaml } from 'yaml';

/**
 * dashboard.ts's entire length-budget mechanism (see its own header comment)
 * depends on measuring against `pa/dist/src/lib/mdv2.js`'s `sanitizeMdV2` —
 * but the ACTUAL Telegram send path in this file's sibling `telegram.ts` calls
 * a SEPARATELY MAINTAINED, locally-defined copy (see `pa/src/lib/mdv2.ts`'s
 * header comment: "ported ... any future fix there must be replayed here").
 *
 * Before dashboard.ts existed, a drift between the two copies was cosmetic —
 * nothing computed an exact character budget against one copy while sending
 * through the other. Now it is a correctness bug waiting to happen: dashboard
 * content could measure as "fits in 4096" against one copy while the real
 * send (through the other copy) actually overflows, silently freezing the
 * whole pinned dashboard (editMessageText cannot chunk).
 *
 * This test does not care WHY the two copies might diverge — only THAT they
 * haven't. If a future fix lands in one copy and not the other, this must
 * fail immediately instead of letting the drift sit unnoticed.
 */

let tempDir: string;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mdv2-parity-'));
  process.env.PA_HOME = tempDir;

  // A config exercising the richest real-world formatting: MarkdownV2 specials
  // in worker names, a `supersedes` relationship (parens), declared value
  // lists (commas), and observed history — the same shape dashboard.ts
  // actually renders in production.
  await writeFile(join(tempDir, 'config.yaml'), stringifyYaml({
    workers: [
      {
        name: 'agy', priority: 1, command: 'a', args: [], check: 'c', rate_limit_patterns: [],
        tunables: {
          model: {
            args: ['--model', '{value}'],
            supersedes: ['effort'],
            values: ['gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'claude-sonnet-4-6'],
          },
          effort: { args: ['--effort', '{value}'], values: ['low', 'medium', 'high'] },
        },
      },
      { name: 'gemini', priority: 2, command: 'g', args: [], check: 'c', rate_limit_patterns: [] },
    ],
  }), 'utf8');
  await writeFile(join(tempDir, 'telegram-keepawake.json'), JSON.stringify({ active: false }), 'utf8');

  const skillsPath = join(tempDir, 'skills');
  await mkdir(skillsPath);
  const briefPath = join(skillsPath, 'daily-mail-brief');
  await mkdir(briefPath);
  await writeFile(join(briefPath, 'skill.md'), '---\ncron: "45 7 * * *"\n---\np', 'utf8');
});

after(async () => {
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true });
});

const { getDashboardContent } = await import('../dashboard.js');
const { sanitizeMdV2: botSanitizeMdV2 } = await import('../telegram.js');
const { sanitizeMdV2: paSanitizeMdV2 } = await import('../../../../pa/dist/src/lib/mdv2.js');

// Hand-picked MarkdownV2-special-character strings, covering every escaping
// branch both implementations share (code spans, links, backslashes, the
// four span markers, glob asterisks, Windows paths).
const HAND_PICKED = [
  'plain text with no specials',
  '*bold* _italic_ __underline__ ~strike~ `code`',
  'node_modules/x (y).',
  '"D:\\npm-global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"',
  'topic--1001234567890_3246\n  PID 66884 (age 325s)',
  'files in commands/* and pa/*',
  '[a link](https://example.com/a_b?c=d)',
  'model: gemini-3.6-flash-high, claude-sonnet-4-6 (supersedes effort)',
  '',
  '   leading/trailing whitespace   ',
  '```js\nconst x = 1;\n```',
  'a ``nested ` backtick`` span',
];

describe('sanitizeMdV2 parity (telegram.ts vs pa/src/lib/mdv2.ts)', () => {
  it('produces identical output on hand-picked MarkdownV2-special strings', () => {
    for (const input of HAND_PICKED) {
      assert.equal(
        paSanitizeMdV2(input),
        botSanitizeMdV2(input),
        `sanitizeMdV2 drift between pa/src/lib/mdv2.ts and telegram.ts on: ${JSON.stringify(input)}`,
      );
    }
  });

  it('produces identical output on the dashboard\'s own real rendered content', async () => {
    const content = await getDashboardContent();
    assert.equal(
      paSanitizeMdV2(content),
      botSanitizeMdV2(content),
      'the two sanitizeMdV2 copies drifted on real dashboard content — dashboard.ts\'s ' +
      'length budget (measured via the pa copy) would no longer match what telegram.ts ' +
      'actually sends',
    );
  });
});
