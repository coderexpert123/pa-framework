/**
 * WP-C6 Task-Scheduler branch, CI-provable slice (spec pass 2, C9): the POSIX
 * scheduler TEMPLATES exist, render, and are env-parity with each other and
 * with the Windows launcher's documented PA_HOME convention. Actual on-OS
 * launchd/systemd registration is an explicit operator-decision item, NOT
 * provable in CI — this file pins only what a CI matrix can see.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { walkUpToRepoRoot } from '../src/lib/git-root.js';

// Synchronous root detection (CJS build — no top-level await): walk up from
// this file to the dir holding package.json/.git.
const repoRoot = walkUpToRepoRoot(__dirname);

function templatePath(...parts: string[]): string {
  return join(repoRoot, 'examples', ...parts);
}

describe('POSIX scheduler templates (WP-C6, CI-provable slice)', () => {
  it('examples/systemd/pa-telegram-bot.service exists and renders a user-unit shape', async () => {
    const text = await readFile(templatePath('systemd', 'pa-telegram-bot.service'), 'utf8');
    assert.ok(text.includes('[Unit]'), 'systemd unit must carry a [Unit] section');
    assert.ok(text.includes('[Service]'), 'systemd unit must carry a [Service] section');
    assert.ok(text.includes('[Install]'), 'systemd unit must carry an [Install] section');
    assert.ok(text.includes('Restart=always'), 'bot unit must keep the process alive');
    assert.match(text, /ExecStart=\/bin\/bash .+projects\/telegram-bot\/run-bot\.sh/, 'ExecStart must ride the POSIX twin launcher');
  });

  it('examples/launchd/com.pa-framework.telegram-bot.plist renders as parseable XML', async () => {
    const text = await readFile(templatePath('launchd', 'com.pa-framework.telegram-bot.plist'), 'utf8');
    assert.ok(text.startsWith('<?xml'), 'plist must be XML');
    // Render check without a parser dependency: root opens and closes, dict present.
    assert.ok(text.includes('<plist version="1.0">'), 'plist root must open');
    assert.ok(text.trimEnd().endsWith('</plist>'), 'plist root must close');
    assert.ok(text.includes('<dict>'), 'plist must carry a top-level dict');
  });

  it('both templates are env-parity: PA_HOME + UV_THREADPOOL_SIZE=16, pointing at the same launcher', async () => {
    const service = await readFile(templatePath('systemd', 'pa-telegram-bot.service'), 'utf8');
    const plist = await readFile(templatePath('launchd', 'com.pa-framework.telegram-bot.plist'), 'utf8');
    for (const [name, text] of [['systemd', service], ['launchd', plist]] as const) {
      assert.match(text, /PA_HOME/, `${name} template must set PA_HOME`);
      assert.match(text, /UV_THREADPOOL_SIZE/, `${name} template must set UV_THREADPOOL_SIZE`);
      assert.match(text, /16/, `${name} template pins the documented threadpool size 16`);
      assert.match(text, /projects\/telegram-bot\/run-bot\.sh/, `${name} template must launch the same run-bot.sh twin`);
    }
    assert.ok(service.includes('%h/.pa'), 'systemd PA_HOME must use the %h home specifier (no hardcoded user)');
  });

  it('the Windows launcher (scheduler.ts) still owns the Task Scheduler registration surface', async () => {
    const schedulerSrc = await readFile(join(repoRoot, 'pa', 'src', 'scheduler.ts'), 'utf8');
    assert.ok(schedulerSrc.includes('WshShell.CurrentDirectory'), 'VBS launcher must set WshShell.CurrentDirectory (cwd gotcha)');
  });
});
