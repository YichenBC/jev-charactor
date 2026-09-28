import { isHelpPromise, addWork, completeWork, ownedWork, releasePlayerActivity, releaseWork } from './work';
import { beginIntent, completeIntent, setCommitment, resolveCommitment } from '../character';
import { learnNpcFact } from './knowledge';
import { BUILDINGS } from './data';
import { cancelNpcJob, npcNeedChanges } from './npcLife';
import { clamp, distance, route } from './navigation';
import { event, remember, say } from './events';
import type { DeliveryOrder, Point, Survival, World } from './types';

export const DAY_SECONDS = 360;
export const PLAZA: Point = { x: 696, y: 600 };
export const FOOD: Record<string, { hunger: number; energy: number; price: number }> = { '面包': { hunger: 35, energy: 5, price: 8 }, '热饭': { hunger: 65, energy: 12, price: 14 }, '热茶': { hunger: 5, energy: 20, price: 5 }, '桂花糕': { hunger: 28, energy: 8, price: 0 } };
export const dayOf = (world: World) => Math.floor(world.time / DAY_SECONDS) + 1;
export function worldClock(world: World) { const minute = (8 * 60 + Math.floor(world.time / DAY_SECONDS * 1440)) % 1440; return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; }
export const activeOrder = (world: World) => world.survival.orders.find(o => ['accepted', 'ready', 'carrying'].includes(o.status));
export const parcelName = (order: DeliveryOrder) => `外卖[${order.id}]`;
export const isFood = (item: string) => Object.hasOwn(FOOD, item);
export const nearestPlace = (world: World, range = 95) => BUILDINGS.filter(b => distance(world.player, b.door) <= range).sort((a, b) => distance(world.player, a.door) - distance(world.player, b.door))[0];
const at = (world: World, place: string) => distance(world.player, BUILDINGS.find(b => b.id === place)!.door) <= 95;
export function createSurvival(): Survival { return { orders: [], nextOrder: 1, stock: { meals: 12, bread: 12 }, restockedDay: 1, delivered: 0, failed: 0, earned: 0, spent: 0, jobReadyAt: 0, nextOfferAt: 0, milestone: false, dead: false }; }

export function ensureOffer(world: World) {
  if (activeOrder(world) || world.survival.orders.some(o => o.status === 'offered') || world.time < world.survival.nextOfferAt) return;
  const serial = world.survival.nextOrder++;
  const customerId = ['lin', 'tang', 'lan', 'zhou'][(serial - 1) % 4];
  const buildingId: Record<string, string> = { lin: 'shop', tang: 'home', lan: 'post', zhou: 'watch' };
  const address = { ...BUILDINGS.find(b => b.id === buildingId[customerId])!.door };
  world.survival.orders.push({ id: `order-${serial}`, customerId, address, status: 'offered', createdAt: world.time, readyAt: 0, deadline: 0, expiresAt: world.time + 180, reward: 24 + (serial % 3) * 2 });
  world.survival.orders = world.survival.orders.slice(-40);
}

export function orderCondition(world: World, order: DeliveryOrder) {
  return { late: world.time > order.deadline, cold: order.pickedUpAt !== undefined && world.time - order.pickedUpAt > 55, secondsLate: Math.max(0, Math.floor(world.time - order.deadline)), explained: Boolean(order.explanation) };
}

export function survivalTick(world: World, dt: number) {
  const player = world.player;
  if (world.survival.dead) return;
  player.hunger = clamp(player.hunger - dt * .11);
  player.energy = clamp(player.energy - dt * .035);
  if (player.hunger === 0) player.health = clamp(player.health - dt * .5);
  else if (player.hunger > 45 && player.energy > 30) player.health = clamp(player.health + dt * .04);
  if (player.energy === 0) player.health = clamp(player.health - dt * .12);
  if (player.health <= 0) { world.survival.dead = true; releasePlayerActivity(world); player.activity = null; event(world, '你再也撑不住了。这段求生结束了；可以重新开始。', 'failure'); return; }
  const day = dayOf(world);
  for (const npc of world.npcs) {
    const promise = npc.mind.commitments.find(c => isHelpPromise(c.id) && c.status === 'active');
    if (promise?.dueAt !== undefined && world.time > promise.dueAt && !(player.activity?.kind === 'help' && player.activity.npcId === npc.id)) {
      resolveCommitment(npc.mind, promise.id, 'broken', world.time); for (const task of ownedWork(world,npc)) releaseWork(world,npc,task.id,'player'); npc.trust = clamp(npc.trust - 2, -10, 10); remember(world, npc, '玩家答应回来帮忙，却超过了约定时间。我以后会更谨慎。', 'broken_promise', .9); event(world, `${npc.name}等过了约定时间，信任下降。`, 'relationship', npc.id);
    }
  }
  if (day > world.survival.restockedDay) { world.survival.stock = { meals: 12, bread: 12 }; world.survival.restockedDay = day; event(world, `第 ${day} 天，店铺补好了货。生活继续。`, 'world'); }
  const activity = player.activity;
  if (activity && world.time >= activity.endsAt) {
    player.activity = null;
    if (activity.kind === 'sleep') { player.energy = 100; player.health = clamp(player.health + 35); event(world, '睡了一觉，体力恢复充足，健康有所恢复。', 'survival'); }
    if (activity.kind === 'rest') { if (distance(activity.origin, BUILDINGS.find(b => b.id === 'watch')!.door) <= 120) addWork(world, 'zhou', '有人在临水亭歇脚后留下了待整理的杂物'); player.energy = clamp(player.energy + 28); event(world, '你在长椅上缓了口气，体力 +28。', 'survival'); }
    const recipient = world.npcs.find(n => n.id === activity.npcId);
    const settled = activity.kind !== 'help' || Boolean(recipient && completeWork(world, recipient, activity.taskId, 'player'));
    if (!settled) event(world, '这份工作已失效，没有重复支付报酬。', 'player');
    if ((activity.kind === 'work' || activity.kind === 'help') && settled) {
      if (activity.kind === 'work') addWork(world, 'lan', '一批包裹搬运到驿站，需要分拣');
      const reward = activity.kind === 'work' ? 12 : 8;
      player.money += reward; world.survival.earned += reward; player.energy = clamp(player.energy - 8);
      event(world, `${activity.label}完成，实收 ${reward} 元。`, 'payment');
      if (activity.npcId) {
        const npc = world.npcs.find(n => n.id === activity.npcId)!;
        const before = {...npc.needs};
        npc.needs.workPressure = clamp(npc.needs.workPressure-20);
        world.decisions.push({time:world.time,npcId:npc.id,choice:'completed:player_help',label:'玩家完成帮忙',source:'simulation',changes:npcNeedChanges(before,npc.needs)});
        world.decisions = world.decisions.slice(-180);
        npc.trust = clamp(npc.trust + 2, -10, 10);
        world.flags[`helped_${npc.id}`] = true;
        learnNpcFact(npc, 'player-helped-me', world.time);
        remember(world, npc, '玩家留下来完成了实在的工作，我支付了报酬。', 'kept_word', .85);
        const promise = npc.mind.commitments.find(c => isHelpPromise(c.id) && c.status === 'active');
        if (promise && resolveCommitment(npc.mind, promise.id, 'fulfilled', world.time)) {
          learnNpcFact(npc, 'promise-kept', world.time);
          remember(world, npc, '玩家兑现了回来帮忙的承诺。', 'promise_kept', .9);
        }
        say(world, npc, '事情做完了，我的待办也少了些。辛苦，这是说好的报酬。');
      }
    }
  }
  for (const order of world.survival.orders) {
    if (['accepted', 'ready', 'carrying'].includes(order.status)) {
      const crossedLate = world.time > order.deadline && world.time - dt <= order.deadline;
      const crossedCold = order.pickedUpAt !== undefined && world.time > order.pickedUpAt + 55 && world.time - dt <= order.pickedUpAt + 55;
      if (crossedLate || crossedCold) world.npcs.find(n => n.id === order.customerId)!.revision++;
    }
    if (order.status === 'accepted' && world.time >= order.readyAt) { order.status = 'ready'; event(world, `${order.id} 已备好，请到晚风茶馆门口取餐。`, 'order'); }
    if (['offered', 'accepted', 'ready', 'carrying'].includes(order.status) && world.time > order.expiresAt) {
      const wasAccepted = order.status !== 'offered'; order.status = 'expired';
      const index = player.inventory.indexOf(parcelName(order)); if (index >= 0) player.inventory.splice(index, 1);
      if (wasAccepted) { world.survival.failed++; const npc = world.npcs.find(n => n.id === order.customerId)!; npc.trust = clamp(npc.trust - 2, -10, 10); remember(world, npc, `玩家接下 ${order.id} 后一直没有送到，订单已取消。`, 'broken_delivery', .95); resolveCommitment(npc.mind, order.id, 'broken', world.time); completeIntent(npc.mind, world.time); delete npc.pendingInteraction; delete npc.pendingAction; npc.cooldown = 0; event(world, '订单超时取消；背包中的餐品已按规则报废，信誉下降。', 'order'); }
      world.survival.nextOfferAt = world.time + 4;
    }
  }
  ensureOffer(world);
  if (!world.survival.milestone && day >= 3 && world.survival.delivered >= 3) { world.survival.milestone = true; event(world, '你在雾港站稳了脚跟：活到第三天，并完成了三次配送。生活还在继续。', 'milestone'); }
}

export function performService(world: World, action: string): string {
  const p = world.player, s = world.survival;
  if (s.dead) return '这段生活已经结束，请重新开始。';
  if (action === 'cancel_activity') { if (!p.activity) return '你现在没有正在进行的工作。'; releasePlayerActivity(world); p.activity = null; event(world, '你中止了刚才的活动；未完成的工作没有报酬。', 'player'); return '已中止，已付费用不退还。'; }
  if (p.activity) return '先完成或中止当前活动。';
  if (action.startsWith('eat:')) {
    const item = action.slice(4), food = FOOD[item], index = p.inventory.indexOf(item);
    if (!isFood(item) || !food || index < 0) return '背包里没有这份食物。';
    p.inventory.splice(index, 1); p.hunger = clamp(p.hunger + food.hunger); p.energy = clamp(p.energy + food.energy);
    if (at(world, 'tavern')) addWork(world, 'mei', '玩家在茶馆用餐后留下了待清理的餐具');
    event(world, `吃用了${item}：饱腹 +${food.hunger}，体力 +${food.energy}。`, 'survival'); return `吃用了${item}，身体舒服了一些。`;
  }
  if (action.startsWith('accept:')) {
    if (!at(world, 'tavern')) return '到晚风茶馆门口才能接单。';
    if (activeOrder(world)) return '先处理手里的订单。';
    const order = s.orders.find(o => o.id === action.slice(7) && o.status === 'offered');
    if (!order || world.time > order.expiresAt) return '这份订单已不可接。';
    if (s.stock.meals <= 0) return '今天餐品已经售罄，明天补货。';
    s.stock.meals--; order.status = 'accepted'; order.readyAt = world.time + 6; order.deadline = world.time + (s.delivered === 0 ? 120 : order.customerId === 'lan' ? 60 : 90); order.expiresAt = order.deadline + 90;
    const npc = world.npcs.find(n => n.id === order.customerId)!;
    cancelNpcJob(world, npc, '暂缓自己的事情，先履行约定去等餐。');
    setCommitment(npc.mind, { id: order.id, description: `Player will deliver a warm meal for ${order.reward} coins to our agreed address. I will meet them and pay on valid delivery.`, status: 'active', createdAt: world.time, dueAt: order.deadline, counterparty: 'player' });
    remember(world, npc, `玩家接下了我的外卖订单 ${order.id}，约好在地址见面。`, 'delivery_contract', .8);
    npc.path = route(npc, order.address); npc.destination = '收餐地点'; npc.activity = npc.path.length ? '去约定地点等餐' : '在约定地点等你送餐'; npc.cooldown = 0;
    beginIntent(npc.mind, { id: order.id, label: '到约定地址等玩家送餐', target: 'player', phase: npc.path.length ? 'acting' : 'waiting', since: world.time, until: order.expiresAt });
    event(world, `已接 ${npc.name} 的订单：报酬 ${order.reward} 元。6 秒后到茶馆取餐。`, 'order'); return '接单成功，餐馆正在备餐。';
  }
  if (action === 'pickup') {
    if (!at(world, 'tavern')) return '请到晚风茶馆门口取餐。';
    const order = activeOrder(world); if (!order) return '先接一份订单。';
    if (order.status === 'accepted') return `还在备餐，约 ${Math.ceil(order.readyAt - world.time)} 秒。`;
    if (order.status !== 'ready') return '这份餐已经取走了。';
    if (p.inventory.length >= 24) return '背包已满，先吃用一些物品再取餐。';
    order.status = 'carrying'; order.pickedUpAt = world.time; p.inventory.push(parcelName(order));
    event(world, '餐品已进入背包。送到标记处，靠近收件人交付。', 'order'); return '已取餐。按地图标记送到收件人。';
  }
  if (action.startsWith('buy:')) {
    const item = action.slice(4), food = FOOD[item];
    if (!isFood(item) || !food || food.price <= 0) return '没有这件商品。';
    if (!(item === '面包' ? at(world, 'shop') : at(world, 'tavern'))) return item === '面包' ? '请到舟记杂货门口购买。' : '请到晚风茶馆门口购买。';
    const stock = item === '面包' ? 'bread' : 'meals';
    if (s.stock[stock] <= 0) return '今天售罄了，明天补货。';
    if (p.money < food.price) return '钱不够，可以到驿站做短工赚取报酬。';
    if (p.inventory.length >= 24) return '背包已满，先吃掉或处理一些物品。';
    p.money -= food.price; s.spent += food.price; s.stock[stock]--; p.inventory.push(item); if (item === '面包') addWork(world, 'lin', '店里售出了商品，货架需要重新整理'); event(world, `花 ${food.price} 元买了${item}，已放入背包。`, 'purchase'); return `${item}已放入背包，点击「吃用」即可恢复。`;
  }
  if (action === 'rest') {
    if (distance(p, PLAZA) > 120 && !at(world, 'watch')) return '到广场长椅或临水亭附近才能休息。';
    p.activity = { kind: 'rest', label: '在长椅上歇脚', startedAt: world.time, endsAt: world.time + 12, origin: { x: p.x, y: p.y } }; return '坐下休息 12 秒，恢复体力。';
  }
  if (action === 'sleep') {
    if (!at(world, 'home')) return '到梧桐小院门口住宿。';
    if (p.money < 12) return '住宿需要 12 元；可以先去免费长椅休息。';
    p.money -= 12; s.spent += 12; p.activity = { kind: 'sleep', label: '在小院客房休息', startedAt: world.time, endsAt: world.time + 25, origin: { x: p.x, y: p.y } }; event(world, '支付 12 元住宿，开始休息。', 'purchase'); return '休息 25 秒后恢复体力和部分健康。';
  }
  if (action === 'work') {
    if (!at(world, 'post')) return '到青石驿站门口做短工。';
    if (world.time < s.jobReadyAt) return `下一批货物 ${Math.ceil(s.jobReadyAt - world.time)} 秒后到。`;
    if (p.energy < 12) return '体力不足，先在长椅休息。';
    s.jobReadyAt = world.time + 45; p.activity = { kind: 'work', label: '搬运驿站的包裹', startedAt: world.time, endsAt: world.time + 18, origin: { x: p.x, y: p.y } }; return '开始搬运，18 秒后实收 12 元。';
  }
  return '这里暂时不能这样做。';
}

export function settleDelivery(world: World, npcId: string, outcome: 'receive_tip' | 'receive_exact' | 'receive_reduced' | 'refuse_delivery'): string | null {
  const order = activeOrder(world), npc = world.npcs.find(n => n.id === npcId);
  if (!order || !npc || order.customerId !== npcId || order.status !== 'carrying' || distance(world.player, npc) > 110) return null;
  const index = world.player.inventory.indexOf(parcelName(order)); if (index < 0) return null;
  const condition = orderCondition(world, order);
  if ((!condition.late && !condition.cold) && ['refuse_delivery', 'receive_reduced'].includes(outcome)) return null;
  if ((condition.late || condition.cold) && outcome === 'receive_tip') return null;
  world.player.inventory.splice(index, 1); order.settledAt = world.time;
  order.status = outcome === 'refuse_delivery' ? 'rejected' : 'delivered';
  const amount = outcome === 'refuse_delivery' ? 0 : outcome === 'receive_reduced' ? Math.ceil(order.reward * .6) : order.reward + (outcome === 'receive_tip' ? 6 : 0);
  order.payout = amount; world.player.money += amount; world.survival.earned += amount;
  if (outcome === 'refuse_delivery') world.survival.failed++; else { world.survival.delivered++; npc.needs.hunger=clamp(npc.needs.hunger+FOOD['热饭'].hunger); npc.needs.energy=clamp(npc.needs.energy+FOOD['热饭'].energy); }
  npc.trust = clamp(npc.trust + (outcome === 'receive_tip' ? 2 : outcome === 'receive_exact' ? 1 : -1), -10, 10);
  resolveCommitment(npc.mind, order.id, outcome === 'refuse_delivery' ? 'broken' : 'fulfilled', world.time); completeIntent(npc.mind, world.time);
  remember(world, npc, `订单 ${order.id} ${condition.late ? '迟到' : '按时'}、${condition.cold ? '餐品冷了' : '餐品尚热'}；${order.explanation ? '玩家解释了延误；' : ''}${outcome === 'refuse_delivery' ? '我拒收' : `我收餐吃完并支付 ${amount} 元`}。`, 'delivery_result', .95);
  event(world, `${npc.name}${outcome === 'refuse_delivery' ? '拒收了这份餐，未支付报酬' : `收下并吃完餐品，你实收 ${amount} 元`}。背包与订单已结算。`, 'payment', npc.id);
  world.survival.nextOfferAt = world.time + 3;
  return outcome === 'receive_tip' ? `送来时餐还热着，我已经吃完了。辛苦你了。${order.reward} 元报酬，再加 6 元小费。` : outcome === 'receive_exact' ? `餐收到了，也吃完了。说好的 ${amount} 元，给你。` : outcome === 'receive_reduced' ? `这次确实耽搁了，我还是收下吃完了。支付 ${amount} 元，下次请守时。` : '已经错过饭点了，这份餐我不能收。下次请认真对待约定。';
}

export function deliverySituation(world: World, npcId: string) {
  const order = activeOrder(world);
  if (!order || order.customerId !== npcId) return null;
  return { id: order.id, status: order.status, agreedReward: order.reward, ...orderCondition(world, order), remainingSeconds: Math.ceil(order.deadline - world.time), playerHasMatchingParcel: world.player.inventory.includes(parcelName(order)) };
}

export function objective(world: World): { title: string; detail: string; target: Point; label: string } {
  const order = activeOrder(world), tavern = BUILDINGS.find(b => b.id === 'tavern')!;
  if (!order) return { title: '到茶馆接一份外卖', detail: '接单 → 取餐 → 送到收件人 → 交付结算。赚钱购买食物和休息。', target: tavern.door, label: '晚风茶馆 · 接单' };
  if (order.status === 'accepted') return { title: `备餐还需 ${Math.max(0, Math.ceil(order.readyAt - world.time))} 秒`, detail: '留在茶馆附近，餐好后点击取餐。', target: tavern.door, label: '晚风茶馆 · 备餐' };
  if (order.status === 'ready') return { title: '餐已备好，去茶馆取餐', detail: '取到餐品后，背包里会出现对应订单。', target: tavern.door, label: '晚风茶馆 · 取餐' };
  const npc = world.npcs.find(n => n.id === order.customerId)!;
  return { title: `把外卖送给${npc.name}`, detail: `${Math.max(0, Math.ceil(order.deadline - world.time))} 秒内送达；靠近后按 E，在人物面板点击交付。${world.time > order.deadline ? ' 已迟到，可先解释。' : ''}`, target: npc.path.length ? order.address : { x: npc.x, y: npc.y }, label: `${npc.name} · 收件人` };
}
