/** README screenshots: isolated browser, actual offline rules, no model requests. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createWorld, serializeWorld, type World } from '../src/sim';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const output = join(cwd, 'docs/images');
mkdirSync(output, { recursive: true });
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const address = probe.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd, env: { ...process.env, NODE_ENV: 'production', PORT: String(port), OPENROUTER_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let startupLog = '';
for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { startupLog = (startupLog + String(data)).slice(-2000); });
let serverError: Error | undefined;
server.on('error', error => { serverError = error; });
const closed = once(server, 'close').catch(() => undefined);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let remoteAttempts = 0;
const screenshots: Array<{ file: string; locale: string; decisions: string[] }> = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverError || server.exitCode !== null) throw new Error('Screenshot server failed to start');
    try {
      const response = await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(500) });
      const status = await response.json();
      if (response.ok && status.app === 'jev-neighborhood' && status.configured === false) { ready = true; break; }
    } catch { /* Wait for our disposable child only. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'No-key screenshot server must be ready');
  browser = await chromium.launch({ headless: true });
  for (const locale of ['en', 'zh'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    const fixture = createWorld();
    // Stage a nearby resident for a reproducible conversation composition, not a model result.
    const mei = fixture.npcs.find(npc => npc.id === 'mei')!;
    Object.assign(mei, { x: 744, y: 800 });
    Object.assign(fixture.player, { x: mei.x, y: mei.y + 32 });
    for (const npc of fixture.npcs) npc.cooldown = 120;
    await context.addInitScript(save => { localStorage.setItem('jev-charactor-survival-v2', save); }, serializeWorld(fixture));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.toLowerCase() === '/api/decide') {
        remoteAttempts++;
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const snapshot = () => page.evaluate(() => (window as unknown as { __FOG_HARBOR__: { snapshot: () => World } }).__FOG_HARBOR__.snapshot());
    await page.goto(origin);
    await expect(page.locator('canvas')).toBeVisible();
    await page.locator(`.welcome-language [data-locale="${locale}"]`).click();
    await page.locator('[data-action="start"]').click();
    await page.locator('[data-action="inspect"]').click();
    await page.locator('[data-tab="debug"]').click();
    await page.locator('[data-action="mode"]').click();
    await expect(page.locator('#connection')).toContainText(locale === 'en' ? /rules/i : '规则');
    await page.locator('[data-action="close-inspector"]').click();
    // Let the real rules-mode toast expire before capturing the unobstructed map.
    await expect(page.locator('#toast')).not.toHaveClass(/visible/, { timeout: 6000 });
    if (locale === 'en') {
      const untranslated = await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const missing: string[] = []; let node: Node | null;
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (!parent || parent.closest('script,style,[data-locale]') || !parent.getClientRects().length) continue;
          if (/[\u3400-\u9fff]/u.test(node.textContent ?? '')) missing.push(node.textContent!.trim());
        }
        return missing;
      });
      assert.deepEqual(untranslated, [], 'README English overview must have no untranslated visible authored DOM text');
      const canvasText = await page.evaluate(() => (window as unknown as { __FOG_HARBOR__: { canvasText: () => string[] } }).__FOG_HARBOR__.canvasText());
      assert.deepEqual(canvasText.filter(text => /[\u3400-\u9fff]/u.test(text)), [], 'README English map must have localized canvas labels');
    }
    await page.screenshot({ path: join(output, `fog-harbor-${locale}.png`) });
    screenshots.push({ file: `fog-harbor-${locale}.png`, locale, decisions: (await snapshot()).decisions.map(d => d.source) });
    if (locale === 'en') {
      await page.keyboard.press('e');
      await expect(page.locator('#conversation-bar')).toBeVisible();
      await page.locator('[data-interact="ask:plans"]').click();
      await page.waitForFunction(() => {
        const world = (window as unknown as { __FOG_HARBOR__: { snapshot: () => World } }).__FOG_HARBOR__.snapshot();
        return world.decisions.some(d => d.npcId === 'mei') && !world.npcs.find(n => n.id === 'mei')?.pendingInteraction;
      });
      await expect(page.locator('#conversation-bar .speech')).not.toBeEmpty();
      assert.doesNotMatch(await page.locator('#conversation-bar .speech').innerText(), /[\u3400-\u9fff]/, 'English screenshot must have a localized reply');
      const world = await snapshot();
      assert(world.decisions.every(d => d.source === 'rules'), 'Only actual local rules decisions are allowed');
      await page.screenshot({ path: join(output, 'dialogue-en.png') });
      screenshots.push({ file: 'dialogue-en.png', locale, decisions: world.decisions.map(d => d.source) });
    }
    assert.deepEqual(errors, [], 'No browser page errors');
    await context.close();
  }
  assert.equal(remoteAttempts, 0, 'No model or external network requests should be attempted');
  writeFileSync(join(output, 'capture.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), method: 'scripts/capture-readme.ts', mode: 'actual offline rules',
    setup: 'Disposable browser/save; staged player and Mei positions; NPC cooldowns delayed for map framing.',
    remoteRequests: 0, viewport: { width: 1440, height: 1000 }, screenshots,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ screenshots: screenshots.map(s => s.file), remoteRequests: 0 }));
} catch (error) {
  console.error(startupLog);
  throw error;
} finally {
  try { await browser?.close(); }
  finally {
    if (server.exitCode === null) server.kill('SIGTERM');
    const timeout = setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); }, 2000);
    timeout.unref();
    await closed;
    clearTimeout(timeout);
  }
}
