import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  activeOrder, advance, applyDecision, BUILDINGS, createWorld, dayOf, DAY_SECONDS,
  distance, getContext, getOptions, isFood, loadWorld, movePlayer, orderCondition,
  parcelName, performService, PLAZA, playerInteract, route, serializeWorld,
} from '../src/sim';
import type { Point } from '../src/sim';

/** Deterministic rules exercise mechanics. This is explicitly not evidence of Jev model quality. */
export function runSurvivalPlaythrough() {
  const world = createWorld();
  const dt = .25, walkSpeed = 148;
  let movementSteps = 0, movedPixels = 0;
  const deliveries: Array<Record<string, unknown>> = [];
  const services: Array<{ at: number; action: string }> = [];
  const days: Array<Record<string, unknown>> = [];
  const door = (id: string) => BUILDINGS.find(building => building.id === id)!.door;
  const round = (value: number) => Math.round(value * 100) / 100;
  const snapshot = () => ({ day: dayOf(world), at: round(world.time), money: world.player.money, hunger: round(world.player.hunger), energy: round(world.player.energy), health: round(world.player.health), delivered: world.survival.delivered });
  days.push(snapshot());

  function step(seconds = dt) {
    const previousDay = dayOf(world);
    advance(world, seconds);
    assert.equal(world.survival.dead, false, `Player died at t=${world.time}`);
    if (dayOf(world) !== previousDay) {
      assert.ok(loadWorld(serializeWorld(world)), 'Day-boundary state must remain loadable');
      days.push(snapshot());
    }
  }
  function wait(seconds: number) {
    for (let left = seconds; left > 1e-8; left -= dt) step(Math.min(dt, left));
  }
  function walk(target: Point) {
    const path = route(world.player, target);
    assert.ok(path.length || distance(world.player, target) < 1, 'No walkable route');
    for (const point of path) {
      for (let attempts = 0; distance(world.player, point) > .1; attempts++) {
        assert.ok(attempts < 1000, `Movement stalled near ${JSON.stringify(point)}`);
        assert.equal(world.player.activity, null, 'Cannot walk during a paid or resting activity');
        const previous = { x: world.player.x, y: world.player.y };
        const d = distance(world.player, point), travel = Math.min(d, walkSpeed * dt);
        movePlayer(world, (point.x - world.player.x) / d * travel, (point.y - world.player.y) / d * travel);
        movedPixels += distance(previous, world.player);
        movementSteps++;
        step();
      }
    }
    assert.ok(distance(world.player, target) < 1);
  }
  function service(action: string) {
    services.push({ at: round(world.time), action });
    return performService(world, action);
  }
  function finishActivity() {
    assert.ok(world.player.activity, 'Expected an activity to have begun');
    const end = world.player.activity.endsAt;
    while (world.time < end - 1e-8) step(Math.min(dt, end - world.time));
    assert.equal(world.player.activity, null);
  }
  function rest() {
    walk(PLAZA);
    service('rest');
    finishActivity();
  }
  function eatOrBuy() {
    let food = world.player.inventory.find(item => isFood(item) && item !== '热茶');
    if (!food) {
      if (world.player.money < 14) {
        if (world.player.energy < 25) rest();
        walk(door('post'));
        if (world.survival.jobReadyAt > world.time) wait(world.survival.jobReadyAt - world.time);
        service('work');
        finishActivity();
      }
      walk(door('tavern'));
      service('buy:热饭');
      food = world.player.inventory.find(item => item === '热饭');
      assert.ok(food, 'Food purchase failed');
    }
    service(`eat:${food}`);
  }

  for (let completed = 0; completed < 3; completed++) {
    if (world.player.energy < 35) rest();
    if (world.player.hunger < 40) eatOrBuy();
    walk(door('tavern'));
    while (!world.survival.orders.some(order => order.status === 'offered')) step();
    const order = world.survival.orders.find(candidate => candidate.status === 'offered')!;
    service(`accept:${order.id}`);
    assert.equal(activeOrder(world)?.id, order.id);
    assert.equal(order.status, 'accepted');
    service('pickup');
    assert.equal(world.player.inventory.includes(parcelName(order)), false, 'Preparation cannot be skipped');
    wait(order.readyAt - world.time);
    assert.equal(order.status, 'ready');
    service('pickup');
    assert.equal(world.player.inventory.filter(item => item === parcelName(order)).length, 1);
    walk(order.address);
    const npc = world.npcs.find(character => character.id === order.customerId)!;
    for (let attempts = 0; distance(world.player, npc) > 100; attempts++) {
      assert.ok(attempts < 1200, 'Recipient never arrived at the agreed address');
      step();
    }
    playerInteract(world, npc.id, 'deliver');
    const choices = getOptions(world, npc.id).map(option => option.id);
    // This test policy lets the generous artist tip; all other customers pay the agreed fee.
    const choice = npc.id === 'tang' && choices.includes('receive_tip') ? 'receive_tip' : 'receive_exact';
    assert.ok(choices.includes(choice));
    const context = getContext(world, npc.id);
    const condition = orderCondition(world, order), moneyBefore = world.player.money;
    assert.equal(applyDecision(world, npc.id, choice, 'test-policy', { revision: npc.revision, affect: choice === 'receive_tip' ? 'warm' : 'focused' }), true);
    assert.equal(order.status, 'delivered');
    assert.equal(world.player.inventory.includes(parcelName(order)), false);
    assert.equal(npc.mind.commitments.find(commitment => commitment.id === order.id)?.status, 'fulfilled');
    assert.equal(applyDecision(world, npc.id, choice, 'test-policy'), false, 'Cannot settle twice');
    deliveries.push({ order: order.id, customer: npc.id, at: round(world.time), role: (context.profile as { role: string }).role, choice, ...condition, paid: world.player.money - moneyBefore });
  }

  // Exercise the paid job and full-duration sleep once, in addition to the delivery economy.
  if (world.player.energy < 25) rest();
  walk(door('post'));
  const beforeWork = world.player.money;
  service('work');
  assert.equal(world.player.money, beforeWork, 'No advance payment');
  finishActivity();
  assert.equal(world.player.money, beforeWork + 12);
  walk(door('home'));
  service('sleep');
  finishActivity();

  // Continue until the end of day three, maintaining basic needs through public services.
  const end = DAY_SECONDS * 3 - dt;
  while (world.time < end) {
    if (world.player.hunger < 40) eatOrBuy();
    else if (world.player.energy < 35) rest();
    else step(Math.min(dt, end - world.time));
  }
  assert.equal(dayOf(world), 3);
  assert.equal(world.survival.milestone, true);
  assert.ok(world.survival.delivered >= 3);
  assert.equal(world.survival.failed, 0);
  assert.ok(loadWorld(serializeWorld(world)), 'Final state must remain loadable');
  assert.ok(world.decisions.every(decision => decision.source === 'test-policy'));
  return {
    status: 'passed', driver: 'deterministic test-policy; no model/API calls',
    elapsedSeconds: round(world.time), movement: { steps: movementSteps, pixels: round(movedPixels), teleports: 0 },
    days, final: snapshot(), deliveries, services,
    earned: world.survival.earned, spent: world.survival.spent,
    milestone: world.survival.milestone, saveRoundtrip: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(runSurvivalPlaythrough(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
}
