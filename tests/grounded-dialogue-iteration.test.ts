import { describe, expect, it } from 'vitest';
import { applyDecision, createWorld, playerInteract, type World } from '../src/sim';
import { ordinaryResponses } from '../src/sim/dialogue';
import { getPlayerInteractions } from '../src/sim/interactions';
import { notePersonalEvent } from '../src/sim/personalLife';

function open(w: World, action: string, id = 'mei') {
  const n = w.npcs.find(n => n.id === id)!;
  Object.assign(w.player, { x: n.x, y: n.y });
  playerInteract(w, id, action);
  return ordinaryResponses(n, action === 'greet' ? 'greet' : 'ask', action !== 'greet', w.time, w);
}
function say(w: World, action: string, choice: string, id = 'mei') {
  open(w, action, id);
  expect(applyDecision(w, id, choice, 'test')).toBe(true);
}
function follow(w: World, topic: string, id = 'mei') {
  return getPlayerInteractions(w, id).find(a => a.parameters.topic === topic)!;
}

describe('grounded dialogue iteration', () => {
  it.each(['lin', 'tang', 'mei', 'lan', 'zhou'])('keeps %s introductions and state reports free of unrelated closings', id => {
    const w = createWorld(), n = w.npcs.find(n => n.id === id)!;
    expect(open(w, 'greet', id)[0].text).toBe(`你好，我是${n.name}，${n.role}。`);
    const state = open(w, 'ask', id).find(r => r.topic === 'state')!;
    expect(state.text).not.toMatch(/谢谢你惦记|你呢？|你也记得照顾自己|谢谢你关心|咱们慢慢聊/);
  });

  it.each([
    { hunger: 20, energy: 20, text: ['饿', '累'], evidence: ['needs:hunger<40', 'needs:energy<40'] },
    { hunger: 40, energy: 39, text: ['累'], evidence: ['needs:energy<40'] },
    { hunger: 39, energy: 40, text: ['饿'], evidence: ['needs:hunger<40'] },
    { hunger: 40, energy: 40, text: ['身体'], evidence: ['needs:hunger>=40,energy>=40'] },
  ])('answers an empty feeling question with current physical facts: $hunger/$energy', ({ hunger, energy, text, evidence }) => {
    const w = createWorld(), n = w.npcs[2];
    Object.assign(n.needs, { hunger, energy });
    const before = structuredClone(n.mind.personal);
    const [response] = open(w, 'ask:feelings');
    expect(response.text).toContain('说不上有什么特别的心情');
    for (const fragment of text) expect(response.text).toContain(fragment);
    expect(response.evidence.map(e => e.basis)).toEqual(expect.arrayContaining(evidence));
    expect(response.evidence.some(e => e.basis.startsWith('feeling:'))).toBe(false);
    expect(response.rewardEligible).toBe(false);
    const social = n.needs.social;
    say(w, 'ask:feelings', 'reply');
    expect(n.needs.social).toBe(social);
    expect(n.mind.personal).toEqual(before);
    expect(open(w, 'ask:feelings')[0].text).toBe(response.text);
  });

  it('does not describe an expired feeling as currently felt', () => {
    const w = createWorld(), n = w.npcs[2];
    notePersonalEvent(n, 'gift', 'past', 0);
    w.time = 120; n.needs.energy = 20;
    const [response] = open(w, 'ask:feelings');
    expect(response.text).toContain('累');
    expect(response.text).not.toContain('心意');
    expect(response.evidence.some(e => e.basis.startsWith('feeling:'))).toBe(false);
  });

  it('acknowledges a repeated valid feeling and retains its existing followup depth and subject', () => {
    const w = createWorld(), n = w.npcs[2];
    notePersonalEvent(n, 'gift', 'gift', 0);
    say(w, 'ask:feelings', 'reply:feeling');
    say(w, follow(w, 'feeling').id, 'reply:detail');
    const oldFollow = follow(w, 'feeling');
    const [response] = open(w, 'ask:feelings');
    expect(response.text).toContain('刚才');
    expect(response.text).not.toContain('说不上');
    expect(response.rewardEligible).toBe(false);
    expect(response.subject).toBe('feeling:gift');
    expect(response.depth).toBe(1);
    expect(response.followUp).toBe(oldFollow.label);
    const before = { social: n.needs.social, personal: structuredClone(n.mind.personal) };
    say(w, 'ask:feelings', 'reply');
    expect(follow(w, 'feeling').label).toBe(oldFollow.label);
    expect(n.needs.social).toBe(before.social);
    expect(n.mind.personal).toEqual(before.personal);
    say(w, follow(w, 'feeling').id, 'reply:detail');
    say(w, 'ask:feelings', 'reply');
    expect(follow(w, 'feeling')).toBeUndefined();
  });

  it('reports an older unspoken valid feeling after the newest one has been discussed', () => {
    const w = createWorld(), n = w.npcs[2];
    notePersonalEvent(n, 'gift', 'gift', 0);
    notePersonalEvent(n, 'apology', 'apology', 0);
    say(w, 'ask:feelings', 'reply:feeling');
    const [response] = open(w, 'ask:feelings');
    expect(response.subject).toBe('feeling:gift');
    expect(response.text).toContain('心意');
  });

  it('resumes the most recent unresolved feeling even when a newer feeling was reported first', () => {
    const w = createWorld(), n = w.npcs[2];
    notePersonalEvent(n, 'gift', 'gift', 0);
    notePersonalEvent(n, 'apology', 'apology', 0);
    say(w, 'ask:feelings', 'reply:feeling');
    say(w, 'ask:feelings', 'reply:feeling');
    say(w, follow(w, 'feeling').id, 'reply:detail');
    const continuation = follow(w, 'feeling');
    const [response] = open(w, 'ask:feelings');
    expect(response.subject).toBe('feeling:gift');
    expect(response.depth).toBe(1);
    expect(response.followUp).toBe(continuation.label);
    say(w, 'ask:feelings', 'reply');
    expect(follow(w, 'feeling').label).toBe(continuation.label);
  });

  it('does not infer unchanged goal progress merely from a repeated report', () => {
    const w = createWorld();
    say(w, 'ask:plans', 'reply:goal');
    say(w, 'ask:plans', 'reply:goal:personal-interest');
    expect(open(w, 'ask:plans')[0].text).not.toContain('没有新的进展');
  });

  it('distinguishes absent goals from goals that were already discussed', () => {
    const w = createWorld(), n = w.npcs[2];
    say(w, 'ask:plans', 'reply:goal');
    say(w, 'ask:plans', 'reply:goal:personal-interest');
    const [repeated] = open(w, 'ask:plans');
    expect(repeated.text).toContain('刚才');
    expect(repeated.text).not.toContain('没什么新的打算');
    expect(repeated.rewardEligible).toBe(false);
    expect(repeated.subject).toMatch(/^goal:/);
    expect(repeated.followUp).toBeDefined();
    n.mind.personal.goals = [];
    const [absent] = open(w, 'ask:plans');
    expect(absent.text).not.toBe(repeated.text);
    expect(absent.followUp).toBeUndefined();
    expect(absent.rewardEligible).toBe(false);
  });

  it('compiles goal progress, authored activity and current needs into followup evidence', () => {
    const w = createWorld(), n = w.npcs[2];
    say(w, 'ask:plans', 'reply:goal');
    n.needs.hunger = 20;
    const [detail] = open(w, follow(w, 'plan').id);
    expect(detail.text).toContain('饿');
    expect(detail.subject).toBe('goal:personal-routine');
    expect(detail.evidence.map(e => e.basis)).toEqual(expect.arrayContaining([
      'goal:personal-routine', 'profile:personal-life:mei:personal-routine:prospective-method', 'needs:hunger<40',
    ]));
    expect(new Set(detail.evidence.map(e => e.id)).size).toBe(detail.evidence.length);
  });

  it('compiles feeling coping intentions and physical needs from their own sources', () => {
    const w = createWorld(), n = w.npcs[2];
    notePersonalEvent(n, 'gift', 'gift', 0);
    say(w, 'ask:feelings', 'reply:feeling');
    say(w, follow(w, 'feeling').id, 'reply:detail');
    n.needs.energy = 20;
    const [detail] = open(w, follow(w, 'feeling').id);
    expect(detail.text).toContain('累');
    expect(detail.subject).toBe('feeling:gift');
    expect(detail.evidence.map(e => e.basis)).toEqual(expect.arrayContaining([
      'feeling:gift', 'profile:personal-life:mei:hobby', 'needs:energy<40',
    ]));
  });

  it('includes current fatigue evidence when elaborating on the teahouse', () => {
    const w = createWorld(), n = w.npcs[2];
    say(w, 'ask', 'reply:place');
    n.needs.energy = 20;
    const [detail] = open(w, follow(w, 'place').id);
    expect(detail.text).toContain('累');
    expect(detail.evidence.map(e => e.basis)).toEqual(expect.arrayContaining([
      'belief:place:tavern:current', 'needs:energy<40',
    ]));
  });
});
