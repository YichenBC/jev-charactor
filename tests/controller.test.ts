import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionController } from '../src/controller';
import { createWorld, playerInteract, serializeWorld } from '../src/sim';
import { REACTION_OPTIONS } from '../src/character';
import type { World } from '../src/sim';

type RequestBody = { npcId: string; revision: number; options: Array<{ id: string }>; state: Record<string, unknown> };
type PendingFetch = {
  url: string; body: RequestBody | undefined; signal: AbortSignal | null | undefined;
  resolve: (response: Response) => void; reject: (error: Error) => void;
};

function setup(conversation?: () => string | null) {
  let world = createWorld(), running = true;
  // Fixture setup: all idle residents are eligible for scheduler dispatch.
  world.npcs.forEach(npc => { npc.cooldown = 0; });
  const calls: PendingFetch[] = [];
  const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal, resolve, reject });
  }));
  vi.stubGlobal('fetch', fetchMock);
  const changed = vi.fn(), notify = vi.fn();
  const controller = new DecisionController({ world: () => world, running: () => running, changed, notify, ...(conversation ? { conversation } : {}) });
  controller.configured = true;
  controller.checked = true;
  return {
    controller, calls, fetchMock, changed, notify,
    world: () => world,
    replaceWorld: (replacement: World) => { world = replacement; },
    pause: () => { running = false; },
  };
}

function succeed(call: PendingFetch, overrides: Record<string, unknown> = {}) {
  const body = call.body!;
  call.resolve(Response.json({
    npcId: body.npcId, revision: body.revision,
    choice: body.options.some(option => option.id === 'reply') ? 'reply' : 'wait',
    affect: 'focused', model: 'test-model', confidence: .8, latencyMs: 12, cost: .0001,
    ...overrides,
  }));
}
function fail(call: PendingFetch, error = 'connection_timeout', status = 503) {
  call.resolve(Response.json({ error }, { status }));
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('decision scheduling and response isolation', () => {
  it.each(['jev', 'rules'] as const)('does not dispatch autonomous actions during an idle conversation in %s mode', async mode => {
    const { controller, calls, world } = setup(() => 'lin');
    controller.mode = mode;
    const before = serializeWorld(world());
    const turn = controller.tick();
    // Resolve an unexpected request so the regression fails without hanging.
    if (calls[0]) succeed(calls[0]);
    await turn;
    expect(calls).toHaveLength(0);
    expect(serializeWorld(world())).toBe(before);
  });

  it('resolves only the focused pending reply while time, physical needs and other residents stay fixed', async () => {
    const { controller, calls, world } = setup(() => 'lin');
    const npc = world().npcs[0];
    playerInteract(world(), npc.id, 'greet');
    const before = structuredClone(world());
    const turn = controller.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.npcId).toBe(npc.id);
    succeed(calls[0]);
    await turn;
    expect(npc.pendingInteraction).toBeUndefined();
    expect(world().time).toBe(before.time);
    expect(world().player).toEqual(before.player);
    expect(npc.needs.hunger).toBe(before.npcs[0].needs.hunger);
    expect(npc.needs.energy).toBe(before.npcs[0].needs.energy);
    expect(world().npcs.slice(1)).toEqual(before.npcs.slice(1));
    // Even a newly eligible selected NPC must wait until the conversation ends.
    npc.cooldown = 0;
    vi.advanceTimersByTime(1000);
    const extra = controller.tick();
    if (calls[1]) succeed(calls[1]);
    await extra;
    expect(calls).toHaveLength(1);
    expect(world().decisions).toHaveLength(1);
  });

  it.each(['other-focus', 'reply-finished'] as const)('drops an in-flight success that no longer belongs to a pending focused interaction (%s)', async condition => {
    let focus: string | null = null;
    const { controller, calls, world } = setup(() => focus);
    const turn = controller.tick();
    const npc = world().npcs.find(n => n.id === calls[0].body?.npcId)!;
    focus = condition === 'other-focus' ? world().npcs.find(n => n.id !== npc.id)!.id : npc.id;
    const before = serializeWorld(world());
    succeed(calls[0]);
    await turn;
    expect(serializeWorld(world())).toBe(before);
    expect(controller.successes).toBe(0);
  });

  it('still blocks a pending focused reply when the application is paused', async () => {
    const { controller, calls, world, pause } = setup(() => 'lin');
    playerInteract(world(), 'lin', 'greet');
    pause();
    await controller.tick();
    expect(calls).toHaveLength(0);
  });

  it('ignores a failure from an unrelated request after a conversation takes focus', async () => {
    let focus: string | null = null;
    const { controller, calls, notify } = setup(() => focus);
    const turn = controller.tick();
    focus = 'tang';
    fail(calls[0], 'upstream_402', 402);
    await turn;
    expect(controller.failures).toBe(0);
    expect(controller.blocked).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(['connection_timeout', 'upstream_402'])('explains the conversation pause when a focused reply fails (%s)', async error => {
    const { controller, calls, world, notify } = setup(() => 'lin');
    playerInteract(world(), 'lin', 'greet');
    const turn = controller.tick();
    fail(calls[0], error);
    await turn;
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('暂停'));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('结束交谈'));
    expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/继续行动|继续执行/));
  });

  it('retains a terminal blocked error when an unrelated in-flight request succeeds', async () => {
    const { controller, calls, world } = setup();
    const first = controller.tick();
    vi.advanceTimersByTime(350);
    const second = controller.tick();
    expect(calls).toHaveLength(2);
    expect(calls[0].body?.npcId).not.toBe(calls[1].body?.npcId);
    fail(calls[0], 'upstream_402', 402);
    await first;
    expect(controller.blocked).toBe(true);
    expect(controller.error).toContain('余额不足');
    const error = controller.error, retryAt = controller.retryAt;
    succeed(calls[1]);
    await second;
    expect(controller.successes).toBe(1);
    expect(controller.failures).toBe(1);
    expect(controller.blocked).toBe(true);
    expect(controller.error).toBe(error);
    expect(controller.retryAt).toBe(retryAt);
    expect(world().decisions).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    await controller.tick();
    expect(calls).toHaveLength(2);
  });

  it('automatically retries transient failures at most three times until a manual status check clears them', async () => {
    const { controller, calls, notify } = setup();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const turn = controller.tick();
      expect(calls).toHaveLength(attempt);
      fail(calls[attempt - 1]);
      await turn;
      expect(controller.failures).toBe(attempt);
      expect(controller.blocked).toBe(attempt === 3);
      expect(controller.retryAt).toBe(Date.now() + attempt * 2500);
      await controller.tick();
      expect(calls).toHaveLength(attempt);
      vi.advanceTimersByTime(attempt * 2500);
    }
    vi.advanceTimersByTime(60_000);
    await controller.tick();
    expect(calls).toHaveLength(3);
    expect(notify).toHaveBeenCalledTimes(3);
    const check = controller.check();
    expect(calls[3].url).toBe('/api/status');
    calls[3].resolve(Response.json({ configured: true }));
    await check;
    expect(controller.blocked).toBe(false);
    expect(controller.failures).toBe(0);
    expect(controller.retryAt).toBe(0);
    expect(controller.error).toBe('');
    const resumed = controller.tick();
    expect(calls).toHaveLength(5);
    succeed(calls[4]);
    await resumed;
    expect(controller.successes).toBe(1);
  });

  it('retains the terminal failure when an unrelated in-flight transient failure arrives later', async () => {
    const { controller, calls } = setup();
    const first = controller.tick();
    vi.advanceTimersByTime(350);
    const second = controller.tick();
    fail(calls[0], 'upstream_401', 401);
    await first;
    const terminalError = controller.error;
    expect(controller.blocked).toBe(true);
    fail(calls[1]);
    await second;
    expect(controller.blocked).toBe(true);
    expect(controller.error).toBe(terminalError);
    vi.advanceTimersByTime(60_000);
    await controller.tick();
    expect(calls).toHaveLength(2);
  });

  it.each(['cancelled', 'replaced', 'paused'] as const)('does not apply a successful stale response after the world is %s', async condition => {
    const harness = setup(), { controller, calls } = harness;
    const original = harness.world(), before = serializeWorld(original);
    const turn = controller.tick();
    if (condition === 'cancelled') controller.cancel();
    if (condition === 'replaced') harness.replaceWorld(createWorld());
    if (condition === 'paused') harness.pause();
    const currentBefore = serializeWorld(harness.world());
    succeed(calls[0], { affect: 'irritated' });
    await turn;
    expect(serializeWorld(original)).toBe(before);
    expect(serializeWorld(harness.world())).toBe(currentBefore);
    expect(controller.successes).toBe(0);
    expect(controller.failures).toBe(0);
    expect(controller.pending.size).toBe(0);
    if (condition === 'cancelled') expect(calls[0].signal?.aborted).toBe(true);
  });

  it('does not let an old cancelled request remove its replacement from pending state', async () => {
    const { controller, calls } = setup();
    const oldTurn = controller.tick();
    const npcId = calls[0].body!.npcId;
    controller.cancel();
    controller.prioritize(npcId);
    const replacement = controller.tick();
    expect(calls[1].body?.npcId).toBe(npcId);
    const replacementController = controller.pending.get(npcId);
    succeed(calls[0]);
    await oldTurn;
    expect(controller.pending.get(npcId)).toBe(replacementController);
    expect(controller.pending.size).toBe(1);
    succeed(calls[1]);
    await replacement;
    expect(controller.pending.size).toBe(0);
    expect(controller.successes).toBe(1);
  });

  it('does not count a response rejected by a newer character revision as a successful decision', async () => {
    const { controller, calls, world } = setup();
    const turn = controller.tick();
    const npc = world().npcs.find(n => n.id === calls[0].body?.npcId)!;
    // Fixture setup: the player is now beside the resident while its earlier request is in flight.
    world().player.x = npc.x; world().player.y = npc.y;
    playerInteract(world(), npc.id, 'greet');
    expect(npc.revision).toBeGreaterThan(calls[0].body!.revision);
    const afterInteraction = serializeWorld(world());
    succeed(calls[0]);
    await turn;
    expect(serializeWorld(world())).toBe(afterInteraction);
    expect(controller.successes).toBe(0);
    expect(controller.failures).toBe(0);
  });

  it('prioritizes a player interaction over eligible autonomous residents', async () => {
    const { controller, calls, world } = setup();
    const npc = world().npcs.at(-1)!;
    // Fixture setup: player beside the last resident, while earlier residents are also idle.
    world().player.x = npc.x; world().player.y = npc.y;
    playerInteract(world(), npc.id, 'greet');
    controller.prioritize(npc.id);
    const turn = controller.tick();
    expect(calls[0].body?.npcId).toBe(npc.id);
    expect(calls[0].body?.options.some(option => option.id === 'reply')).toBe(true);
    succeed(calls[0]);
    await turn;
    expect(npc.pendingInteraction).toBeUndefined();
    expect(world().decisions[0]).toMatchObject({ npcId: npc.id, choice: 'reply', source: 'jev' });
  });

  it('allows at most two concurrent requests and fills a freed slot without duplicating a resident', async () => {
    const { controller, calls } = setup();
    const first = controller.tick();
    vi.advanceTimersByTime(350);
    const second = controller.tick();
    vi.advanceTimersByTime(350);
    await controller.tick();
    expect(controller.requests).toBe(2);
    expect(controller.pending.size).toBe(2);
    expect(new Set(calls.map(call => call.body?.npcId)).size).toBe(2);
    succeed(calls[0]);
    await first;
    const third = controller.tick();
    expect(controller.requests).toBe(3);
    expect(controller.pending.size).toBe(2);
    expect(calls[2].body?.npcId).not.toBe(calls[1].body?.npcId);
    succeed(calls[1]); succeed(calls[2]);
    await Promise.all([second, third]);
    expect(controller.pending.size).toBe(0);
  });

  it('passes the model affect through to a coherent expression and records Jev provenance', async () => {
    const { controller, calls, world } = setup();
    const turn = controller.tick();
    succeed(calls[0], { affect: 'irritated' });
    await turn;
    const npc = world().npcs.find(n => n.id === calls[0].body?.npcId)!;
    expect(npc.mind.affect).toBe('irritated');
    expect(npc.mind.expression).toBe(REACTION_OPTIONS.find(option => option.id === 'irritated')!.expression);
    expect(world().decisions).toEqual([expect.objectContaining({ source: 'jev', affect: 'irritated', model: 'test-model', cost: .0001 })]);
    expect(controller.error).toBe('');
    expect(controller.successes).toBe(1);
  });

  it.each([undefined, 'invented', null])('rejects a local response with invalid affect before any world mutation (%s)', async affect => {
    const { controller, calls, world } = setup();
    const before = serializeWorld(world());
    const turn = controller.tick();
    succeed(calls[0], { affect });
    await turn;
    expect(serializeWorld(world())).toBe(before);
    expect(controller.successes).toBe(0);
    expect(controller.failures).toBe(1);
    expect(controller.error).not.toBe('');
    expect(controller.pending.size).toBe(0);
  });

  it('never silently switches to a rules action on network failure', async () => {
    const { controller, calls, world } = setup();
    const before = serializeWorld(world());
    const turn = controller.tick();
    calls[0].reject(new Error('network unreachable'));
    await turn;
    expect(controller.mode).toBe('jev');
    expect(serializeWorld(world())).toBe(before);
    expect(controller.successes).toBe(0);
    expect(controller.failures).toBe(1);
    expect(controller.error).not.toBe('');
  });
  it('ends an obsolete item offer instead of leaving a paused conversation stuck', async () => {
    const {controller,world,notify,calls}=setup(()=> 'lin');
    playerInteract(world(),'lin','gift:面包');
    world().player.inventory=['热茶'];
    await controller.tick();
    expect(world().npcs[0].pendingInteraction).toBeUndefined();
    expect(world().npcs[0].pendingAction).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('重新选择'));
    expect(world().player.inventory).toEqual(['热茶']);
  });
});
