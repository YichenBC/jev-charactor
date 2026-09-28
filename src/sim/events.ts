import { rememberExperience } from '../character';
import { notePersonalEvent } from './personalLife';
import type { World, Npc } from './types';
export function event(world: World, text: string, kind: string, npcId?: string) {
  world.events.push({ id: (world.events.at(-1)?.id || 0) + 1, time: world.time, text, kind, ...(npcId ? { npcId } : {}) });
  world.events = world.events.slice(-180);
}
export function remember(world: World, npc: Npc, text: string, kind = 'social', salience = .5) {
  if (!npc.memories.some(m => m.text === text && world.time - m.time < 20)) {
    npc.memories.push({ time: world.time, text, kind }); npc.memories = npc.memories.slice(-32);
    rememberExperience(npc.mind, { id: `${npc.id}:${npc.revision}:${world.time.toFixed(3)}:${kind}`, at: world.time, event: kind, detail: text, salience, source: 'experienced', relatedTo: 'player' });
    notePersonalEvent(npc,kind,`${npc.id}:${npc.revision}:${world.time.toFixed(3)}:${kind}`,world.time);
  }
  npc.revision++;
}
export function say(world: World, npc: Npc, text: string) {
  npc.bubble = text; npc.bubbleUntil = world.time + 9;
  event(world, `${npc.name}：${text}`, 'dialogue', npc.id);
}
