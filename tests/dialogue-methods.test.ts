import { describe, expect, it } from 'vitest';
import { applyDecision, createWorld, getContext, playerInteract, type World } from '../src/sim';
import { inspectPersonal, advanceGoal } from '../src/character/personal';
import { ordinaryResponses } from '../src/sim/dialogue';
import { planNextStepParts, planReason, planReport } from '../src/sim/dialogueStyle';
import { getPlayerInteractions } from '../src/sim/interactions';

const goalFor = (w: World, id: string, goalId = 'personal-interest') => inspectPersonal(w.npcs.find(n => n.id === id)!.mind, w.time).goals.find(g => g.id === goalId)!;
function open(w: World, id: string, action: string) {
  const n = w.npcs.find(n => n.id === id)!;
  Object.assign(w.player, { x: n.x, y: n.y });
  playerInteract(w, id, action);
  return ordinaryResponses(n, 'ask', true, w.time, w);
}
function next(w: World, id: string) {
  return getPlayerInteractions(w, id).find(a => a.parameters.topic === 'plan')!;
}

describe('prospective authored plan methods', () => {
  it.each([
    ['mei', 'personal-interest', /茶味|浓淡/, /点心/, /喜欢|留点/],
    ['mei', 'personal-routine', /餐具/, /擦干净茶桌/, /放心/],
    ['tang', 'personal-interest', /一小块/, /明暗/, /观察/],
    ['tang', 'personal-routine', /问问/, /留意/, /每个人/],
  ])('%s %s has distinct status, method and reason stages without execution rewards', (id, goalId, method, detail, reason) => {
    const w = createWorld(), n = w.npcs.find(n => n.id === id)!;
    const before = { personal: structuredClone(n.mind.personal), money: w.player.money, inventory: [...w.player.inventory], hunger: n.needs.hunger, energy: n.needs.energy, job: n.job };
    const summary = open(w, id, 'ask:plans').find(r => r.subject === `goal:${goalId}`)!;
    expect(applyDecision(w, id, summary.id, 'test')).toBe(true);
    const social = n.needs.social, trust = n.trust;
    const stage1 = open(w, id, next(w, id).id)[0];
    expect(stage1.text).toMatch(method); expect(stage1.text).toMatch(detail);
    expect(stage1.depth).toBe(1); expect(stage1.subject).toBe(summary.subject);
    expect(applyDecision(w, id, stage1.id, 'test')).toBe(true);
    const stage2 = open(w, id, next(w, id).id)[0];
    expect(stage2.text).toMatch(reason); expect(stage2.text).not.toBe(stage1.text);
    expect(stage2.depth).toBe(2); expect(stage2.subject).toBe(summary.subject);
    expect(stage2.followUp).toBeUndefined();
    expect(applyDecision(w, id, stage2.id, 'test')).toBe(true);
    expect(n.needs.social).toBe(social); expect(n.trust).toBe(trust);
    expect({ personal: n.mind.personal, money: w.player.money, inventory: w.player.inventory, hunger: n.needs.hunger, energy: n.needs.energy, job: n.job }).toEqual(before);
    expect(stage1.text).not.toMatch(/今天阳光|现在水色|已经试吃|已经画好|你喜欢/);
  });

  it.each(['mei', 'tang'])('requires %s exact goal id, label and activity before using authored content', id => {
    const w = createWorld(), n = w.npcs.find(n => n.id === id)!;
    for (const goalId of ['personal-interest', 'personal-routine']) {
      const original = goalFor(w, id, goalId);
      for (const changed of [{ id: 'imported-goal' }, { label: '整理一份新目录' }, { activity: 'imported-activity' }]) {
        const goal = { ...original, ...changed };
        const text = planNextStepParts(n, goal, w).map(p => p.text).join('') + planReason(n, goal);
        expect(text).not.toMatch(/茶|点心|水边|明暗|街坊|餐具/);
        expect(planReport(n, goal)).toContain(goal.label);
        expect(planNextStepParts(n, goal, w).every(p => !p.basis.startsWith('profile:'))).toBe(true);
      }
    }
  });

  it.each(['mei', 'tang'])('does not describe %s completed goals as unfinished', id => {
    const w = createWorld(), n = w.npcs.find(n => n.id === id)!;
    for (const g of n.mind.personal.goals) {
      for (let i = 0; i < g.target; i++) advanceGoal(n.mind, g.id, { id: `${g.id}-${i}`, at: w.time });
      const goal = goalFor(w, id, g.id);
      expect(planNextStepParts(n, goal, w).map(p => p.text).join('')).toContain('已经');
      expect(planNextStepParts(n, goal, w).map(p => p.text).join('') + planReason(n, goal)).not.toMatch(/还差|先比较|再接着办|先挑/);
    }
  });

  it.each(['mei', 'tang'])('shares exactly the %s method and reason fragments in common provider context', id => {
    const w = createWorld(), n = w.npcs.find(n => n.id === id)!;
    const self = getContext(w, id).self as { authoredPlanDialogue: Array<{ goalId: string; interpretation: string; method: Array<{ text: string; basis: string }>; reason: Array<{ text: string; basis: string }> }> };
    expect(self.authoredPlanDialogue).toHaveLength(2);
    for (const entry of self.authoredPlanDialogue) {
      const goal = goalFor(w, id, entry.goalId);
      expect(entry.interpretation).toMatch(/prospective/);
      expect(entry.method).toEqual(planNextStepParts(n, goal, w));
      expect(entry.reason.map(p => p.text).join('')).toBe(planReason(n, goal));
      expect(entry.method.every(p => p.basis.length > 0)).toBe(true);
      expect(entry.reason.every(p => p.basis.includes('personal-life'))).toBe(true);
    }
  });

  it('keeps hidden and other-owner work out of methods and shared authored context', () => {
    const w = createWorld(), n = w.npcs.find(n => n.id === 'mei')!;
    const goal = goalFor(w, 'mei', 'personal-routine');
    const before = planNextStepParts(n, goal, w);
    const shared = (getContext(w, 'mei').self as Record<string, unknown>).authoredPlanDialogue;
    w.work.tasks.push({ id: 'work-20', ownerId: 'mei', createdAt: 0, cause: '秘密漏水', observed: false, offered: false });
    w.work.tasks.find(t => t.ownerId === 'lin')!.cause = '别人家的秘密';
    expect(planNextStepParts(n, goal, w)).toEqual(before);
    expect((getContext(w, 'mei').self as Record<string, unknown>).authoredPlanDialogue).toEqual(shared);
  });

  it('uses independent goal, observed task, authored instruction and need evidence in final speech', () => {
    const w = createWorld(), n = w.npcs.find(n => n.id === 'mei')!;
    const task = w.work.tasks.find(t => t.ownerId === 'mei')!;
    const summary = open(w, 'mei', 'ask:plans').find(r => r.subject === 'goal:personal-routine')!;
    applyDecision(w, 'mei', summary.id, 'test'); n.needs.hunger = 20;
    const response = open(w, 'mei', next(w, 'mei').id)[0];
    const fragments = planNextStepParts(n, goalFor(w, 'mei', 'personal-routine'), w);
    expect(response.text).toBe(fragments.map(p => p.text).join(''));
    expect(response.evidence.map(e => e.basis)).toEqual(fragments.map(p => p.basis));
    expect(response.evidence.map(e => e.basis)).toEqual(expect.arrayContaining(['goal:personal-routine', `observed-work:${task.id}`, 'needs:hunger<40']));
    expect(response.evidence.some(e => e.basis.endsWith(':prospective-method'))).toBe(true);
  });

  it('keeps status prose about goals, authored intentions and the current job independently evidenced', () => {
    const w = createWorld(), n = w.npcs.find(n => n.id === 'tang')!;
    open(w, 'tang', 'ask:plans');
    n.job = { kind: 'hobby', phase: 'perform', target: { x: n.x, y: n.y }, startedAt: 0, duration: 12 };
    const response = ordinaryResponses(n, 'ask', true, w.time, w).find(r => r.subject === 'goal:personal-interest')!;
    expect(response.text).toContain('这会儿正');
    expect(response.evidence.map(e => e.basis)).toEqual(expect.arrayContaining([
      'goal:personal-interest', 'profile:personal-life:tang:personal-interest:goal-description', 'job:hobby:perform',
    ]));
  });

  it.each(['hobby', 'work'] as const)('reports one completed receipt independently from current %s execution', activity => {
    const w = createWorld(), n = w.npcs.find(n => n.id === 'tang')!;
    advanceGoal(n.mind, 'personal-interest', { id: 'first-sketch', at: w.time });
    open(w, 'tang', 'ask:plans');
    n.job = { kind: activity, phase: 'perform', target: { x: n.x, y: n.y }, startedAt: 0, duration: 12 };
    const response = ordinaryResponses(n, 'ask', true, w.time, w).find(r => r.subject === 'goal:personal-interest')!;
    expect(response.text).toContain('已经做过一回，还差两回');
    expect(response.evidence.map(e => e.basis)).toContain('goal:personal-interest');
    if (activity === 'hobby') {
      expect(response.text).toContain('这会儿正');
      expect(response.evidence.map(e => e.basis)).toContain('job:hobby:perform');
    } else {
      expect(response.text).not.toContain('这会儿正');
      expect(response.evidence.some(e => e.basis.startsWith('job:'))).toBe(false);
    }
  });

  it('does not describe a completed goal as still being performed even during a matching activity', () => {
    const w = createWorld(), n = w.npcs.find(n => n.id === 'tang')!;
    for (let i = 0; i < 3; i++) advanceGoal(n.mind, 'personal-interest', { id: `sketch-${i}`, at: w.time });
    open(w, 'tang', 'ask:plans');
    n.job = { kind: 'hobby', phase: 'perform', target: { x: n.x, y: n.y }, startedAt: 0, duration: 12 };
    const response = ordinaryResponses(n, 'ask', true, w.time, w).find(r => r.subject === 'goal:personal-interest')!;
    expect(response.text).toContain('已经完成');
    expect(response.text).not.toMatch(/这会儿正|还差|没做完/);
    expect(response.evidence.some(e => e.basis.startsWith('job:'))).toBe(false);
  });

  it.each(['player', 'owner', 'available', 'none', 'undefined'] as const)('grounds Mei work method when task is %s', state => {
    const w = createWorld(), n = w.npcs.find(n => n.id === 'mei')!;
    const task = w.work.tasks.find(t => t.ownerId === 'mei')!;
    if (state === 'player' || state === 'owner') task.claimedBy = state;
    if (state === 'owner') n.job = { kind: 'work', taskId: task.id, phase: 'perform', target: { x: n.x, y: n.y }, startedAt: 0, duration: 12 };
    if (state === 'none') w.work.tasks = [];
    const text = planNextStepParts(n, goalFor(w, 'mei', 'personal-routine'), state === 'undefined' ? undefined : w).map(p => p.text).join('');
    if (state === 'player') { expect(text).toContain('留给你'); expect(text).not.toMatch(/我想先做|我正|想先擦/); }
    if (state === 'owner') expect(text).toContain('正在');
    if (state === 'available') { expect(text).toContain(task.cause); expect(text).toContain('擦干净茶桌并收拾餐具'); }
    if (state === 'none' || state === 'undefined') expect(text).toContain('具体的事');
    expect(text).not.toContain('全部办妥');
  });

  it.each(['wrong-task', 'travel', 'no-job'] as const)('does not claim owner execution from an owner claim alone: %s', state => {
    const w = createWorld(), n = w.npcs.find(n => n.id === 'mei')!;
    const task = w.work.tasks.find(t => t.ownerId === 'mei')!; task.claimedBy = 'owner';
    if (state !== 'no-job') n.job = { kind: 'work', taskId: state === 'wrong-task' ? 'work-99' : task.id, phase: state === 'travel' ? 'travel' : 'perform', target: { x: n.x, y: n.y }, startedAt: 0, duration: 12 };
    expect(planNextStepParts(n, goalFor(w, 'mei', 'personal-routine'), w).map(p => p.text).join('')).not.toContain('正在');
  });

  it.each([{ hunger: 20, energy: 20, basis: 'needs:hunger<40' }, { hunger: 50, energy: 20, basis: 'needs:energy<40' }])('keeps one real current need constraint: $basis', needs => {
    const w = createWorld(), n = w.npcs.find(n => n.id === 'tang')!;
    Object.assign(n.needs, needs);
    const parts = planNextStepParts(n, goalFor(w, 'tang'), w);
    expect(parts.filter(p => p.basis.startsWith('needs:')).map(p => p.basis)).toEqual([needs.basis]);
  });
});
