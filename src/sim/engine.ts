import { INITIAL_WORK, isHelpPromise, addWork, availableWork, capturedWork, claimWork, createWork, currentWork, observeWork, offerWork, ownedWork } from './work';
import { BUILDINGS, DIALOGUE, INTERACTIONS, SECRET_FACTS, initialNpcs, stableIdentity } from './data';
import { applyAffect, beginIntent, buildDecisionContext, completeIntent, interruptIntent, REACTION_OPTIONS, setCommitment } from '../character';
import { contextualPrivateConcern, learnNpcFact } from './knowledge';
import { ordinaryResponses, type CharacterResponse } from './dialogue';
import { authoredPlanDialogue } from './dialogueStyle';
import { recordDialogueExchange } from '../character/dialogue';
import { initializePersonalLife, notePersonalEvent } from './personalLife';
import { CHORES, CHORE_SECONDS, CHORE_REWARD, RETURN_SECONDS, pendingActionCurrent, resolvePlayerAction } from './interactions';
import { FOOD, activeOrder, createSurvival, deliverySituation, ensureOffer, isFood, orderCondition, parcelName, settleDelivery, survivalTick } from './survival';
import { distance, clamp, move, route } from './navigation';
import { event, remember, say } from './events';
import { cancelNpcJob, decayNpcNeeds, npcLifeContext, npcLifeOptions, progressNpcJob, startNpcJob, npcNeedChanges, incomingConversation, participatingConversation, socialInvitation, respondToSocialInvitation } from './npcLife';
import { rankActions } from '../character/motivation';
import { forecastNpcActions, getNpcMotivation } from './motivation';
import type { ActionOption, DecisionMeta, Interaction, Npc, Point, World } from './types';
export { isWalkable } from './navigation';
const npcById = (world: World, id: string) => world.npcs.find(npc => npc.id === id);
const interactionLabel = (id: Interaction) => INTERACTIONS.find(item => item.id === id)!.label;
export function createWorld(): World {
 const world: World = { version: 2, time: 0, seed: 17, player: { x: 744, y: 600, inventory: ['热茶','面包'], knowledge: [], health: 100, hunger: 75, energy: 85, money: 20, activity: null }, npcs: initialNpcs(), events: [], decisions: [], flags: {}, survival: createSurvival(), work: createWork() };
 for (const npc of world.npcs) { addWork(world, npc.id, INITIAL_WORK[npc.id], true); initializePersonalLife(npc,world.time); }
 ensureOffer(world); event(world,'你带着 20 元来到雾港。先到晚风茶馆接一份外卖，赚取今天的生活费。','world'); return world;
}
export function movePlayer(world: World, dx: number, dy: number): void {
 if (world.survival.dead || world.player.activity) return;
 const before = {x:world.player.x,y:world.player.y}; move(world.player,dx,dy);
 world.player.energy = clamp(world.player.energy - distance(before,world.player)*.006);
}

function resumeDeliveryMeeting(world: World, npc: Npc): boolean {
  const meeting = activeOrder(world);
  if (meeting?.customerId !== npc.id) return false;
  npc.path = distance(npc,meeting.address)>2 ? route(npc,meeting.address) : [];
  npc.activity = npc.path.length ? '回到约定地点等餐' : '在约定地点等你送餐';
  beginIntent(npc.mind,{id:`${meeting.id}:resume:${world.time}`,label:'到约定地址等玩家送餐',phase:npc.path.length?'acting':'waiting',since:world.time,until:meeting.expiresAt});
  return true;
}

export function advance(world: World, dtSeconds: number): void {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0 || world.survival.dead) return;
  const dt = Math.min(dtSeconds, 5);
  world.time += dt;
  survivalTick(world, dt);
  for (const npc of world.npcs) {
    npc.cooldown = Math.max(0, npc.cooldown - dt);
    decayNpcNeeds(world, npc, dt);
    if (npc.bubbleUntil !== undefined && npc.bubbleUntil < world.time) delete npc.bubble;
    let remaining = dt * 50;
    while (remaining > 0 && npc.path.length) {
      const next = npc.path[0], d = distance(npc, next), step = Math.min(d, remaining);
      if (d > 0) move(npc, (next.x - npc.x) / d * step, (next.y - npc.y) / d * step);
      remaining -= step;
      if (distance(npc, next) < 1) {
        npc.path.shift();
        if (!npc.path.length) { npc.activity = npc.lastDecision === '忙自己的事情' ? `在${npc.destination ?? '街边'}忙自己的事情` : `停留在${npc.destination ?? '街边'}`; remember(world, npc, `来到${npc.destination ?? '街边'}。`, 'travel'); const order = activeOrder(world); if (order?.customerId === npc.id) { npc.activity = '在约定地点等你送餐'; if (npc.mind.intent) npc.mind.intent.phase = 'waiting'; } else if (!npc.job) completeIntent(npc.mind, world.time); }
      } else if (step === 0 || distance(npc, next) >= d - 0.01) { npc.path = []; npc.revision++; break; }
    }
    progressNpcJob(world, npc);
    observeWork(world, npc);
  }
}

export function nearbyNpc(world: World, maxDistance = 100): Npc | undefined {
  return world.npcs.filter(n => distance(world.player, n) <= maxDistance).sort((a, b) => distance(world.player, a) - distance(world.player, b))[0];
}

export function getOptions(world: World, npcId: string): ActionOption[] {
  const npc = npcById(world, npcId);
  if (!npc || !pendingActionCurrent(world,npc)) return [];
  const options: ActionOption[] = [];
  const add = (id: string, label: string, description: string, kind = 'social', target?: string) => options.push({ id, label, description, kind, ...(target ? { target } : {}) });
  if (npc.pendingInteraction === 'deliver' || npc.pendingInteraction === 'explain') {
    const order = activeOrder(world);
    if (!order || order.customerId !== npcId || order.status !== 'carrying') return [];
    const state = orderCondition(world, order);
    add('receive_exact', '收餐并按约付款', 'Accept the correct meal and pay the agreed delivery fee. Consider your values, relationship and the player’s past fulfilled/broken deliveries.');
    if (!state.late && !state.cold) add('receive_tip', '收餐并多给小费', 'The delivery is timely and warm. Show appreciation by paying the agreed fee plus six coins tip.');
    else {
      add('receive_reduced', '宽限收餐，减少报酬', 'Accept the late or cold meal but reduce the fee to sixty percent. Be guided by your patience, current feelings and the player’s explanation and history.');
      add('refuse_delivery', '拒收并取消付款', 'Reject a late or cold delivery and pay nothing. Appropriate for someone strongly prioritizing punctuality or repeated broken promises. Forgiving characters may choose acceptance instead.');
    }
    return options;
  }
  if (npc.pendingInteraction) {
    const pending = npc.pendingInteraction;
    const task = currentWork(world, npc);
    if (pending === 'greet' || pending === 'ask') {
      for (const response of ordinaryResponses(npc, pending, npc.knownFacts.includes('met-player'), world.time, world)) {
        const label = response.id === 'reply:place' ? '聊茶馆和自己的近况' : response.id === 'reply:state' ? '聊眼下的身体与工作状态' : pending === 'greet' ? '回应招呼与今日状态' : '聊一个愿意谈的话题';
        add(response.id, response.id==='reply:detail'?'接着刚才的话回答':response.id==='reply:history'?'谈共同经历与约定':response.id==='reply:neighbor'?'转述亲耳听见的街坊近况':response.id==='reply:work'?'解释当前待办':label, `Speech intent: ${response.intent}. Say: ${response.text} Evidence: ${response.evidence.map(e => e.basis).join('; ')}. Speech only: no work, meal, gift or promise is executed.`);
      }
    } else add('reply', '回应这件事，暂不答应', 'Acknowledge the pending interaction without accepting an obligation, gift or apology, and without revealing private facts.');
    add('refuse', '礼貌婉拒', 'Decline this interaction and keep personal boundaries.');
    if (pending === 'ask' && !npc.pendingAction?.parameters.topic && !npc.pendingAction?.parameters.focus && npc.trust >= 3 && SECRET_FACTS[npc.id] && contextualPrivateConcern(npc,world.time) && !npc.knownFacts.includes('confided-to-player')) add('confide', '说出自己的心事', 'Confide your own current private concern to the trusted player. Never reveal anyone else’s secret.');
    if (((pending === 'ask' && !npc.pendingAction?.parameters.topic && !npc.pendingAction?.parameters.focus && !task?.offered) || pending === 'request') && task) add('request_help', '说明具体工作与报酬', `Offer observed task ${task.id}: ${CHORES[npc.id]}. Cause: ${task.cause}. ${CHORE_SECONDS} seconds of work pays ${CHORE_REWARD} coins only after completion. The player must still accept; this creates no obligation.`);
    if (pending === 'help' && capturedWork(world,npc) && !world.player.activity) add('accept_help', '同意现在开工', `Accept the player's offer to ${CHORES[npc.id]} for ${CHORE_SECONDS} seconds and ${CHORE_REWARD} coins on completion. No immediate reward.`);
    if (pending === 'gift' && !world.flags[`gift_${npc.id}`]) add('accept_gift', '收下这份心意', `Accept and consume exactly the offered ${npc.pendingAction?.subject?.label}; no substitute item.`);
    if (pending === 'promise' && capturedWork(world,npc) && !npc.mind.commitments.some(c => isHelpPromise(c.id) && c.status === 'active')) add('accept_promise', '同意稍后回来帮忙', `Agree to the player's explicit proposal: return within ${RETURN_SECONDS} seconds to ${CHORES[npc.id]}. Work takes ${CHORE_SECONDS} seconds and pays ${CHORE_REWARD} coins on completion.`);
    if (pending === 'apologize') add('accept_apology', '接受这次道歉', `Accept the apology specifically for ${npc.pendingAction?.subject?.label}. This does not erase the incident or mark broken obligations fulfilled.`);
    if (pending === 'expose' && SECRET_FACTS[npc.id] && world.player.knowledge.includes(SECRET_FACTS[npc.id].id)) add('react_exposure', '要求保守秘密', 'Express hurt that a known private matter is being raised openly.');
    for (const candidate of npcLifeOptions(world,npc)) {
      if ((candidate.id.startsWith('eat:') && npc.needs.hunger < 40) || (candidate.id.startsWith('rest:') && npc.needs.energy < 40)) {
        options.push({...candidate,id:`defer:${candidate.id}`,label:`先${candidate.label}，稍后再聊`,kind:'defer',description:`Tell the player you need a break, then start this actual timed job. ${candidate.description}`});
      }
    }
    const reachable=new Set(forecastNpcActions(world,npc,options).map(f=>f.id));
    return options.filter(o=>reachable.has(o.id));
  }
  if (npc.job || participatingConversation(world,npc) || activeOrder(world)?.customerId === npc.id) return [];
  if(socialInvitation(world,npc)){
    add('social:accept','接受街坊的闲谈邀请','Accept this invitation. Spend eight uninterrupted seconds together; each gains 30 social satisfaction only at completion.','social_response');
    add('social:decline','婉拒这次闲谈','Decline this invitation. No reward, obligation, or reservation.','social_response');
    add('social:defer','表示稍后再聊','Defer this invitation and return to your own plans. The proposer stops waiting; this creates no promise or future acceptance.','social_response');
  }
  add('wait', '在街边想一想', 'Pause and observe the public street. Waiting does not restore physical needs.', 'idle');
  const ownTask = availableWork(world, npc);
  const workGoal=npc.mind.personal.goals.some(g=>g.activity==='work'&&g.completedAt===undefined);
  if (npc.needs.energy >= 15 && npc.needs.hunger >= 10 && (ownTask||workGoal||npc.needs.workPressure>=20)) add('work', ownTask ? `自己${CHORES[npc.id]}` : '忙自己的事情', `Travel to your workplace and work for 16 uninterrupted seconds: ${ownTask ? `${ownTask.id}: ${CHORES[npc.id]}; cause: ${ownTask.cause}` : stableIdentity(npc).goal}. Finishing reduces work pressure by 35 and costs 8 energy. Reserved player tasks cannot be consumed. No player money is created.`, 'work');
  options.push(...npcLifeOptions(world, npc));
  for (const building of BUILDINGS) if(distance(npc,building.door)>24) add(`visit:${building.id}`, `去${building.name}`, `Walk along the streets to ${building.name}.`, 'move', building.id);
  if (npc.trust >= 2 && distance(npc, world.player) > 90 && distance(npc, world.player) < 400) add('follow', '走近熟悉的你', 'Walk toward the visible player because of your established friendship.', 'move', 'player');
  if (npc.trust < 0 && distance(npc, world.player) < 320) add('avoid', '暂时保持距离', 'Choose a reachable place away from the player.', 'move');
  const reachable=new Set(forecastNpcActions(world,npc,options).map(f=>f.id));
  return options.filter(o=>reachable.has(o.id));
}

export function getContext(world: World, npcId: string): Record<string, unknown> {
  const npc = npcById(world, npcId);
  if (!npc) return {};
  const options = getOptions(world,npcId);
  const situation = {
    time: Math.round(world.time), revision: npc.revision,
    self: { id: npc.id, name: npc.name, ...stableIdentity(npc), privateConcern: contextualPrivateConcern(npc, world.time), knownFacts: [], memories: npc.memories.slice(-6).map(m => ({ ...m })), trustInPlayer: npc.trust, mood: npc.mood, activity: npc.activity, lastDecision: npc.lastDecision, ...npcLifeContext(npc), observedWork: ownedWork(world, npc).map(t => ({...t})), ...getNpcMotivation(world,npc,options), x: Math.round(npc.x), y: Math.round(npc.y) },
    publicObservation: { player: distance(npc, world.player) < 400 ? { x: Math.round(world.player.x), y: Math.round(world.player.y), distance: Math.round(distance(npc, world.player)) } : 'out of sight', nearbyPeople: world.npcs.filter(n => n.id !== npc.id && distance(npc, n) < 360).map(n => ({ id: n.id, name: n.name, role: n.role, x: Math.round(n.x), y: Math.round(n.y) })), places: BUILDINGS.map(b => ({ id: b.id, name: b.name, door: { ...b.door } })) },
    socialInvitation: socialInvitation(world,npc),
    pendingInteraction: npc.pendingInteraction ?? null, playerAction: npc.pendingAction ?? null, delivery: deliverySituation(world,npcId),
    options,
    instruction: 'Choose from the available actions. Honor active commitments, personality and known history. Use the time-qualified knowledge views for current beliefs; memories describe past events. Conflicted claims need verification. Do not invent other people’s secrets or hidden world state.',
  };
  return {...buildDecisionContext(npc.mind, situation, world.time), self: {...situation.self, authoredPlanDialogue: authoredPlanDialogue(npc,world.time,world)}};
}

export function playerInteract(world: World, npcId: string, choiceId: string): string {
  const npc = npcById(world, npcId);
  if (world.survival.dead || world.player.activity) return '先完成当前活动。';
  if (!npc || distance(world.player, npc) > 110) return '再走近一点，才能和对方说话。';
  if (npc.pendingInteraction) return `${npc.name}正在斟酌刚才的话，稍等片刻。`;
  if (npc.mind.dialogue.nextSequence>=1e9-1)return '这段交谈暂时无法继续。';
  const action=resolvePlayerAction(world,npc,choiceId);
  if(!action) return choiceId==='expose'?'你还不知道对方的秘密，不能凭空提起。':choiceId.startsWith('gift')?'请选择一份当前背包中可赠送的食物；没有可送的物品时不能赠送。':'当前没有这项交互，先和对方谈清楚具体事情。';
  const interaction=action.intent as Interaction;
  if (interaction === 'expose' && (!SECRET_FACTS[npc.id] || !world.player.knowledge.includes(SECRET_FACTS[npc.id].id))) return '你还不知道对方的秘密，不能凭空提起。';
  if (interaction === 'gift' && !world.player.inventory.some(isFood)) return '背包里没有可以送出的吃喝了。';
  if (interaction === 'deliver' || interaction === 'explain') {
    const order = activeOrder(world);
    if (!order || order.customerId !== npcId || order.status !== 'carrying' || !world.player.inventory.includes(parcelName(order))) return '你没有这位居民待收的餐品。';
    if (interaction === 'explain') order.explanation = true;
  }
  cancelNpcJob(world,npc,'玩家来交谈，暂时中止了自己的事情。');
  const approaching=incomingConversation(world,npc);
  if(approaching)cancelNpcJob(world,approaching,'对方要先和玩家说话，这次闲谈没有完成。');
  interruptIntent(npc.mind, '玩家走近交谈', world.time);
  beginIntent(npc.mind, { id: `respond:${npc.id}:${npc.revision}:${world.time}`, label: '回应玩家的'+interactionLabel(interaction), phase: 'waiting', since: world.time });
  npc.activity = '正在回应你';
  npc.pendingInteraction = interaction; npc.path = []; npc.cooldown = 0;
  npc.pendingAction=action;
  remember(world, npc, `玩家对我说：“${action.label}”`, 'player');
  event(world, `你对${npc.name}说：“${action.label}”`, 'player', npc.id);
  return `${npc.name}听见了，正在想怎么回应……`;
}

/** End only an unanswered interaction; completed replies may have started a real job. */
export function endPlayerInteraction(world: World, npcId: string): void {
  const npc = npcById(world, npcId);
  if (!npc?.pendingInteraction) return;
  delete npc.pendingInteraction;
  delete npc.pendingAction;
  npc.cooldown = 3;
  interruptIntent(npc.mind, '玩家结束了交谈', world.time);
  if (!resumeDeliveryMeeting(world, npc)) npc.activity = '等你下次再来';
  // Recording the interruption also advances the NPC revision, invalidating delayed replies.
  remember(world, npc, '玩家结束了交谈，刚才的话留待下次再说。', 'interrupted');
}

export function chooseFallback(world: World, npcId: string): string {
  const npc = npcById(world, npcId), options = getOptions(world, npcId);
  if (!npc || !options.length) return '';
  for (const id of ['receive_tip', 'receive_reduced', 'receive_exact', 'react_exposure', 'accept_gift', 'accept_help', 'accept_promise', 'accept_apology', 'confide', 'request_help']) if (options.some(o => o.id === id)) return id;
  if (npc.pendingInteraction) return options.find(o=>o.id==='reply')?.id ?? options[0].id;
  const {drives,forecasts}=getNpcMotivation(world,npc,options);
  return rankActions(drives,forecasts)[0]?.id ?? '';
}

export function applyDecision(world: World, npcId: string, optionId: string, source: string, meta: DecisionMeta = {}): boolean {
  const npc = npcById(world, npcId);
  if (world.survival.dead || !npc || (meta.revision !== undefined && meta.revision !== npc.revision)) return false;
  // Reject invalid presentation before any transaction, interruption or disclosure.
  if (meta.dialogueText !== undefined && (!npc.pendingInteraction || typeof meta.dialogueText !== 'string' ||
      !meta.dialogueText.trim() || meta.dialogueText.length > 1600)) return false;
  if (npc.pendingInteraction && distance(world.player, npc) > 110) {
    delete npc.pendingInteraction;
    delete npc.pendingAction;
    npc.cooldown = 3;
    interruptIntent(npc.mind,'玩家已经走远，谈话中止',world.time);
    if (!resumeDeliveryMeeting(world,npc)) npc.activity='等你下次再来';
    remember(world, npc, '玩家走远了，刚才的话留待下次再说。', 'interrupted');
    return false;
  }
  const option = getOptions(world, npcId).find(item => item.id === optionId);
  if (!option) return false;
  if(npc.pendingInteraction&&npc.mind.dialogue.nextSequence>=1e9-1)return false;
  const incoming=incomingConversation(world,npc);
  if(incoming && option.kind!=='social_response')cancelNpcJob(world,incoming,'对方选择了自己的安排，这次邀请结束。');
  const before = { money: world.player.money, trust: npc.trust, items: world.player.inventory.length, mood: npc.mood, activity: world.player.activity, needs: {...npc.needs} };
  const pending = npc.pendingInteraction;
  const playerAction=npc.pendingAction;
  const dialogue = DIALOGUE[npc.id];
  const alreadyMet = npc.knownFacts.includes('met-player');
  // Disclosure belongs to the player's action, regardless of which response the NPC selects.
  if (pending === 'expose') {
    const fact = SECRET_FACTS[npc.id];
    if (!fact || !world.player.knowledge.includes(fact.id)) return false;
    npc.trust -= 3; npc.mood = '受伤'; learnNpcFact(npc, 'hurt-by-player', world.time);
    notePersonalEvent(npc,'exposure',`exposure:${npc.revision}:${world.time}`,world.time);
    event(world, `你在街上说起：${fact.text}`, 'disclosure', npc.id);
    for (const witness of world.npcs) {
      if (witness.id === npc.id || distance(witness, world.player) > 180) continue;
      remember(world, npc, `公开谈及这件事时，我看见${witness.name}也在场听见了。`, 'witness');
      if (witness.id === 'tang' && fact.id === 'lin-debt') learnNpcFact(npc, 'tang-knows-debt', world.time, { kind: 'observed' });
      if (witness.knownFacts.includes(`heard-public:${fact.id}`)) continue;
      const learned = !witness.knownFacts.includes(fact.id);
      learnNpcFact(witness, fact.id, world.time, { kind: 'heard', from: 'player' });
      learnNpcFact(witness, `heard-public:${fact.id}`, world.time, { kind: 'heard', from: 'player' });
      witness.trust = clamp(witness.trust - (witness.id === 'tang' && fact.id === 'lin-debt' ? 2 : 1), -10, 10);
      witness.mood = learned ? '惊讶' : '不赞同';
      remember(world, witness, `亲耳听见玩家公开说起：${fact.text}`, 'overheard');
      if (witness.id === 'tang' && fact.id === 'lin-debt') {
        witness.mood = '担心哥哥';
        witness.goal = 'Speak privately with Lin about the debt I just learned about, and offer family support.';
        say(world, witness, '哥哥欠着钱，却一直一个人扛着？我会找他聊聊，但你不该当街说他的难处。');
      } else say(world, witness, learned ? '原来还有这样的事……不过，别人的难处还是私下说吧。' : '这事我知道，但不该这样在街上摊开来说。');
    }
  }
  let reply = '';
  let speech: CharacterResponse | undefined;
  if (['receive_tip','receive_exact','receive_reduced','refuse_delivery'].includes(optionId)) {
    const result = settleDelivery(world,npcId,optionId as 'receive_tip'|'receive_exact'|'receive_reduced'|'refuse_delivery');
    if (result === null) return false; reply = result;
  } else if (option.kind === 'defer') {
    const underlying={...option,id:option.id.slice('defer:'.length),kind:'npc_job'};
    if (!startNpcJob(world,npc,underlying)) return false;
    reply=underlying.id.startsWith('eat:')?'我饿了，先去茶馆吃顿饭，稍后再聊。':'我有些累，先去休息一会儿，稍后再聊。';
  } else if (optionId === 'accept_gift') {
    const index = world.player.inventory.indexOf(String(playerAction?.parameters.item)); if (index < 0 || !isFood(world.player.inventory[index])) return false;
    const item = world.player.inventory.splice(index,1)[0]; world.flags[`gift_${npc.id}`] = true;
    npc.needs.hunger=clamp(npc.needs.hunger+FOOD[item].hunger); npc.needs.energy=clamp(npc.needs.energy+FOOD[item].energy);
    npc.trust += 2; npc.mood = '暖心'; reply = `谢谢，我${item==='热茶'?'喝完':'吃完'}了你送的${item}，这份心意我记住了。`;
  } else if (optionId === 'accept_help') {
    const task = capturedWork(world, npc);
    if (world.player.activity || !task || !claimWork(world, npc, task.id, 'player')) return false;
    world.player.activity = { taskId:task.id, kind:'help', label:`帮${npc.name}${CHORES[npc.id]}`, startedAt:world.time, endsAt:world.time+CHORE_SECONDS, npcId:npc.id, origin:{x:world.player.x,y:world.player.y} };
    reply=`好，那就${CHORES[npc.id]}吧。工作 ${CHORE_SECONDS} 秒，完成后付你 ${CHORE_REWARD} 元。`;
  } else if (optionId === 'accept_promise') {
    const task = capturedWork(world, npc);
    if (!task || !claimWork(world, npc, task.id, 'player')) return false;
    const previouslyPromised = world.flags[`promised_once_${npc.id}`] || world.flags[`apology_promise_${npc.id}`] || npc.knownFacts.includes('player-promised-help') || npc.mind.commitments.some(c=>isHelpPromise(c.id));
    const promiseId = previouslyPromised ? `help-player:${task.id}:${npc.revision}` : 'help-player';
    world.flags[`promised_once_${npc.id}`] = true;
    task.promiseId = promiseId;
    learnNpcFact(npc, 'player-promised-help', world.time); setCommitment(npc.mind,{id:promiseId,description:`工作 ${task.id}：玩家约好在 ${RETURN_SECONDS} 秒内回来${CHORES[npc.id]}；工作 ${CHORE_SECONDS} 秒，完成后报酬 ${CHORE_REWARD} 元。`,status:'active',createdAt:world.time,dueAt:world.time+RETURN_SECONDS,counterparty:'player'}); reply = `说好了，${RETURN_SECONDS} 秒内回来${CHORES[npc.id]}。工作 ${CHORE_SECONDS} 秒，完成后给你 ${CHORE_REWARD} 元。`;
  } else if (optionId === 'confide') {
    const fact = SECRET_FACTS[npc.id];
    if (!world.player.knowledge.includes(fact.id)) world.player.knowledge.push(fact.id);
    learnNpcFact(npc, 'confided-to-player', world.time); reply = `只告诉你：${fact.text} 请替我保密。`;
  } else if (optionId === 'react_exposure') {
    reply = npc.id === 'mei' ? '这笔往来我会和林舟私下处理，不该让整条街来议论。' : npc.id === 'lan' ? (npc.knownFacts.includes('lan-letter-recovered') ? '信已经找回了，过去的失误就别在街上提了，好吗？' : '信已经够让我着急了，请别再拿这事当街说……') : '这件事请别在街上提了。我以为你会替我保密。';
  } else if (optionId === 'accept_apology') {
    npc.trust++; npc.mood = '缓和';
    if(playerAction?.parameters.incident==='promise') { const promiseId = String(playerAction.parameters.promiseId); if (promiseId === 'help-player') world.flags[`apology_promise_${npc.id}`]=true; learnNpcFact(npc, `apology:${promiseId}`, world.time); reply='这次没按约定回来，我接受你的道歉。以后约好的事情，还要靠行动做到。'; }
    else { learnNpcFact(npc, 'apology-accepted', world.time); reply='我接受你为当众谈论私事的道歉。以后请替我保密。'; }
  } else if (optionId === 'request_help') {
    const task = offerWork(world, npc);
    if (!task) return false;
    reply = `${task.cause}。愿意帮我${CHORES[npc.id]}吗？ 工作 ${CHORE_SECONDS} 秒，完成后给你 ${CHORE_REWARD} 元。`;
    if (npc.mind.commitments.some(c => isHelpPromise(c.id) && c.status === 'active') && npc.trust >= 0) reply += '你上次说有空会来，我还记着呢。';
  } else if (optionId === 'reply' || optionId.startsWith('reply:')) {
    speech = pending === 'greet' || pending === 'ask' ? ordinaryResponses(npc,pending,alreadyMet,world.time,world).find(r=>r.id===optionId) : undefined;
    reply = speech?.text ?? (npc.trust < 0 ? dialogue.guarded : dialogue.friendly);
    if (pending === 'greet' && !alreadyMet) { learnNpcFact(npc, 'met-player', world.time); npc.trust++; }
    if (pending === 'promise' && npc.knownFacts.includes('player-promised-help')) reply = npc.mind.commitments.some(c => isHelpPromise(c.id) && c.status === 'fulfilled') ? `你说到做到，我记得。${dialogue.done}` : npc.mind.commitments.some(c => isHelpPromise(c.id) && c.status === 'broken') ? '上次约好时间，你没有来。等你真正做到了，我才会重新相信。' : `上次的约定还作数吧？${dialogue.request}`;
  } else if (optionId === 'refuse') reply = npc.trust < 0 ? dialogue.guarded : pending === 'gift' && world.flags[`gift_${npc.id}`] ? dialogue.gift : dialogue.refuse;
  else if (option.kind === 'social_response') {
    if(!respondToSocialInvitation(world,npc,optionId))return false;
  }
  else if (option.kind === 'npc_job' || optionId === 'work') {
    if (!startNpcJob(world,npc,option)) return false;
  } else if (option.kind === 'move') {
    let target: Point | undefined;
    if (optionId.startsWith('visit:')) { const building = BUILDINGS.find(b => b.id === option.target)!; target = building.door; npc.destination = building.name; }
    else if (optionId === 'follow') { target = world.player; npc.destination = '你身旁'; }
    else if (optionId === 'avoid') { const building = [...BUILDINGS].sort((a, b) => distance(world.player, b.door) - distance(world.player, a.door))[0]; target = building.door; npc.destination = building.name; }
    else { const other = npcById(world, option.target!)!; target = other; npc.destination = `${other.name}附近`; }
    npc.path = route(npc, target!); npc.activity = option.label;
  } else { npc.path = []; npc.activity = '在街边歇脚'; }
  if(pending==='decline') { const task = capturedWork(world, npc); if (task) task.offered = false; world.flags[`chore_offered_${npc.id}`]=false; reply='好，这份活先不约了。你有空再来问。'; }
  else if(optionId==='reply') {
    if(pending==='request')reply=currentWork(world,npc)?'手头有事情，不过这次我先自己安排，暂时不请你帮忙。':'我眼下没有发现需要托付给你的活；有新事情时再问问我吧。';
    if(pending==='help'||pending==='promise')reply='这份活先别开始，也先不约时间，让我再想想。';
    if(pending==='gift')reply=`${playerAction?.subject?.label}你先留着吧，心意我领了。`;
    if(pending==='apologize')reply='你的话我听到了，这件事我还需要一点时间。';
  }
  npc.trust = clamp(npc.trust, -10, 10); npc.lastDecision = option.label; if (!npc.job && option.kind!=='social_response') npc.cooldown = reply ? 5 : 5 + npc.id.length;
  if (meta.affect) { applyAffect(npc.mind,meta.affect); npc.mood = REACTION_OPTIONS.find(r=>r.id===meta.affect)!.emotion; }
  if (!reply && !npc.job && option.kind!=='social_response') beginIntent(npc.mind,{id:option.id+':'+Math.floor(world.time),label:option.label,target:option.target,phase:npc.path.length?'acting':'waiting',since:world.time,until:world.time+npc.cooldown});
  else if (reply && !npc.job) {
    completeIntent(npc.mind,world.time);
    if (!resumeDeliveryMeeting(world,npc)) npc.activity = world.player.activity?.npcId === npcId ? '看着你完成约定的帮忙' : '刚与你交谈完';
  }
  // Semantic effects above remain authoritative. Preserve unsupported generated claims as
  // actual speech for evaluation; do not execute them or silently repair them with a template.
  if (pending && meta.dialogueText !== undefined) reply = meta.dialogueText;
  if(reply && pending) {
    const authoredFollowUp = speech?.followUp ?? (optionId === 'request_help' ? '你刚说的那份活，具体是怎么回事？' : undefined);
    // The semantic subject belongs to the selected action, but generated wording may omit
    // its details. Never smuggle those unspoken details into the player's next question.
    const followUp = authoredFollowUp && meta.dialogueText !== undefined ? '你刚才说的，能再具体说说吗？' : authoredFollowUp;
    const feelingEvent=({accept_gift:'gift',accept_apology:'apology'} as Record<string,string>)[optionId];
    if(feelingEvent)notePersonalEvent(npc,feelingEvent,`${optionId}:${npc.revision}:${world.time}`,world.time);
    // Completed exchanges retain both voices. An unanswered question remains in pendingAction.
    const reward=recordDialogueExchange(npc.mind,{counterparty:'player',topic:pending,text:playerAction!.label,at:world.time,
      ...(typeof playerAction!.parameters.turn==='number'?{inReplyTo:playerAction!.parameters.turn}:{})},
      {counterparty:'player',topic:speech?.topic ?? (optionId==='request_help'?'work':pending),text:reply,at:world.time,depth:speech?.depth??0,...(speech?.subject?{subject:speech.subject}:optionId==='request_help'?{subject:`observed-work:${currentWork(world,npc)?.id}`} : {}),
      ...(followUp ? { followUp } : {})},Boolean(speech?.rewardEligible));
    if(reward) npc.needs.social=clamp(npc.needs.social+8);
  }
  const changes: string[] = npcNeedChanges(before.needs,npc.needs);
  if (npc.job) changes.push(`开始：${option.label}（到达后完成才生效）`);
  if (world.player.money !== before.money) changes.push('金钱 '+(world.player.money-before.money));
  if (npc.trust !== before.trust) changes.push('信任 '+(npc.trust-before.trust));
  if (world.player.inventory.length !== before.items) changes.push('背包物品 '+(world.player.inventory.length-before.items));
  if (npc.mood !== before.mood) changes.push('情绪：'+npc.mood);
  if (world.player.activity && world.player.activity !== before.activity) changes.push('开始：'+world.player.activity.label);
  if (!changes.length) changes.push(reply?'新增一段角色经历':'意图：'+option.label);
  delete npc.pendingInteraction;
  delete npc.pendingAction;
  if (reply) { remember(world, npc, reply, 'reply'); say(world, npc, reply); }
  else npc.revision++;
  world.decisions.push({ time: world.time, npcId, choice: option.id, label: option.label, changes, ...(meta.affect?{affect:meta.affect}:{}), source: source.slice(0, 80), ...(meta.latencyMs !== undefined ? { latencyMs: meta.latencyMs } : {}), ...(meta.confidence !== undefined ? { confidence: meta.confidence } : {}), ...(meta.model ? { model: meta.model.slice(0, 120) } : {}), ...(meta.cost !== undefined ? { cost: meta.cost } : {}) });
  world.decisions = world.decisions.slice(-180);
  return true;
}
