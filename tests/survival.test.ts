import { describe, expect, it } from 'vitest';
import {
  activeOrder, advance, applyDecision, BUILDINGS, createWorld, dayOf, DAY_SECONDS,
  distance, getContext, getOptions, loadWorld, movePlayer, parcelName, performService,
  PLAZA, playerInteract, route, serializeWorld,
} from '../src/sim';
import type { Interaction, Point, World } from '../src/sim';

function elapse(world: World, seconds: number) {
  for (let remaining = seconds; remaining > 1e-8; remaining -= .25) advance(world, Math.min(.25, remaining));
}
const door = (id: string) => BUILDINGS.find(building => building.id === id)!.door;

// Fixture setup only: position actors for isolated boundary tests, never simulate travel by teleporting.
function fixturePlace(world: World, point: Point) { Object.assign(world.player, { x: point.x, y: point.y }); }
function fixtureCarry() {
  const world = createWorld();
  fixturePlace(world, door('tavern'));
  const order = world.survival.orders[0];
  performService(world, `accept:${order.id}`);
  elapse(world, 6);
  performService(world, 'pickup');
  return { world, order, npc: world.npcs.find(n => n.id === order.customerId)! };
}
function respond(world: World, npcId: string, interaction: Interaction, choice: string) {
  if((interaction==='help'||interaction==='promise')&&!world.flags[`chore_offered_${npcId}`]&&!world.flags[`helped_${npcId}`]){playerInteract(world,npcId,'request');expect(applyDecision(world,npcId,'request_help','test-policy')).toBe(true);}
  playerInteract(world, npcId, interaction);
  const npc = world.npcs.find(n => n.id === npcId)!;
  expect(applyDecision(world, npcId, choice, 'test-policy', { revision: npc.revision })).toBe(true);
}
function walk(world: World, target: Point) {
  const path = route(world.player, target);
  expect(path.length || distance(world.player, target) < 1).toBeTruthy();
  for (const waypoint of path) {
    for (let steps = 0; distance(world.player, waypoint) > .1; steps++) {
      if (steps > 1000) throw new Error('Movement stalled');
      const d = distance(world.player, waypoint), step = Math.min(d, 148 * .25);
      movePlayer(world, (waypoint.x - world.player.x) / d * step, (waypoint.y - world.player.y) / d * step);
      advance(world, .25);
    }
  }
}

describe('survival delivery loop', () => {
  it('requires the restaurant, actual preparation time, and exactly one parcel pickup', () => {
    const world = createWorld(), order = world.survival.orders[0];
    performService(world, `accept:${order.id}`);
    expect(order.status).toBe('offered');
    fixturePlace(world, door('tavern'));
    const stock = world.survival.stock.meals;
    performService(world, `accept:${order.id}`);
    expect(order.status).toBe('accepted');
    expect(world.survival.stock.meals).toBe(stock - 1);
    performService(world, `accept:${order.id}`);
    performService(world, 'pickup');
    expect(world.player.inventory).not.toContain(parcelName(order));
    elapse(world, 5.75);
    expect(order.status).toBe('accepted');
    elapse(world, .25);
    expect(order.status).toBe('ready');
    performService(world, 'pickup');
    performService(world, 'pickup');
    expect(order.status).toBe('carrying');
    expect(world.player.inventory.filter(item => item === parcelName(order))).toHaveLength(1);
    expect(world.survival.stock.meals).toBe(stock - 1);
  });

  it('requires the correct recipient within 110 pixels and rejects an illegal or repeated settlement', () => {
    const { world, order, npc } = fixtureCarry();
    // Fixture setup: recipient already waiting at the integer-coordinate delivery address.
    Object.assign(npc, { ...order.address, path: [] });
    const wrong = world.npcs.find(n => n.id !== npc.id)!;
    fixturePlace(world, wrong);
    playerInteract(world, wrong.id, 'deliver');
    expect(wrong.pendingInteraction).toBeUndefined();
    fixturePlace(world, { x: npc.x + 111, y: npc.y });
    playerInteract(world, npc.id, 'deliver');
    expect(npc.pendingInteraction).toBeUndefined();
    fixturePlace(world, { x: npc.x + 110, y: npc.y });
    playerInteract(world, npc.id, 'deliver');
    const before = world.player.money;
    expect(npc.pendingInteraction).toBe('deliver');
    expect(applyDecision(world, npc.id, 'refuse_delivery', 'test-policy')).toBe(false);
    expect(applyDecision(world, npc.id, 'invented_reward', 'test-policy')).toBe(false);
    expect(world.player.money).toBe(before);
    expect(applyDecision(world, npc.id, 'receive_exact', 'test-policy')).toBe(true);
    expect(world.player.money).toBe(before + order.reward);
    expect(world.survival.delivered).toBe(1);
    expect(world.player.inventory).not.toContain(parcelName(order));
    expect(npc.mind.commitments.find(c => c.id === order.id)?.status).toBe('fulfilled');
    const settled = serializeWorld(world);
    expect(applyDecision(world, npc.id, 'receive_exact', 'test-policy')).toBe(false);
    expect(playerInteract(world, npc.id, 'deliver')).toContain('没有');
    expect(serializeWorld(world)).toBe(settled);
  });

  it('withdraws generous options for cold or late food while preserving explainable choices', () => {
    for (const delay of [0, 56, 121]) {
      const { world, order, npc } = fixtureCarry();
      elapse(world, delay);
      fixturePlace(world, npc);
      playerInteract(world, npc.id, delay ? 'explain' : 'deliver');
      const choices = getOptions(world, npc.id).map(option => option.id);
      expect(choices).toContain('receive_exact');
      if (delay === 0) {
        expect(choices).toContain('receive_tip');
        expect(choices).not.toContain('receive_reduced');
        expect(choices).not.toContain('refuse_delivery');
      } else {
        expect(choices).not.toContain('receive_tip');
        expect(choices).toContain('receive_reduced');
        expect(choices).toContain('refuse_delivery');
        expect(order.explanation).toBe(true);
        expect(applyDecision(world, npc.id, 'receive_tip', 'test-policy')).toBe(false);
        const situation = getContext(world, npc.id).situation as { delivery: { late: boolean; cold: boolean; explained: boolean } };
        expect(situation.delivery).toMatchObject({ late: delay > 120, cold: true, explained: true });
      }
    }
  });

  it('persists refused and expired obligations as broken and disposes their parcels once', () => {
    for (const outcome of ['refused', 'expired']) {
      const { world, order, npc } = fixtureCarry();
      elapse(world, outcome === 'refused' ? 56 : order.expiresAt - world.time + .25);
      if (outcome === 'refused') {
        fixturePlace(world, npc);
        respond(world, npc.id, 'deliver', 'refuse_delivery');
      }
      expect(order.status).toBe(outcome === 'refused' ? 'rejected' : 'expired');
      expect(world.survival.failed).toBe(1);
      expect(world.player.inventory).not.toContain(parcelName(order));
      expect(npc.mind.commitments.find(c => c.id === order.id)?.status).toBe('broken');
      const loaded = loadWorld(serializeWorld(world));
      expect(loaded?.npcs.find(n => n.id === npc.id)?.mind.commitments.find(c => c.id === order.id)?.status).toBe('broken');
      elapse(world, 1);
      expect(world.survival.failed).toBe(1);
    }
  });

  it('provides individual personality and accumulated order history in decision context', () => {
    const { world, npc, order } = fixtureCarry();
    fixturePlace(world, npc);
    respond(world, npc.id, 'deliver', 'receive_exact');
    const context = getContext(world, npc.id);
    expect(context.profile).toEqual(npc.mind.profile);
    expect(context.commitments).toEqual(expect.arrayContaining([expect.objectContaining({ id: order.id, status: 'fulfilled' })]));
    expect(JSON.stringify(context.experiences)).toContain('commitment.fulfilled');
    expect(new Set(world.npcs.map(n => JSON.stringify(getContext(world, n.id).profile))).size).toBe(5);
    expect(JSON.stringify(getContext(world, 'tang'))).not.toContain('lin-debt');
    const loaded = loadWorld(serializeWorld(world));
    expect(loaded?.npcs.find(n => n.id === npc.id)?.mind).toEqual(npc.mind);
  });
});

describe('survival needs and paid activity', () => {
  it('depletes hunger and energy over elapsed time, damages health, and freezes a dead run', () => {
    const world = createWorld(), initial = { ...world.player };
    elapse(world, 10);
    expect(world.player.hunger).toBeCloseTo(initial.hunger - 1.1);
    expect(world.player.energy).toBeCloseTo(initial.energy - .35);
    // Fixture setup: an exhausted, starving player near death.
    Object.assign(world.player, { health: 1, hunger: 0, energy: 0 });
    elapse(world, .25);
    expect(world.player.health).toBeLessThan(1);
    elapse(world, 2);
    expect(world.survival.dead).toBe(true);
    expect(world.player.health).toBe(0);
    const dead = serializeWorld(world);
    elapse(world, 1); movePlayer(world, 10, 0); performService(world, 'eat:面包');
    expect(serializeWorld(world)).toBe(dead);
  });

  it('buys food with cash and stock, then consumes the inventory item for nutrition', () => {
    const world = createWorld();
    // Fixture setup: hungry customer without existing food, standing at the shop.
    fixturePlace(world, door('shop'));
    Object.assign(world.player, { inventory: [], hunger: 30, energy: 30 });
    performService(world, 'buy:面包');
    expect(world.player.money).toBe(12);
    expect(world.survival.stock.bread).toBe(11);
    expect(world.player.hunger).toBe(30);
    expect(world.player.inventory).toEqual(['面包']);
    performService(world, 'eat:面包');
    expect(world.player.inventory).toEqual([]);
    expect(world.player.hunger).toBe(65);
    expect(world.player.energy).toBe(35);
    performService(world, 'eat:面包');
    expect(world.player.hunger).toBe(65);
    performService(world, 'buy:热饭');
    expect(world.player.money).toBe(12);
    fixturePlace(world, door('tavern'));
    performService(world, 'buy:热饭');
    expect(world.player.money).toBe(12);
    expect(world.survival.stock.meals).toBe(12);
  });

  it('restores rest and sleep benefits only after their full elapsed duration', () => {
    for (const [action, location, duration] of [['rest', PLAZA, 12], ['sleep', door('home'), 25]] as const) {
      const world = createWorld();
      // Fixture setup: tired player at the selected legal resting location.
      fixturePlace(world, location);
      Object.assign(world.player, { energy: 20, health: 50 });
      performService(world, action);
      expect(world.player.energy).toBe(20);
      expect(world.player.activity?.kind).toBe(action);
      expect(world.player.money).toBe(action === 'sleep' ? 8 : 20);
      const position = { x: world.player.x, y: world.player.y };
      movePlayer(world, 50, 0);
      expect(world.player).toMatchObject(position);
      elapse(world, duration - .25);
      expect(world.player.activity?.kind).toBe(action);
      expect(world.player.energy).toBeLessThan(20);
      elapse(world, .25);
      expect(world.player.activity).toBeNull();
      expect(world.player.energy).toBeCloseTo(action === 'sleep' ? 100 : 48 - duration * .035);
      if (action === 'sleep') expect(world.player.health).toBeGreaterThanOrEqual(85);
    }
  });

  it('does not pay jobs on start, cancellation, or repeated calls and pays once on completion', () => {
    const world = createWorld();
    fixturePlace(world, door('post'));
    const initial = world.player.money;
    performService(world, 'work');
    expect(world.player.money).toBe(initial);
    elapse(world, 5);
    performService(world, 'cancel_activity');
    for (let i = 0; i < 10; i++) performService(world, 'work');
    expect(world.player.money).toBe(initial);
    expect(world.player.activity).toBeNull();
    elapse(world, 40);
    performService(world, 'work');
    elapse(world, 17.75);
    expect(world.player.money).toBe(initial);
    elapse(world, .25);
    expect(world.player.money).toBe(initial + 12);
    expect(world.survival.earned).toBe(12);
    elapse(world, 10);
    expect(world.player.money).toBe(initial + 12);
  });

  it('allows a penniless player to recover through actual work, food, walking, and free rest', () => {
    const world = createWorld();
    // Fixture setup: recoverable hardship, no cash or carried food.
    fixturePlace(world, door('post'));
    Object.assign(world.player, { money: 0, inventory: [], hunger: 25, energy: 30 });
    performService(world, 'work');
    elapse(world, 18);
    expect(world.player.money).toBe(12);
    walk(world, door('shop'));
    performService(world, 'buy:面包');
    performService(world, 'eat:面包');
    expect(world.player.hunger).toBeGreaterThan(50);
    expect(world.player.money).toBe(4);
    walk(world, PLAZA);
    const tired = world.player.energy;
    performService(world, 'rest');
    elapse(world, 12);
    expect(world.player.energy).toBeGreaterThan(tired + 27);
    expect(world.survival.dead).toBe(false);
  });

  it('fulfills social promises only after real work and breaks unattended overdue promises', () => {
    for (const fulfill of [true, false]) {
      const world = createWorld(), npc = world.npcs[0];
      fixturePlace(world, npc);
      respond(world, npc.id, 'promise', 'accept_promise');
      const initial = world.player.money;
      if (fulfill) {
        respond(world, npc.id, 'help', 'accept_help');
        expect(world.player.money).toBe(initial);
        expect(world.flags[`helped_${npc.id}`]).toBeUndefined();
        expect(npc.mind.commitments.find(c => c.id === 'help-player')?.status).toBe('active');
        elapse(world, 11.75);
        expect(world.player.money).toBe(initial);
        elapse(world, .25);
        expect(world.player.money).toBe(initial + 8);
        expect(world.flags[`helped_${npc.id}`]).toBe(true);
        playerInteract(world, npc.id, 'help');
        expect(getOptions(world, npc.id).map(o => o.id)).not.toContain('accept_help');
      } else elapse(world, 90.25);
      const status = fulfill ? 'fulfilled' : 'broken';
      expect(npc.mind.commitments.find(c => c.id === 'help-player')?.status).toBe(status);
      expect(loadWorld(serializeWorld(world))?.npcs[0].mind.commitments.find(c => c.id === 'help-player')?.status).toBe(status);
    }
  });

  it('does not equate an NPC choosing ordinary work with a completed player job', () => {
    const world = createWorld(), npc = world.npcs[0], before = world.player.money;
    expect(applyDecision(world, npc.id, 'work', 'test-policy')).toBe(true);
    expect(world.player.money).toBe(before);
    expect(world.player.activity).toBeNull();
    expect(world.flags[`helped_${npc.id}`]).toBeUndefined();
    expect(npc.mind.intent?.phase).not.toBe('completed');
  });

  it('restocks at a real day boundary', () => {
    const world = createWorld();
    fixturePlace(world, door('shop'));
    performService(world, 'buy:面包');
    expect(world.survival.stock.bread).toBe(11);
    elapse(world, DAY_SECONDS);
    expect(dayOf(world)).toBe(2);
    expect(world.survival.stock.bread).toBe(12);
  });
});

describe('survival save boundaries', () => {
  it('migrates a legacy save into a funded survival run with character profiles', () => {
    // Fixture setup: a valid v1 snapshot predating survival and character state.
    const legacy = JSON.parse(serializeWorld(createWorld()));
    legacy.version = 1;
    delete legacy.survival;
    for (const key of ['health', 'hunger', 'energy', 'money', 'activity']) delete legacy.player[key];
    for (const npc of legacy.npcs) delete npc.mind;
    const loaded = loadWorld(JSON.stringify(legacy));
    expect(loaded?.version).toBe(2);
    expect(loaded?.player).toMatchObject({ health: 100, hunger: 75, energy: 85, money: 20, activity: null });
    expect(loaded?.survival.orders[0].status).toBe('offered');
    expect(loaded?.npcs.every(npc => npc.mind.profile.role.length > 0)).toBe(true);
  });

  it('roundtrips one matching parcel and rejects forged, duplicated, or orphaned ownership', () => {
    const { world, order } = fixtureCarry();
    expect(loadWorld(serializeWorld(world))).toEqual(world);
    const corruptions = [
      (w: World) => { w.player.inventory.push(parcelName(order)); },
      (w: World) => { w.player.inventory.push('外卖[order-999]'); },
      (w: World) => { w.player.inventory = w.player.inventory.filter(i => i !== parcelName(order)); },
      (w: World) => { w.survival.orders[0].status = 'ready'; },
      (w: World) => { delete w.survival.orders[0].pickedUpAt; },
    ];
    for (const corrupt of corruptions) {
      // Fixture setup: deliberately damaged persisted state.
      const invalid = structuredClone(world);
      corrupt(invalid);
      expect(loadWorld(serializeWorld(invalid))).toBeNull();
    }
    expect(activeOrder(world)?.id).toBe(order.id);
  });
  it('cannot create an impossible help promise after the chore is already completed', () => {
    const world = createWorld(), npc = world.npcs[0];
    world.player.x = npc.x; world.player.y = npc.y;
    playerInteract(world, npc.id, 'request');
    expect(applyDecision(world,npc.id,'request_help','test')).toBe(true);
    playerInteract(world, npc.id, 'help');
    expect(applyDecision(world, npc.id, 'accept_help', 'test')).toBe(true);
    for (let i=0;i<12;i++) advance(world,1);
    expect(world.flags[`helped_${npc.id}`]).toBe(true);
    playerInteract(world, npc.id, 'promise');
    expect(getOptions(world,npc.id).some(o=>o.id==='accept_promise')).toBe(false);
    expect(applyDecision(world,npc.id,'accept_promise','test')).toBe(false);
  });

  it('invalidates in-flight delivery decisions when a meal becomes cold', () => {
    const world = createWorld(); Object.assign(world.player, door('tavern'));
    performService(world, 'accept:order-1'); elapse(world,6); performService(world,'pickup');
    const npc = world.npcs[0]; world.player.x=npc.x; world.player.y=npc.y;
    playerInteract(world, npc.id, 'deliver');
    elapse(world,54); const revision=npc.revision;
    elapse(world,2);
    expect(npc.revision).toBeGreaterThan(revision);
    expect(applyDecision(world,npc.id,'receive_exact','test',{revision})).toBe(false);
    expect(activeOrder(world)?.status).toBe('carrying');
  });
  it('rejects orphan delivery prompts and impossible order chronology in saves', () => {
    const orphan=createWorld(); orphan.npcs[0].pendingInteraction='deliver';
    expect(loadWorld(serializeWorld(orphan))).toBeNull();
    const world=createWorld(); Object.assign(world.player,door('tavern')); performService(world,'accept:order-1');
    activeOrder(world)!.readyAt=activeOrder(world)!.deadline+1;
    expect(loadWorld(serializeWorld(world))).toBeNull();
    expect(loadWorld(JSON.stringify({...createWorld(),unexpected:1}))).toBeNull();
  });

  it('completes the response intent after delivery instead of remaining stuck waiting', () => {
    const world=createWorld(); Object.assign(world.player,door('tavern'));
    performService(world,'accept:order-1'); elapse(world,6); performService(world,'pickup');
    const npc=world.npcs[0]; world.player.x=npc.x; world.player.y=npc.y;
    playerInteract(world,npc.id,'deliver');
    expect(npc.mind.intent?.phase).toBe('waiting');
    expect(applyDecision(world,npc.id,'receive_exact','test')).toBe(true);
    expect(npc.mind.intent?.phase).toBe('completed');
    expect(npc.activity).toBe('刚与你交谈完');
    expect(loadWorld(serializeWorld(world))).toEqual(world);
  });

  it('resumes the agreed delivery route when the player walks away before a social reply', () => {
    const world=createWorld(); Object.assign(world.player,door('tavern')); performService(world,'accept:order-1');
    const npc=world.npcs[0]; world.player.x=npc.x; world.player.y=npc.y;
    playerInteract(world,npc.id,'greet'); const revision=npc.revision;
    movePlayer(world,-250,0);
    expect(applyDecision(world,npc.id,'reply','test',{revision})).toBe(false);
    expect(npc.pendingInteraction).toBeUndefined(); expect(npc.path.length).toBeGreaterThan(0);
    expect(npc.mind.intent?.label).toContain('等玩家送餐');
    elapse(world,30);
    expect(distance(npc,activeOrder(world)!.address)).toBeLessThan(3);
    expect(loadWorld(serializeWorld(world))).toEqual(world);
  });

});
