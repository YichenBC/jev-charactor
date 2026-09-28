import { describe, expect, it } from 'vitest';
import { applyDecision, createWorld, getContext, getPlayerInteractions, loadWorld, playerInteract, serializeWorld } from '../src/sim';

function interaction(action = 'greet') {
  const world = createWorld();
  const npc = world.npcs.find(n => n.id === 'mei')!;
  Object.assign(world.player, { x: npc.x, y: npc.y });
  playerInteract(world, npc.id, action);
  expect(npc.pendingAction?.id).toBe(action);
  return { world, npc };
}

describe('generated dialogue presentation', () => {
  it('never exposes an unspoken authored goal through a generated reply follow-up label', () => {
    const { world, npc } = interaction('ask:plans');
    const dialogueText = '我今天不想谈计划。';
    expect(applyDecision(world, npc.id, 'reply:goal', 'llm-character', { dialogueText })).toBe(true);
    const follow = getPlayerInteractions(world, npc.id).find(a => a.id.startsWith('followup:'))!;
    expect(follow).toBeDefined();
    expect(follow.label).not.toContain('茶馆事务');
    expect(follow.description).toContain(dialogueText);
    expect(follow.label).toBe('你刚才说的，能再具体说说吗？');
  });
  it('records exactly the spoken reply in the bubble, both histories and saved state', () => {
    const { world, npc } = interaction();
    const dialogueText = '  我是梅姐。今天先顾好茶馆，空下来再与你慢慢聊。  ';
    expect(applyDecision(world, npc.id, 'reply', 'llm-character', { dialogueText })).toBe(true);
    expect(npc.bubble).toBe(dialogueText);
    expect(npc.mind.dialogue.turns.at(-1)?.text).toBe(dialogueText.trim());
    expect(npc.memories.at(-1)?.text).toBe(dialogueText);
    expect(npc.mind.experiences.at(-1)?.detail).toBe(dialogueText);
    expect(JSON.stringify(getContext(world, npc.id))).toContain(dialogueText.trim());
    expect(loadWorld(serializeWorld(world))?.npcs.find(n => n.id === npc.id)?.bubble).toBe(dialogueText);
  });

  it('executes the selected gift transaction but never applies effects claimed only in text', () => {
    const { world, npc } = interaction('gift:热茶');
    const money = world.player.money;
    expect(applyDecision(world, npc.id, 'accept_gift', 'llm-character', {
      dialogueText: '谢谢你的茶。我已经付给你一百元了。',
    })).toBe(true);
    expect(world.player.inventory).not.toContain('热茶');
    expect(world.player.money).toBe(money);
    expect(npc.bubble).toContain('一百元');
    expect(npc.mind.dialogue.turns.at(-1)?.text).toContain('一百元');
  });

  it.each(['', '   ', 'x'.repeat(1601)])('rejects malformed speech before consuming a gift', dialogueText => {
    const { world, npc } = interaction('gift:热茶');
    const before = serializeWorld(world);
    expect(applyDecision(world, npc.id, 'accept_gift', 'llm-character', { dialogueText })).toBe(false);
    expect(serializeWorld(world)).toBe(before);
  });

  it('does not allow unattached dialogue on an autonomous decision', () => {
    const world = createWorld(), before = serializeWorld(world);
    expect(applyDecision(world, 'mei', 'wait', 'llm-character', { dialogueText: 'Hello' })).toBe(false);
    expect(serializeWorld(world)).toBe(before);
  });

  it('retains revision and action rejection before speech is committed', () => {
    const { world, npc } = interaction();
    const before = serializeWorld(world);
    expect(applyDecision(world, npc.id, 'reply', 'test', { revision: npc.revision - 1, dialogueText: 'Hello' })).toBe(false);
    expect(applyDecision(world, npc.id, 'invented-action', 'test', { dialogueText: 'Hello' })).toBe(false);
    expect(serializeWorld(world)).toBe(before);
  });
});
