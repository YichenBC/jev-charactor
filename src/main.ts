import './style.css';
import { getLocale, translate, presentObjective, translateIdentity, setLocale, restoreLocale, onLocaleChange, localizeDOM, followUpDescription, LANGUAGE_KEY } from './i18n';
try { restoreLocale(localStorage); } catch { setLocale('en'); }
import { createGame, type Neighborhood } from './game';
import { DecisionController } from './controller';
import { ConversationSession } from './conversation';
import { inspectKnowledge } from './character';
import { inspectPersonal } from './character/personal';
import { rankActions } from './character/motivation';
import { getNpcMotivation } from './sim/motivation';
import { getOptions } from './sim';
import { createWorld, loadWorld, serializeWorld, getPlayerInteractions, playerInteract, describeFact, activeOrder, dayOf, worldClock, nearestPlace, performService, objective, FOOD, PLAZA, BUILDINGS, distance, isFood, orderCondition, type World, type Npc } from './sim';

const SAVE_KEY = 'jev-charactor-survival-v2';
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!);
const identity=(value:unknown)=>`<bdi translate="no">${esc(translateIdentity(value))}</bdi>`;
let saved: World | null = null, storageError = false;
try { const raw = localStorage.getItem(SAVE_KEY) || localStorage.getItem('jev-neighborhood-save-v1'); if (raw) saved = loadWorld(raw); } catch { storageError = true; }
let world = saved || createWorld(), selected = world.npcs[0].id;
let started = false, paused = false, tab: 'life'|'people'|'journal'|'debug' = 'life';
const conversation = new ConversationSession();
const restoredConversation = world.npcs.find(n => n.pendingInteraction && distance(world.player, n) <= 110);
if (restoredConversation) { conversation.open(world, restoredConversation.id); selected = restoredConversation.id; tab = 'people'; }
let lastPanelHtml = '', lastResidentsHtml = '', panelPointerDown = false;
let lastConversationHtml = '', lastSceneHtml = '';
let scenePanel: 'place' | 'bag' | null = null, inspectorOpen = false;
let dialogueBaseline: World['decisions'][number] | undefined;
let toastTimer: ReturnType<typeof setTimeout>;
const el = (id: string) => document.getElementById(id)!;
const phaseLabel: Record<string,string> = {planning:'打算',acting:'进行中',waiting:'等候',completed:'已完成',interrupted:'已打断'};
const commitmentLabel: Record<string,string> = {active:'约定中',fulfilled:'已履行',broken:'已失约'};
const bios: Record<string,string> = {lin:'谨慎、重承诺。可靠的工作比空话更能赢得他的信任。',tang:'好奇而宽容。诚实解释一次失误，她往往愿意理解。',mei:'讲究实际的生意人。看重付出的劳动和清楚的约定。',lan:'忙碌的送信人，很看重准时。屡次耽误会让他失去耐心。',zhou:'耐心的老街坊。关照邻居，也记得谁曾说到做到。'};
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header class="topbar"><div class="brand"><span class="brand-mark">雾</span><div><h1>雾港生活<span>JEV · CHARACTOR</span></h1><p>说过的话，做过的事，都会留下痕迹。</p></div></div><div class="header-right"><div class="language-picker" aria-label="Language / 语言" translate="no"><button data-locale="en" lang="en">English</button><button data-locale="zh" lang="zh-CN">中文</button></div><div id="connection" class="connection"></div><button class="icon-button" data-action="pause" id="pause">Ⅱ 暂停</button><button class="icon-button" data-action="save">保存</button></div></header>
<div id="vitals" class="vitals" aria-label="生存状态"></div>
<main class="layout"><section class="play-area" aria-label="雾港游戏地图"><div id="game"></div><div class="scene-top"><div class="location-chip"><i></i>雾港 · 老街区 <small id="clock"></small></div><div class="scene-tools"><button class="map-button" data-action="bag">背包 <kbd>B</kbd></button><button class="map-button" data-action="inspect" aria-controls="inspector" aria-expanded="false">档案 / 手记</button><button class="map-button" data-action="guide">? 操作</button></div></div>
<div id="objective" class="objective-chip"></div><div class="scene-bottom"><div class="live-caption"><span class="live-dot"></span><span id="world-caption"></span></div><div id="event-peek" class="event-peek"></div></div><div id="toast" role="status" aria-live="polite"></div>
<section id="conversation-bar" class="game-card conversation-card" role="region" aria-label="当前交谈" hidden></section><section id="scene-panel" class="game-card service-card" role="region" aria-label="场景交互" hidden></section>
<div id="welcome" class="welcome-scrim"><div class="welcome-card"><div class="language-picker welcome-language" aria-label="Language / 语言" translate="no"><button data-locale="en" lang="en">English</button><button data-locale="zh" lang="zh-CN">中文</button></div><span class="eyebrow">A NEW LIFE IN FOG HARBOR</span><h2>二十元，<br><em>从今天过下去。</em></h2><p>先往东北走，到晚风茶馆接一份外卖。<br>取餐、送到、交付，赚到你的第一笔生活费。<br>饿了吃东西，累了歇脚。街坊会记住你。</p><div class="welcome-controls"><span><kbd>W A S D</kbd> 移动</span><span><kbd>E</kbd> 交谈 / 地点</span></div><button class="primary" data-action="start">${saved?'继续在雾港的生活':'开始第一天'} →</button><small>先活到第三天，完成三次配送。然后，生活继续。</small></div></div>
<div id="pause-overlay" class="pause-overlay" hidden>世界已暂停<small>时间、体力和订单都暂停，点击「继续」返回。</small></div>
<div id="death-overlay" class="death-overlay" hidden><span class="eyebrow">THIS CHAPTER ENDS</span><h2>这次没能撑下去。</h2><p id="death-detail"></p><button class="primary" data-action="restart">重新开始 →</button><button class="secondary" data-action="export">保存这段经历</button></div>
</section><aside id="inspector" class="sidebar" aria-label="角色档案与记录" hidden><div class="inspector-heading"><strong>雾港档案</strong><button class="secondary" data-action="close-inspector" aria-label="关闭档案">关闭 ×</button></div><nav class="tabs" aria-label="侧栏"><button data-tab="life">生活</button><button data-tab="people">人物</button><button data-tab="journal">手记</button><button data-tab="debug">记录</button></nav><div id="panel" class="panel"></div><div class="sidebar-footer"><span>☷ 背包</span><span id="inventory"></span></div></aside></main>
<footer class="bottom-bar"><span><kbd>W A S D</kbd> / 方向键 移动 · <kbd>Shift</kbd> 跑步 · <kbd>E</kbd> 交谈 / 地点 · <kbd>B</kbd> 背包</span><span id="save-status">${saved?'已恢复本机存档':'每 15 秒自动保存'}</span></footer>
<dialog id="guide"><form method="dialog"><button class="dialog-close" aria-label="关闭">×</button><span class="eyebrow">LIVING IN FOG HARBOR</span><h2>先照顾自己，再认识街坊。</h2><p>WASD / 方向键移动，也可以点击地面行走；Shift 跑步，E 打开身旁的居民或地点。也可以点击居民。右上小地图的金点是当前目的地。</p><p>第一单：到晚风茶馆门口，按 E 接单，等待 6 秒取餐。送到金色标记，走近收件人，在画面下方的交谈选项中点击交付。只有实际交付才会结算。迟到或餐凉后，可以解释并交付；对方决定全款、减款还是拒收。</p><p>按 B 打开背包，买来的食物点击「吃用」。广场、临水亭可免费休息；小院住宿 12 元恢复体力和健康；没钱时去驿站做 18 秒短工挣 12 元。工作中可以中止，但没有报酬。</p><p>一天为 6 分钟。饱腹耗尽会损失健康，体力低会走得慢。走近居民按 E 或点击居民交谈时，世界暂停；读完回复后点击「结束交谈」或按 Esc，再恢复探索。帮忙等计时活动也在结束交谈后开始。隐藏游戏页面、打开说明或手动暂停时，时间停止。第三天且完成三单即站稳脚跟，之后继续生活。</p><p class="subtle">动作和回应意图由 Jev 选择，台词为预写表达。角色会保留经历、信任和履约记录。记录页明确区分真实 Jev 与规则演示。</p><button class="primary">回到街区 →</button></form></dialog>
<dialog id="restart-dialog"><form method="dialog"><h2>重新开始一段生活？</h2><p>当前存档将被替换。可先到记录页导出经历。</p><div class="dialog-actions"><button class="secondary">留在这里</button><button class="primary" id="confirm-restart" type="button">重新开始</button></div></form></dialog>`;
const updateLanguage = localizeDOM(el('app'));
onLocaleChange(()=>{lastPanelHtml='';lastResidentsHtml='';lastConversationHtml='';lastSceneHtml='';refresh();});
function currentObjective() {
  const order=activeOrder(world);
  return presentObjective(objective(world),order?.status==='carrying'?world.npcs.find(n=>n.id===order.customerId)?.name:undefined);
}
function enabled() { return started && !paused && !world.survival.dead && !document.hidden && !document.querySelector('dialog[open]'); }
function running() { return enabled() && !conversation.npcId; }
function toast(message:string) { el('toast').textContent=message; el('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>{el('toast').classList.remove('visible');el('toast').textContent='';},4200); }
function refresh() { renderStatus(); renderPanel(); renderScene(); updateLanguage(); }
const decisions = new DecisionController({world:()=>world,running:()=>Boolean(enabled()),conversation:()=>conversation.npcId,changed:refresh,notify:toast});
function save(silent=false) { try { localStorage.setItem(SAVE_KEY,serializeWorld(world)); el('save-status').textContent=`已保存 · ${new Date().toLocaleTimeString(getLocale()==='en'?'en-GB':'zh-CN',{hour:'2-digit',minute:'2-digit'})}`; if(!silent)toast('进度已保存在本机。'); } catch { el('save-status').textContent='存档失败，请导出经历'; if(!silent)toast('浏览器无法保存，请在记录页导出。'); } }
function enterConversation(id: string) {
  if (!started) return false;
  const previous = conversation.npcId;
  if (!conversation.open(world, id)) return false;
  scenePanel = null; inspectorOpen = false;
  if (previous !== conversation.npcId) { decisions.cancel(); dialogueBaseline=world.decisions.filter(d=>d.npcId===id).at(-1); }
  return true;
}
function closeConversation() {
  decisions.cancel(); conversation.close(world); save(true); refresh();
}
function openNpc(id:string) { if(!running())return; selected=id; tab='people'; if(!enterConversation(id))inspectorOpen=true; refresh(); }
function openLife() { if(!running() || scenePanel || inspectorOpen)return; scenePanel='place'; refresh(); }
const game=createGame(el('game'), {world:()=>world,running:()=>Boolean(running()),controlsEnabled:()=>!scenePanel&&!inspectorOpen,selected:()=>conversation.npcId??(inspectorOpen&&tab==='people'?selected:undefined),interact:openNpc,openLife});
Object.defineProperty(window,'__FOG_HARBOR__',{value:{snapshot:()=>structuredClone(world),canvasText:()=>game.scene.getScenes().flatMap(scene=>(scene as Neighborhood).presentationText()),canvasLayout:()=>game.scene.getScenes().map(scene=>(scene as Neighborhood).navigationLayout())},writable:false});
function avatar(n:Npc,large=false) { return `<span class="avatar ${large?'large':''}" style="--coat:${esc(n.color)}"></span>`; }
function service(id:string,label:string,disabled=false,literal=false) { return `<button data-service="${esc(id)}" ${disabled||!running()||Boolean(world.player.activity)?'disabled':''}><span ${literal?'translate="no"':''}>${esc(label)}</span><span>↗</span></button>`; }
function direction(target:{x:number;y:number}) { const dx=target.x-world.player.x,dy=target.y-world.player.y; if(Math.hypot(dx,dy)<95)return '就在附近'; return `${Math.abs(dx)>60?(dx<0?'西':'东'):''}${Math.abs(dy)>60?(dy<0?'北':'南'):''} · ${Math.ceil(Math.hypot(dx,dy)/48)} 格`; }
function lifePanel(view: 'overview' | 'place' | 'bag' = 'overview') {
  const p=world.player,s=world.survival,order=activeOrder(world),offer=s.orders.find(o=>o.status==='offered'),place=nearestPlace(world),task=currentObjective();
  let services='';
  if(place?.id==='tavern') {
    if(!order) services+=offer?service(`accept:${offer.id}`,getLocale()==='en'?`Accept order: ${translateIdentity(world.npcs.find(n=>n.id===offer.customerId)!.name)} · ¥${offer.reward}`:`接单：${world.npcs.find(n=>n.id===offer.customerId)!.name} · ${offer.reward} 元`,s.stock.meals<=0,true):'<p class="subtle">下一份订单即将到来。</p>';
    else if(order.status==='accepted')services+=service('pickup',`备餐中 · ${Math.max(0,Math.ceil(order.readyAt-world.time))} 秒`,true);
    else if(order.status==='ready')services+=service('pickup','取走这份餐品');
    services+=service('buy:热饭','热饭 · 14 元 / 饱腹 +65',p.money<14||s.stock.meals<=0)+service('buy:热茶','热茶 · 5 元 / 体力 +20',p.money<5||s.stock.meals<=0);
  }
  if(place?.id==='shop')services+=service('buy:面包','面包 · 8 元 / 饱腹 +35',p.money<8||s.stock.bread<=0);
  if(place?.id==='home')services+=service('sleep','住宿 · 12 元 / 25 秒',p.money<12);
  if(place?.id==='post')services+=service('work',world.time<s.jobReadyAt?`下一批短工 · ${Math.ceil(s.jobReadyAt-world.time)} 秒后`:'搬运短工 · 18 秒挣 12 元',world.time<s.jobReadyAt||p.energy<12);
  if(place?.id==='watch'||distance(p,PLAZA)<=120)services+=service('rest','长椅休息 · 免费 / 12 秒恢复 28 体力');
  const food=[...new Set(p.inventory.filter(isFood))];
  if(view==='place')return `${p.activity?`<div class="activity-card"><span class="eyebrow">正在做的事</span><p>${esc(p.activity.label)} · 还需 ${Math.max(0,Math.ceil(p.activity.endsAt-world.time))} 秒</p><progress max="${p.activity.endsAt-p.activity.startedAt}" value="${world.time-p.activity.startedAt}"></progress><button class="secondary" data-service="cancel_activity" ${!running()?'disabled':''}>中止活动（无报酬，已付费用不退）</button></div>`:''}<div class="interaction-list">${services||'<p class="subtle">走近店铺门口，按 E 查看服务。</p>'}</div><p class="micro spaced">服务期间世界继续运转；关闭面板后可移动。</p>`;
  if(view==='bag')return `<h3 class="spaced">随身食物</h3><div class="interaction-list">${food.map(item=>service(`eat:${item}`,`吃用 ${item} ×${p.inventory.filter(i=>i===item).length} · 饱腹 +${FOOD[item].hunger}`)).join('')||'<p class="subtle">没有吃的了。茶馆卖热饭，杂货铺卖面包。</p>'}</div><p class="subtle spaced">${p.inventory.filter(i=>!isFood(i)).map(i=>esc(i.startsWith('外卖[')?'待送餐品':i)).join(' · ')||'没有其他随身物品。'}</p>`;
  return `<div class="section-label">MAKE A LIFE HERE <span>第 ${dayOf(world)} 天</span></div><h2 class="panel-title">今天，也要好好过。</h2>
${s.milestone?'<div class="success-card">你已在雾港站稳脚跟。继续送单、结识街坊，过自己的日子。</div>':`<p class="subtle">站稳脚跟：活到第三天 · 配送 ${Math.min(s.delivered,3)} / 3 单</p>`}
<div class="quest-card"><span class="eyebrow">${order?'手里的约定':'第一步 / 下一份生活费'}</span><h3 translate="no">${esc(task.title)}</h3><p translate="no">${esc(task.detail)}</p><strong>◇ ${esc(direction(task.target))}</strong>${order?`<div class="quest-steps">${['接单','取餐','交付'].map((t,i)=>`<span class="${i===0||(i===1&&order.status==='carrying')?'done':''}">${i+1} ${t}</span>`).join('<b>→</b>')}</div>`:''}</div>
<h3 class="spaced">生活地图</h3><div class="place-list">${BUILDINGS.map(b=>`<div><strong>${esc(b.name)}</strong><span>${esc(direction(b.door))}</span><small>${{tavern:'接单 / 取餐 / 热饭与茶',shop:'买面包 · 8 元',home:'住宿 · 12 元',post:'短工 · 挣 12 元',watch:'免费休息'}[b.id]}</small></div>`).join('')}</div><p class="micro spaced">配送成功 ${s.delivered} · 未完成 ${s.failed} · 累计收入 ${s.earned} 元 / 支出 ${s.spent} 元</p>`;
}
function motivationPanel(npc: Npc) {
  const options = getOptions(world, npc.id);
  const { drives, forecasts } = getNpcMotivation(world, npc, options);
  const pressing = [...drives].sort((a, b) => b.pressure - a.pressure).slice(0, 2);
  const candidates = rankActions(drives, forecasts).slice(0, 3).map(choice => ({
    option: options.find(o => o.id === choice.id)!, forecast: forecasts.find(f => f.id === choice.id)!,
  }));
  const labels: Record<string, string> = { hunger:'饱腹', energy:'体力', social:'社交满足', workPressure:'事务压力',...Object.fromEntries(drives.filter(d=>d.id.startsWith('goal:')).map(d=>[d.id,'个人打算进展'])) };
  return `<section class="motivation-card" aria-label="角色需求与行动预期"><span class="eyebrow">生活中的牵挂</span>
<div class="drive-list">${pressing.map(d => `<p><strong>${esc(d.label)}</strong><span>${d.pressure >= 75 ? '迫切' : d.pressure >= 40 ? '在意' : '尚可'} · ${Math.round(d.pressure)} / 100</span><small>${esc(d.evidence)}</small></p>`).join('')}</div>
${candidates.length ? `<p class="micro">可选活动预估 · 含步行与活动时间</p><ul>${candidates.map(({ option, forecast }) => {
    const effects = Object.entries(forecast.effects).filter(([, value]) => value !== 0).map(([key, value]) => {
      const delta = key === 'workPressure' ? -value : value;
      return key.startsWith('goal:')?'个人打算 +1 次':`${labels[key] ?? key} ${delta > 0 ? '+' : ''}${Math.round(delta * 10) / 10}`;
    });
    return `<li><strong>${esc(option.label)}</strong><span>约 ${Math.ceil(forecast.durationSeconds)} 秒${effects.length ? ` · ${effects.map(esc).join('，')}` : ''}</span></li>`;
  }).join('')}</ul><p class="micro">显示部分可行选择及预计直接效果；角色实际选择和最终变化以行动记录为准。</p>` : `<p class="micro">${npc.job ? '正在完成手上的活动，完成后再作打算。' : activeOrder(world)?.customerId === npc.id ? '先守住与你的送餐约定。' : '正在等待下一次行动机会。'}</p>`}</section>`;
}
function knowledgePanel(npc: Npc) {
  const beliefs = inspectKnowledge(npc.mind, world.time).slice(-6);
  const status = { known: '当前认知', conflicted: '消息冲突', outdated: '需要确认', unknown: '尚不清楚' };
  return `<section class="knowledge"><h3>角色认知 <small>· 调试视图</small></h3><p class="micro">这是角色掌握的信息，不代表世界真相，也不代表玩家已获知。</p>${beliefs.map(belief => {
    const sources = belief.evidence.filter(e=>e.status==='current');
    const evidence = (sources.length?sources:belief.evidence).slice(-2);
    const values = belief.values.length?belief.values:belief.evidence.slice(-1).map(e=>e.value+'（旧消息）');
    return `<details class="belief"><summary><span>${status[belief.status]}</span> ${values.map(esc).join(' / ')}</summary>${evidence.map(e=>{
      const origin=e.source;
      const from=origin.kind==='heard'?world.npcs.find(n=>n.id===origin.from)?.name??(origin.from==='player'?(getLocale()==='en'?'Player':'玩家'):origin.from):'';
      const source=origin.kind==='heard'?(getLocale()==='en'?`Heard from ${translateIdentity(from)}`:`听${from}说`):translate({background:'背景常识',observed:'亲眼观察',experienced:'自己的经历',legacy:'旧存档记录，来源未记录'}[origin.kind]);
      return `<p><bdi translate="no">${esc(source)}</bdi> · 第 ${Math.floor(e.learnedAt/360)+1} 天${origin.kind==='legacy'?'迁移记录':'获知'}${e.status==='expired'?' · 已过有效期':e.status==='retired'?' · 已被后续证据替代':''}<br>${esc(e.value)}</p>`;
    }).join('')}</details>`;
  }).join('')||'<p>暂时没有结构化知识记录。</p>'}</section>`;
}
function peoplePanel(npc:Npc) {
  const near=distance(world.player,npc)<=110;
  const intent=npc.mind.intent;
  return `<div class="person-heading">${avatar(npc,true)}<div><h2>${identity(npc.name)}<span>${identity(npc.role)}</span></h2><p>${esc(npc.mood)} · ${near?'就在身旁':esc(direction(npc))}</p></div></div><p class="bio">${esc(bios[npc.id])}</p>
<div class="relationship"><div><span>对你的信任</span><strong>${npc.trust>=3?'渐渐信赖':npc.trust<0?'有所戒备':'正在认识'} ${npc.trust>0?'+':''}${npc.trust}</strong></div><div class="meter"><i style="width:${(npc.trust+10)*5}%"></i></div></div>
<div class="npc-needs">${(['hunger','energy','social','workPressure'] as const).map((k,i)=>`<div><span>${['饱腹','体力','社交满足','事务压力'][i]} <b>${Math.round(npc.needs[k])}</b></span><div class="meter"><i style="width:${npc.needs[k]}%"></i></div></div>`).join('')}</div>
<div class="activity-card"><span class="eyebrow">此刻 · ${esc(npc.mind.expression)}</span><p>${esc(npc.activity)}${npc.job?.endsAt!==undefined?` · 还需 ${Math.max(0,Math.ceil(npc.job.endsAt-world.time))} 秒`:''}</p>${intent?`<p>${esc(phaseLabel[intent.phase])}：${esc(intent.label)}</p>`:''}${decisions.pending.has(npc.id)||npc.pendingInteraction?`<p class="thinking">${npc.pendingInteraction?'正在斟酌你的话':'正在安排自己的下一步'}${conversation.npcId?'，世界已暂停。':'…'}</p>`:''}</div>
<p class="proximity-note">走近居民，在地图上点击或按 E 交谈。</p>
${motivationPanel(npc)}
${personalPanel(npc)}
${knowledgePanel(npc)}
<div class="memory-preview"><span class="eyebrow">记住的经历</span>${npc.mind.experiences.filter(m=>!m.event.startsWith('intent.')&&!m.event.startsWith('commitment.')).slice(-4).reverse().map(m=>`<p>${esc(m.detail)}</p>`).join('')||'<p>尚未有共同经历。</p>'}</div>
${npc.mind.commitments.length?`<div class="knowledge"><h3>你们的约定</h3>${npc.mind.commitments.slice(-4).reverse().map(c=>`<p><strong>${esc(commitmentLabel[c.status])}</strong> · ${c.id.startsWith('order-')?'送餐到约定地点，验收后付款':esc(c.description)}${c.status==='active'&&c.dueAt!==undefined?` · 余 ${Math.max(0,Math.ceil(c.dueAt-world.time))} 秒`:''}</p>`).join('')}</div>`:''}`;
}
function personalPanel(npc:Npc) {
  const state=inspectPersonal(npc.mind,world.time);
  return `<section class="knowledge" aria-label="个人打算与心情"><h3>自己的生活</h3><p class="micro">角色档案视图；这些内容不等于已经向玩家说出口。</p>
${state.preferences.map(p=>`<p>${esc(p.label)}</p>`).join('')}
<h3 class="spaced">这阵子的打算</h3>${state.goals.map(g=>`<p><strong>${g.completed?'已完成':'进行中'} ${g.progress}/${g.target}</strong> · ${esc(g.label)}</p>`).join('')}
<h3 class="spaced">还留在心里的事</h3>${state.feelings.slice(-4).reverse().map(f=>`<p>${esc(f.label)}<br><small>影响正在淡去 · 约 ${Math.ceil(f.until-world.time)} 秒</small></p>`).join('')||'<p class="subtle">最近没有仍在持续的事件心情。</p>'}</section>`;
}
function renderPanel() {
  el('inspector').hidden=!inspectorOpen;
  document.querySelector('[data-action=inspect]')?.setAttribute('aria-expanded',String(inspectorOpen));
  if (panelPointerDown || !inspectorOpen) return;
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  const panel=el('panel'),scroll=panel.scrollTop,npc=world.npcs.find(n=>n.id===selected)||world.npcs[0];
  if(tab==='people') {
    // Live need meters change on every refresh; keep the picker mounted so clicks
    // and keyboard focus survive those detail updates and resident selection.
    if(!panel.querySelector('.resident-row')) {
      panel.innerHTML='<div class="resident-row"></div><div class="person-details"></div>';
      lastPanelHtml='';lastResidentsHtml='';
    }
    const residents=panel.querySelector<HTMLElement>('.resident-row')!;
    const residentsHtml=world.npcs.map(n=>`<button class="resident" data-inspect-npc="${n.id}" data-literal-aria-label aria-label="${getLocale()==='en'?'View ':'查看'}${esc(translateIdentity(n.name))}">${avatar(n)}<span>${identity(n.name)}</span><i></i></button>`).join('');
    if(lastResidentsHtml!==residentsHtml) { residents.innerHTML=residentsHtml;lastResidentsHtml=residentsHtml; }
    residents.querySelectorAll<HTMLElement>('[data-inspect-npc]').forEach(b=>b.classList.toggle('selected',b.dataset.inspectNpc===npc.id));
    const html=peoplePanel(npc);
    if(lastPanelHtml!==html) { panel.querySelector<HTMLElement>('.person-details')!.innerHTML=html;lastPanelHtml=html; }
    panel.scrollTop=scroll;
    return;
  }
  let html='';
  if(tab==='life')html=lifePanel();
  else if(tab==='journal')html=`<div class="section-label">THE THINGS THAT HAPPENED</div><h2 class="panel-title">留下的涟漪</h2><div class="knowledge"><h3>听说的事</h3>${world.player.knowledge.map(k=>`<p>◇ ${esc(describeFact(k))}</p>`).join('')||'<p>还没有听到街坊的私事。</p>'}</div><div class="timeline">${world.events.slice(-50).reverse().map(e=>`<article><time>第 ${Math.floor(e.time/360)+1} 天 · ${Math.floor(e.time%360)} 秒</time><p>${esc(e.text)}</p></article>`).join('')}</div>`;
  else { const real=world.decisions.filter(d=>d.source==='jev'); html=`<div class="section-label">CHARACTER DECISION RECORD</div><h2 class="panel-title">角色记录</h2><p class="subtle">行动与情绪 / 表情由 Jev 从候选中选择，游戏执行合法后果。台词使用预写模板。</p><div class="stats"><div><strong>${real.length}</strong><span>保留的 Jev 决策</span></div><div><strong>${real.length?Math.round(real.reduce((s,d)=>s+(d.latencyMs||0),0)/real.length):'—'}</strong><span>平均响应 ms</span></div><div><strong>${decisions.pending.size}</strong><span>等待请求</span></div><div><strong>${decisions.requests}</strong><span>本页发出请求</span></div></div><p class="micro">历史保留最近 180 条行动与结果；不代表全程总量。当前模式：${decisions.mode==='jev'?'真实 Jev':'规则演示（不调用模型）'}。</p>${decisions.error?`<p class="error-card">${esc(decisions.error)}${!decisions.blocked?' · 自动重试中':''}</p>`:''}<div class="debug-actions"><button class="secondary" data-action="mode">${decisions.mode==='jev'?'切换规则演示':'切换真实 Jev'}</button><button class="secondary" data-action="retry">重新连接</button><button class="secondary" data-action="export">导出经历 JSON</button><button class="secondary danger" data-action="restart">重新开始</button></div><div class="decision-list">${world.decisions.slice(-24).reverse().map(d=>`<article><div><strong>${identity(world.npcs.find(n=>n.id===d.npcId)?.name)}</strong><span class="source-badge">${esc(d.source.toUpperCase())}</span></div><p>${esc(d.label)}</p><small>${d.latencyMs??'—'} ms · 情绪 ${esc(d.affect??'—')}</small><p>${d.changes?.map(esc).join(' · ')||'行动意图已更新'}</p></article>`).join('')||'<p class="subtle">开始后记录角色的真实选择。</p>'}</div>`; }
  if(lastPanelHtml!==html) { lastPanelHtml=html; const focus=document.activeElement as HTMLElement|null; const key=focus?.closest('#panel, .game-card')?(focus.dataset.service?['service',focus.dataset.service]:focus.dataset.interact?['interact',focus.dataset.interact]:null):null; panel.innerHTML=html; panel.scrollTop=scroll; if(key) Array.from(panel.querySelectorAll<HTMLElement>('button')).find(b=>b.dataset[key[0]]===key[1])?.focus({preventScroll:true}); }
}
function displayEffect(change: string, npcName: string): string {
  const rounded=change.replace(/([+-]?\d+\.\d+)/g,value=>String(Math.round(Number(value)*10)/10));
  return /^(饱腹|体力|社交满足|事务压力|情绪：)/.test(rounded)?`${npcName}：${rounded}`:/^(金钱|背包物品)/.test(rounded)?`你：${rounded}`:rounded;
}
function dialoguePanel(npc: Npc) {
  const near=distance(world.player,npc)<=110;
  const actions=getPlayerInteractions(world,npc.id);
  const recent=world.decisions.filter(d=>d.npcId===npc.id).at(-1);
  return `<header class="game-card-heading"><div class="speaker">${avatar(npc,true)}<div><h2>${identity(npc.name)} <small>${identity(npc.role)}</small></h2><p>${esc(npc.mood)} · 世界已暂停</p></div></div><button class="secondary" data-action="end-conversation">${world.player.activity?'结束交谈，开始帮忙':'结束交谈'} <kbd>Esc</kbd></button></header><div class="game-card-body"><p class="speech" role="status">${npc.pendingInteraction?'正在斟酌你的话…':esc(npc.bubble||'你走到身旁，对方停下了脚步。想说些什么？')}</p>${!npc.pendingInteraction&&recent!==dialogueBaseline&&recent?.changes?.length?`<p class="reply-effects">${recent.changes.map(change=>esc(displayEffect(change,npc.name))).join(' · ')}</p>`:''}<div class="interaction-list dialogue-choices">${actions.map(a=>`<button data-interact="${a.id}" ${!near||!enabled()||Boolean(npc.pendingInteraction)||Boolean(world.player.activity)?'disabled':''} title="${esc(followUpDescription(npc,a))}">${esc(a.label)}<small>${esc(followUpDescription(npc,a))}</small></button>`).join('')}</div>${world.player.activity?'<p class="subtle">已约好帮忙，结束交谈后开始计时。</p>':''}<p class="micro">交谈期间行人、体力和订单计时暂停。</p></div>`;
}
function updateCard(id: string, html: string, previous: string) {
  if(html===previous || panelPointerDown)return previous;
  const card=el(id), body=card.querySelector('.game-card-body'), scroll=body?.scrollTop??0;
  const focus=document.activeElement as HTMLElement|null;
  const key=focus?.closest(`#${id}`)?(focus.dataset.service?['service',focus.dataset.service]:focus.dataset.interact?['interact',focus.dataset.interact]:focus.dataset.action?['action',focus.dataset.action]:null):null;
  card.innerHTML=html;
  const nextBody=card.querySelector('.game-card-body');if(nextBody)nextBody.scrollTop=scroll;
  if(key)Array.from(card.querySelectorAll<HTMLElement>('button')).find(b=>b.dataset[key[0]]===key[1])?.focus({preventScroll:true});
  return html;
}
function renderScene() {
  const npc=world.npcs.find(n=>n.id===conversation.npcId);
  el('conversation-bar').hidden=!npc||!started||world.survival.dead;
  if(npc)lastConversationHtml=updateCard('conversation-bar',dialoguePanel(npc),lastConversationHtml);
  el('scene-panel').hidden=!scenePanel||!started||world.survival.dead;
  if(scenePanel){
    const title=scenePanel==='bag'?'随身背包':nearestPlace(world)?.name??(distance(world.player,PLAZA)<=120?'雾港广场':'附近服务');
    lastSceneHtml=updateCard('scene-panel',`<header class="game-card-heading"><div><span class="eyebrow">${scenePanel==='bag'?'INVENTORY':'NEARBY'}</span><h2>${esc(title)}</h2></div><button class="secondary" data-action="close-scene">返回街区 <kbd>Esc</kbd></button></header><div class="game-card-body">${lifePanel(scenePanel)}</div>`,lastSceneHtml);
  }
  document.querySelector('.play-area')!.classList.toggle('interacting',Boolean(npc||scenePanel));
}
function renderStatus() {
  const p=world.player,s=world.survival;
  const talking = world.npcs.find(n => n.id === conversation.npcId);
  el('connection').className=`connection ${decisions.error?'error':decisions.mode==='rules'?'demo':''}`;
  el('connection').innerHTML=`<i></i><span>${esc(decisions.mode==='rules'?'规则演示':decisions.error||(!decisions.checked?'连接 Jev…':decisions.configured?'Jev 已连接':'等待配置'))}</span>`;
  el('clock').textContent=`第 ${dayOf(world)} 天 · ${worldClock(world)}`;
  el('pause').textContent=paused?'▶ 继续':'Ⅱ 暂停'; el('pause-overlay').hidden=!paused||!started||s.dead;
  el('vitals').innerHTML=`<strong class="money">¥ ${p.money}<small>生活费</small></strong>${(['health','hunger','energy'] as const).map((k,i)=>`<div class="vital ${p[k]<20?'low':''}"><span>${['健康','饱腹','体力'][i]} <b>${Math.ceil(p[k])}</b></span><div class="meter"><i style="width:${p[k]}%"></i></div></div>`).join('')}<span class="day-progress">${s.delivered} 次配送 · ${s.milestone?'已站稳脚跟':'目标：第三天 / 三单'}</span>`;
  const task=currentObjective(); el('objective').innerHTML=`<span translate="no">◇ ${esc(task.title)}</span><small>${esc(direction(task.target))}</small>`;
  el('inventory').textContent=p.inventory.map(i=>i.startsWith('外卖[')?'待送餐品':i).join(' · ')||'空空的';
  el('event-peek').textContent=world.events.at(-1)?.text||'';
  el('world-caption').textContent=talking?'交谈期间世界停留，结束后恢复探索。':p.hunger<20?'肚子很饿了，记得吃用背包里的食物。':p.energy<15?'体力不足，去广场或临水亭歇脚。':decisions.error?'连接恢复前，已有行动与生活继续。':decisions.mode==='rules'?'规则演示 · 没有调用 Jev':'你的约定，正在成为他们的记忆。';
  el('death-overlay').hidden=!s.dead||!started;
  if(s.dead) { el('death-detail').textContent=`你生活到第 ${dayOf(world)} 天，完成 ${s.delivered} 次配送。下次记得及时吃饭和休息。`; decisions.cancel(); }
}
document.addEventListener('pointerdown',event=>{ panelPointerDown=Boolean((event.target as HTMLElement).closest('#panel, .game-card')); });
document.addEventListener('pointerup',()=>{panelPointerDown=false;});
document.addEventListener('pointercancel',()=>{panelPointerDown=false;});
document.addEventListener('click',event=>{
  const b=(event.target as HTMLElement).closest<HTMLButtonElement>('button'); if(!b||b.disabled)return;
  if(b.dataset.locale==='en'||b.dataset.locale==='zh'){setLocale(b.dataset.locale);try{localStorage.setItem(LANGUAGE_KEY,b.dataset.locale);}catch{/* Language still changes for this session. */}return;}
  if(b.dataset.inspectNpc){selected=b.dataset.inspectNpc;tab='people';refresh();}
  if(b.dataset.tab){tab=b.dataset.tab as typeof tab;el('panel').scrollTop=0;refresh();}
  if(b.dataset.service&&running()){toast(performService(world,b.dataset.service));refresh();}
  if(b.dataset.interact&&enabled()&&conversation.npcId){const id=conversation.npcId;dialogueBaseline=world.decisions.filter(d=>d.npcId===id).at(-1);const message=playerInteract(world,id,b.dataset.interact);if(!world.npcs.find(n=>n.id===id)?.pendingInteraction)toast(message);decisions.prioritize(id);refresh();}
  switch(b.dataset.action){
    case 'bag':if(running()){inspectorOpen=false;scenePanel=scenePanel==='bag'?null:'bag';refresh();}break;
    case 'inspect':inspectorOpen=!inspectorOpen;scenePanel=null;refresh();break;
    case 'close-inspector':inspectorOpen=false;refresh();break;
    case 'close-scene':scenePanel=null;refresh();break;
    case 'start':started=true;el('welcome').hidden=true;if(storageError)toast('无法访问本机存档，请导出经历保存。');refresh();break;
    case 'pause':paused=!paused;decisions.cancel();refresh();break;
    case 'save':save();break;
    case 'end-conversation':closeConversation();break;
    case 'guide':(el('guide') as HTMLDialogElement).showModal();decisions.cancel();break;
    case 'retry':decisions.cancel();void decisions.check();break;
    case 'mode':decisions.cancel();decisions.mode=decisions.mode==='jev'?'rules':'jev';decisions.error='';decisions.retryAt=0;if(decisions.mode==='jev')void decisions.check();toast(decisions.mode==='rules'?'规则演示已开启，不调用模型。':'已切回真实 Jev。');refresh();break;
    case 'export':{const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),mode:decisions.mode,requestsThisPage:decisions.requests,world,note:'Authored speech templates. Bounded event history. Sources recorded per decision.'},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`fog-harbor-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('经历和角色记录已导出。');break;}
    case 'restart':(el('restart-dialog') as HTMLDialogElement).showModal();decisions.cancel();break;
  }
});
el('confirm-restart').addEventListener('click',()=>{decisions.cancel();conversation.close(world);world=createWorld();selected=world.npcs[0].id;paused=false;started=true;tab='life';scenePanel=null;inspectorOpen=false;(el('restart-dialog') as HTMLDialogElement).close();el('welcome').hidden=true;save(true);refresh();toast('第一天，从照顾好自己开始。');});
document.addEventListener('keydown',event=>{
  if(document.querySelector('dialog[open]'))return;
  if(event.key==='Escape'){
    event.preventDefault();
    if(inspectorOpen){inspectorOpen=false;refresh();}
    else if(conversation.npcId)closeConversation();
    else if(scenePanel){scenePanel=null;refresh();}
  }
  if(event.key.toLowerCase()==='b'&&!event.repeat&&running()){inspectorOpen=false;scenePanel=scenePanel==='bag'?null:'bag';refresh();}
});
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('close',refresh));
document.addEventListener('visibilitychange',()=>{if(document.hidden){decisions.cancel();if(started)save(true);}});
window.addEventListener('pagehide',()=>{decisions.cancel();if(started)save(true);});
setInterval(refresh,500);setInterval(()=>{void decisions.tick();},150);setInterval(()=>{if(started&&enabled())save(true);},15000);
refresh();void decisions.check();
