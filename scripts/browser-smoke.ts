/** UI regression checks only: every decision/status response is a local test fixture. */
import { translate, translateIdentity, setLocale, type Locale } from '../src/i18n';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorld, loadWorld, serializeWorld, getPlayerInteractions, performService, advance, type World } from '../src/sim';
import { notePersonalEvent } from '../src/sim/personalLife';

const locale: Locale = process.env.E2E_LOCALE==='zh'?'zh':'en';
setLocale(locale);
const t=(value:string)=>translate(value,locale);
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:4317';
const origin = new URL(baseURL).origin;
const outputDir = path.resolve('artifacts', `browser-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(outputDir, { recursive: true });
const fixture = createWorld();
const mei = fixture.npcs.find(n => n.id === 'mei')!;
Object.assign(mei, { x: 744, y: 800 });
Object.assign(fixture.player, { x: mei.x, y: mei.y + 32 });
for (const npc of fixture.npcs) npc.cooldown = 120;
notePersonalEvent(mei, 'gift', 'ui-fixture-past-gift', fixture.time);
assert(loadWorld(serializeWorld(fixture)), 'The isolated UI fixture must be a valid game save');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const page = await context.newPage();
page.setDefaultTimeout(10_000);
const pageErrors: string[] = [];
const requests: Array<{ npcId: string; revision: number; choice?: string; outcome: string; model: string }> = [];
const checks: string[] = [];
const replies: Array<{ action: string; text: string; choice: string }> = [];
let failureMode = false;
let failure: string | undefined;
page.on('pageerror', error => pageErrors.push(error.message));
// A new, non-persistent context cannot access the user's IAB/localStorage. Seed only once;
// reloading subsequently reads the save produced through the game's own Save button.
await context.addInitScript(({ save, key, locale }) => {
  if (!sessionStorage.getItem('browser-smoke-seeded')) {
    localStorage.setItem(key, save);
    if(locale==='zh')localStorage.setItem('fog-harbor-language','zh');
    sessionStorage.setItem('browser-smoke-seeded', 'yes');
  }
}, { save: serializeWorld(fixture), key: 'jev-charactor-survival-v2', locale });
// Intercept the complete API namespace, and block external traffic: this script never calls a paid model.
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort('blockedbyclient');
  if (url.pathname === '/api/status') return route.fulfill({ json: { configured: true, model: 'ui-test-fixture' } });
  if (url.pathname === '/api/decide') {
    const body = route.request().postDataJSON() as { npcId: string; revision: number; options: Array<{ id: string }> };
    assert.equal(body.npcId, 'mei', 'Only the focused NPC is expected to decide in this controlled fixture');
    if (failureMode) {
      requests.push({ npcId: body.npcId, revision: body.revision, outcome: 'mock-upstream-401', model: 'ui-test-fixture' });
      return route.fulfill({ status: 401, json: { error: 'upstream_401' } });
    }
    const choice = ['reply:detail', 'reply:goal', 'reply:feeling', 'reply'].find(id => body.options.some(option => option.id === id));
    assert(choice, 'The UI scenario must offer an authored dialogue response');
    requests.push({ npcId: body.npcId, revision: body.revision, choice, outcome: 'mock-success', model: 'ui-test-fixture' });
    return route.fulfill({ json: { npcId: body.npcId, revision: body.revision, choice, affect: 'warm', model: 'ui-test-fixture', latencyMs: 0, confidence: .85, cost: 0 } });
  }
  if (url.pathname.startsWith('/api/')) return route.abort('blockedbyclient');
  return route.continue();
});
async function capture(name: string) {
  // A screenshot-only label makes the synthetic transport provenance visible outside the JSON report.
  await page.evaluate(() => {
    const label = document.createElement('div');
    label.id = 'smoke-provenance';
    label.textContent = 'UI 回归测试 · 决策为本地 fixture · 未调用 Jev';
    Object.assign(label.style, { position: 'fixed', top: '0', left: '35%', zIndex: '999999', background: '#24372f', color: '#fff', padding: '6px 12px', fontSize: '12px', pointerEvents: 'none' });
    document.body.append(label);
  });
  try { await page.screenshot({ path: path.join(outputDir, name), fullPage: true }); }
  finally { await page.evaluate(() => document.getElementById('smoke-provenance')?.remove()); }
}
const snapshot = () => page.evaluate(() => (window as unknown as { __FOG_HARBOR__: { snapshot: () => World } }).__FOG_HARBOR__.snapshot());
const resident = (world: World) => world.npcs.find(n => n.id === 'mei')!;
const positions = (world: World) => world.npcs.map(n => ({ id: n.id, x: n.x, y: n.y }));
const possessions = (world: World) => ({ money: world.player.money, inventory: world.player.inventory, goals: resident(world).mind.personal.goals, commitments: resident(world).mind.commitments });
const followup = (world: World) => {
  const option = getPlayerInteractions(world, 'mei').find(a => a.parameters.topic === 'plan');
  assert(option, 'The previous spoken plan must provide a contextual follow-up');
  return option.id;
};
async function checkEnglish(surface: string) {
  const layouts=await page.evaluate(()=>(window as unknown as {__FOG_HARBOR__:{canvasLayout:()=>Array<{textBottom:number;panelBottom:number;textRight:number;panelRight:number;panelHeight:number;hitAreaHeight:number}|null>}}).__FOG_HARBOR__.canvasLayout());
  for(const layout of layouts){
    assert(layout,`Navigation layout exists on ${surface}`);
    assert(layout.panelBottom>=layout.textBottom+10,`Navigation caption fits inside its background on ${surface}`);
    assert(layout.panelRight>=layout.textRight,`Navigation caption fits the panel width on ${surface}`);
    assert.equal(layout.hitAreaHeight,layout.panelHeight,'The expanded minimap background also captures pointer input');
  }
  if(locale!=='en')return;
  const chinese=await page.evaluate(()=>Array.from(document.querySelectorAll<HTMLElement>('#app *')).filter(e=>e.checkVisibility()&&!e.closest('[translate="no"]')).flatMap(e=>[...Array.from(e.childNodes).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent??''),e.getAttribute('aria-label')??'',e.getAttribute('title')??'']).filter(text=>/[\u3400-\u9fff]/u.test(text)));
  const canvas=await page.evaluate(()=>(window as unknown as {__FOG_HARBOR__:{canvasText:()=>string[]}}).__FOG_HARBOR__.canvasText().filter(text=>/[\u3400-\u9fff]/u.test(text)));
  assert.deepEqual({chinese,canvas},{chinese:[],canvas:[]},`English ${surface} and accessible/canvas text must have complete authored translations`);
}
async function speak(action: string) {
  const before = await snapshot();
  const count = before.decisions.length;
  await page.locator(`[data-interact="${action}"]`).click();
  await page.waitForFunction(previous => {
    const world = (window as unknown as { __FOG_HARBOR__: { snapshot: () => World } }).__FOG_HARBOR__.snapshot();
    return world.decisions.length > previous && !world.npcs.find(n => n.id === 'mei')?.pendingInteraction;
  }, count);
  const after = await snapshot();
  assert.equal(after.time, before.time, 'A reply executes without advancing the paused world');
  assert.deepEqual(positions(after), positions(before), 'Residents remain stationary during dialogue');
  const reply = resident(after).bubble!;
  await expect(page.locator('#conversation-bar .speech')).toHaveText(t(reply));
  replies.push({ action, text: reply, choice: after.decisions.at(-1)!.choice });
  return after;
}
try {
  await page.goto(baseURL);
  await expect(page.locator('html')).toHaveAttribute('lang',locale==='en'?'en':'zh-CN');
  await expect(page.locator('.welcome-language')).toBeVisible();
  await checkEnglish('welcome');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('[data-action="start"]')).toContainText(t('继续在雾港的生活'));
  await page.locator('[data-action="start"]').click();
  await page.keyboard.press('e');
  await expect(page.getByRole('region', { name: t('当前交谈') })).toBeVisible();
  await expect(page.locator('#conversation-bar h2')).toContainText(t('梅姐'));
  checks.push('canvas, start, and nearby NPC conversation');
  const conversationStart = await snapshot();
  const otherLocale=locale==='en'?'zh':'en';
  await page.locator(`.header-right [data-locale="${otherLocale}"]`).click();
  await expect(page.locator('#conversation-bar h2')).toContainText(translate('梅姐',otherLocale));
  assert.deepEqual(await snapshot(),conversationStart,'Switching language during a paused conversation never mutates the world');
  await page.locator(`.header-right [data-locale="${locale}"]`).click();
  checks.push('language selector and mid-dialogue switching preserve the canonical world');
  // Two rendered animation frames provide an observable pause check without advancing simulation manually.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal((await snapshot()).time, conversationStart.time);
  const plan = await speak('ask:plans');
  const planSubject = resident(plan).mind.dialogue.turns.filter(t => t.speaker === 'self').at(-1)!.subject;
  const detail = await speak(followup(plan));
  const returnToPlan = followup(detail);
  const feeling = await speak('ask:feelings');
  assert.equal(getPlayerInteractions(feeling, 'mei').find(a => a.id === returnToPlan)?.parameters.topic, 'plan');
  const returned = await speak(returnToPlan);
  const finalTurn = resident(returned).mind.dialogue.turns.filter(t => t.speaker === 'self').at(-1)!;
  assert.equal(finalTurn.subject, planSubject, 'Returning to a plan preserves its original subject');
  assert.equal(finalTurn.topic, 'plan');
  assert.equal(new Set(replies.map(r => r.text)).size, replies.length, 'These authored dialogue steps have distinct replies');
  assert.deepEqual(possessions(returned), possessions(conversationStart), 'Talking does not complete goals, create promises, pay money, or create items');
  checks.push('paused world accepts replies', 'plan → follow-up → feeling → original plan', 'no invented material rewards or goal completion');
  await checkEnglish('conversation');
  await capture('conversation.png');
  await page.locator('[data-action="end-conversation"]').click();
  await expect(page.getByRole('region', { name: t('当前交谈') })).toBeHidden();
  await page.waitForFunction(time => (window as unknown as { __FOG_HARBOR__: { snapshot: () => World } }).__FOG_HARBOR__.snapshot().time > time, returned.time);
  await page.locator('[data-action="pause"]').click();
  await page.locator('[data-action="save"]').click();
  const saved = await snapshot();
  await page.reload();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang',locale==='en'?'en':'zh-CN');
  const restored = await snapshot();
  assert.deepEqual(restored.player, saved.player);
  assert.deepEqual(resident(restored).mind.dialogue, resident(saved).mind.dialogue);
  assert.deepEqual(resident(restored).mind.personal.goals, resident(saved).mind.personal.goals);
  assert.equal(restored.time, saved.time);
  checks.push('ending conversation resumes time', 'save/reload preserves player, dialogue history, goals, and world time');
  await page.locator('[data-action="start"]').click();
  await page.locator('[data-action="pause"]').click();
  await page.locator('[data-action="inspect"]').click();
  for(const name of ['life','people','journal','debug']) {
    await page.locator(`[data-tab="${name}"]`).click();
    await checkEnglish(`${name} inspector`);
  }
  await page.locator('[data-action="close-inspector"]').click();
  await page.locator('[data-action="guide"]').click();
  await checkEnglish('guide');
  await page.locator('#guide .dialog-close').click();
  checks.push('English welcome, map, inspector tabs, guide and accessibility coverage');
  failureMode = true;
  await page.locator('[data-action="pause"]').click();
  await page.keyboard.press('e');
  await expect(page.getByRole('region', { name: t('当前交谈') })).toBeVisible();
  const beforeFailure = await snapshot();
  await page.locator('[data-interact="greet"]').click();
  await expect(page.locator('#connection')).toContainText(locale==='en'?'API key verification failed':'密钥验证失败');
  const failed = await snapshot();
  assert.equal(failed.decisions.length, beforeFailure.decisions.length, 'An API failure never fabricates a successful reply');
  assert.equal(failed.time, beforeFailure.time);
  await capture('connection-error.png');
  await page.locator('[data-action="end-conversation"]').click();
  await page.waitForFunction(time => (window as unknown as { __FOG_HARBOR__: { snapshot: () => World } }).__FOG_HARBOR__.snapshot().time > time, failed.time);
  checks.push('visible connection error, no fabricated decision, and recoverable exit');
  failureMode=false;
  const serviceFixture=createWorld();
  for(const npc of serviceFixture.npcs)npc.cooldown=120;
  Object.assign(serviceFixture.player,{x:1032,y:456});
  await page.addInitScript(save=>{if(!sessionStorage.getItem('service-fixture-seeded')){localStorage.setItem('jev-charactor-survival-v2',save);sessionStorage.setItem('service-fixture-seeded','yes');}},serializeWorld(serviceFixture));
  await page.reload();
  await page.locator('[data-action="start"]').click();
  await page.keyboard.press('e');
  await expect(page.locator('[data-service="buy:热饭"]')).toBeVisible();
  await checkEnglish('teahouse services');
  await page.locator('[data-service="buy:热饭"]').click();
  assert((await snapshot()).player.inventory.includes('热饭'),'Purchasing uses the canonical food ID');
  await page.locator('[data-action="close-scene"]').click();
  await page.keyboard.press('b');
  await checkEnglish('bag');
  await expect(page.locator('[data-service="eat:热饭"]')).toBeVisible();
  await page.locator('[data-service="eat:热饭"]').click();
  assert(!(await snapshot()).player.inventory.includes('热饭'),'Eating uses the canonical food ID');
  checks.push('localized service and bag actions preserve canonical food identifiers');
  const hostile = createWorld();
  for (const npc of hostile.npcs) npc.cooldown = 120;
  Object.assign(hostile.player,{x:1032,y:456});
  performService(hostile,`accept:${hostile.survival.orders[0].id}`);advance(hostile,5);advance(hostile,2);performService(hostile,'pickup');
  assert.equal(hostile.survival.orders[0].status,'carrying','Custom-identity fixture must carry a delivery');
  hostile.npcs[0].path=[];hostile.npcs[0].cooldown=120;
  hostile.npcs[0].name = '林舟，custom';
  hostile.npcs[0].role = '去林舟';
  Object.assign(hostile.npcs[0],{x:744,y:800});
  Object.assign(hostile.player,{x:744,y:832});
  hostile.npcs[1].name = '自定义热饭 <img src=x onerror="window.name=1">';
  hostile.npcs[1].role = '<svg onload="window.name=2">';
  assert(loadWorld(serializeWorld(hostile)), 'The malicious-name fixture passes save validation');
  await page.addInitScript(save => localStorage.setItem('jev-charactor-survival-v2', save), serializeWorld(hostile));
  await page.reload();
  await expect(page.locator('canvas')).toBeVisible();
  await page.locator('[data-action="start"]').click();
  await page.locator('[data-action="inspect"]').click();
  await page.locator('[data-tab="people"]').click();
  const inspectedResident = page.locator(`[data-inspect-npc="${hostile.npcs[0].id}"]`);
  await inspectedResident.focus();
  const inspection = await page.evaluate(() => ({
    time: (window as unknown as { __FOG_HARBOR__: { snapshot: () => World } }).__FOG_HARBOR__.snapshot().time,
    needs: document.querySelector('.npc-needs')!.innerHTML,
  }));
  // Prove a live details refresh occurred; a full simulated second requires at
  // least 20 WebGL frames because simulation delta is capped at 50 ms per frame.
  try {
    await page.waitForFunction(before => {
      const world = (window as unknown as { __FOG_HARBOR__: { snapshot: () => World } }).__FOG_HARBOR__.snapshot();
      const needs = document.querySelector('.npc-needs');
      return world.time > before.time && needs !== null && needs.innerHTML !== before.needs;
    }, inspection, { polling: 100 });
  } catch (error) {
    const observed = await page.evaluate(() => ({
      time: (window as unknown as { __FOG_HARBOR__: { snapshot: () => World } }).__FOG_HARBOR__.snapshot().time,
      hidden: document.hidden,
      paused: !(document.getElementById('pause-overlay') as HTMLElement).hidden,
      conversationOpen: !(document.getElementById('conversation-bar') as HTMLElement).hidden,
      needs: document.querySelector('.npc-needs')?.innerHTML,
    }));
    throw new Error(`Live resident details did not refresh: ${JSON.stringify({ beforeTime: inspection.time, observed, needsChanged: observed.needs !== inspection.needs })}`, { cause: error });
  }
  await expect(inspectedResident).toBeFocused();
  const otherResident = page.locator(`[data-inspect-npc="${hostile.npcs[1].id}"]`);
  await otherResident.focus();
  await otherResident.press('Enter');
  await expect(page.locator('.person-heading h2')).toContainText(t(hostile.npcs[1].name));
  await expect(otherResident).toBeFocused();
  assert.equal(await page.locator('#panel img, #panel svg, #panel [onerror], #panel [onload]').count(),0);
  checks.push('resident picker retains keyboard focus through live updates and selection');
  await page.locator(`[data-inspect-npc="${hostile.npcs[0].id}"]`).click();
  await expect(page.locator('.person-heading h2')).toContainText(hostile.npcs[0].name);
  await expect(page.locator('.person-heading h2 span')).toHaveText(hostile.npcs[0].role);
  await expect(page.locator(`[data-inspect-npc="${hostile.npcs[0].id}"]`)).toHaveAttribute('aria-label', `${locale==='en'?'View ':'查看'}${translateIdentity(hostile.npcs[0].name,locale)}`);
  assert.equal(await page.locator('#panel img, #panel svg, #panel [onerror], #panel [onload]').count(), 0);
  assert.equal(await page.evaluate(() => window.name), '', 'Saved text never executes as markup');
  checks.push('saved NPC name and role render literally without executable markup');
  await page.locator('[data-action="close-inspector"]').click();
  await page.keyboard.press('e');
  await expect(page.locator('#conversation-bar h2')).toContainText(hostile.npcs[0].name);
  await expect(page.locator('#conversation-bar h2 small')).toHaveText(hostile.npcs[0].role);
  const canvasIdentity=await page.evaluate(()=>(window as unknown as {__FOG_HARBOR__:{canvasText:()=>string[]}}).__FOG_HARBOR__.canvasText());
  assert(canvasIdentity.includes(hostile.npcs[0].name),'Canvas preserves the custom saved name literally');
  await expect(page.locator('#objective')).toContainText(locale==='en'?`Deliver the meal to ${hostile.npcs[0].name}`:`把外卖送给${hostile.npcs[0].name}`);
  assert(canvasIdentity.some(text=>text.includes(`${hostile.npcs[0].name} · ${locale==='en'?'Recipient':'收件人'}`)),'Delivery navigation and marker keep the customer identity literal');
  assert(canvasIdentity.includes(locale==='en'?`E  Deliver to ${hostile.npcs[0].name}`:`E  向${hostile.npcs[0].name}交付外卖`),'Canvas prompt preserves the same literal custom name');
  await page.locator(`.header-right [data-locale="${locale==='en'?'zh':'en'}"]`).click();
  await expect(page.locator('#conversation-bar h2')).toContainText(hostile.npcs[0].name);
  await expect(page.locator('#conversation-bar h2 small')).toHaveText(hostile.npcs[0].role);
  checks.push('template-like custom identities stay literal in DOM, accessibility, canvas and conversation prompts');

  const deniedContext=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  try {
    const deniedPage=await deniedContext.newPage();
    deniedPage.on('pageerror',error=>pageErrors.push(error.message));
    await deniedContext.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin)return route.abort('blockedbyclient');
      if(url.pathname==='/api/status')return route.fulfill({json:{configured:false,model:'ui-test-fixture'}});
      if(url.pathname.startsWith('/api/'))return route.abort('blockedbyclient');
      return route.continue();
    });
    await deniedPage.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage denied','SecurityError');}}));
    await deniedPage.goto(baseURL);
    await expect(deniedPage.locator('[data-action="start"]')).toHaveText('Start day one →');
    await deniedPage.locator('.welcome-language [data-locale="zh"]').click();
    await expect(deniedPage.locator('[data-action="start"]')).toHaveText('开始第一天 →');
    await deniedPage.locator('[data-action="start"]').click();
    await expect(deniedPage.locator('canvas')).toBeVisible();
    checks.push('denied storage starts in English and language selection remains usable');
  } finally {await deniedContext.close();}
  assert.deepEqual(pageErrors, [], 'No browser runtime errors');
  checks.push('no browser runtime errors');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  await capture('failure.png').catch(() => undefined);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', locale, baseURL, source: 'ui-test-fixture', realModelCalls: 0, scope: 'Isolated browser UI regression. Not Jev quality, autonomy, or dialogue naturalness evidence.', checks, replies, requests, pageErrors, failure }, null, 2) + '\n');
  await context.close();
  await browser.close();
}
console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', checks: checks.length, outputDir, source: 'ui-test-fixture', realModelCalls: 0, ...(failure ? { failure } : {}) }, null, 2));
