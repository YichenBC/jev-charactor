/** Fog Harbor's bounded, event-created work backlog. No model or UI dependencies. */
import { z } from 'zod';
import { BUILDINGS } from './data';
import { distance } from './navigation';
import type { Npc, World } from './types';

export const CHORES: Record<string, string> = {
  lin: '整理货架上的日用品', tang: '收拾散落的画具', mei: '擦干净茶桌并收拾餐具',
  lan: '分拣驿站的信件和包裹', zhou: '清扫亭边的杂物',
};
export const INITIAL_WORK: Record<string, string> = {
  lin: '货架上的商品还没有理齐', tang: '画具散在桌边，需要收拾', mei: '茶桌上还有待收拾的餐具',
  lan: '驿站里还有一批没分拣的信件', zhou: '亭边还有没清理的杂物',
};
export const CHORE_SECONDS = 12;
export const CHORE_REWARD = 8;
export const RETURN_SECONDS = 90;
export const isHelpPromise = (id: string) => id === 'help-player' || id.startsWith('help-player:');
export const WORKPLACES: Record<string, string> = { lin: 'shop', tang: 'watch', mei: 'tavern', lan: 'post', zhou: 'watch' };
export const taskIdSchema = z.string().regex(/^work-[1-9]\d*$/);
export const workSchema = z.object({
  nextId: z.number().int().min(1).max(1e9),
  tasks: z.array(z.object({
    id: taskIdSchema, ownerId: z.enum(['lin','tang','mei','lan','zhou']),
    createdAt: z.number().finite().nonnegative(), cause: z.string().min(1).max(300),
    observed: z.boolean(), offered: z.boolean(), promiseId: z.string().min(1).max(160).optional(), claimedBy: z.enum(['owner','player']).optional(),
  }).strict()).max(40),
}).strict();
export type WorkBoard = z.infer<typeof workSchema>;
export type WorkTask = WorkBoard['tasks'][number];
export function createWork(): WorkBoard { return { nextId: 1, tasks: [] }; }
const touch = (npc: Npc) => { npc.revision++; };
export function ownedWork(world: World, npc: Npc): WorkTask[] {
  return world.work.tasks.filter(task => task.ownerId === npc.id && task.observed);
}
export function availableWork(world: World, npc: Npc): WorkTask | undefined {
  return ownedWork(world, npc).find(task => !task.claimedBy);
}
export function offeredWork(world: World, npc: Npc): WorkTask | undefined {
  return ownedWork(world, npc).find(task => task.claimedBy === 'player')
    ?? ownedWork(world, npc).find(task => task.offered && !task.claimedBy);
}
export function currentWork(world: World, npc: Npc): WorkTask | undefined {
  return offeredWork(world, npc) ?? availableWork(world, npc);
}
export function addWork(world: World, ownerId: string, cause: string, initiallyKnown = false): WorkTask | undefined {
  const owner = world.npcs.find(n => n.id === ownerId);
  if (!owner || world.work.tasks.filter(t => t.ownerId === ownerId).length >= 8 || world.work.nextId >= 1e9) return undefined;
  const place = BUILDINGS.find(b => b.id === WORKPLACES[owner.id])!;
  const observed = initiallyKnown || distance(owner, place.door) <= 120;
  const task: WorkTask = { id: `work-${world.work.nextId++}`, ownerId: owner.id as WorkTask['ownerId'], createdAt: world.time, cause, observed, offered: false };
  world.work.tasks.push(task);
  if (observed) touch(owner);
  return task;
}
export function observeWork(world: World, npc: Npc): void {
  const place = BUILDINGS.find(b => b.id === WORKPLACES[npc.id])!;
  if (distance(npc, place.door) > 120) return;
  for (const task of world.work.tasks) if (task.ownerId === npc.id && !task.observed) { task.observed = true; touch(npc); }
}
export function offerWork(world: World, npc: Npc): WorkTask | undefined {
  const task = currentWork(world, npc);
  if (task) { task.offered = true; world.flags[`chore_offered_${npc.id}`] = true; touch(npc); }
  return task;
}
export function capturedWork(world: World, npc: Npc): WorkTask | undefined {
  const id = npc.pendingAction?.parameters.taskId;
  return ownedWork(world, npc).find(t => t.id === id && t.offered && t.claimedBy !== 'owner');
}
export function claimWork(world: World, npc: Npc, taskId: string, actor: 'player' | 'owner'): boolean {
  const task = ownedWork(world, npc).find(t => t.id === taskId);
  if (!task || (task.claimedBy && task.claimedBy !== actor)) return false;
  task.claimedBy = actor; touch(npc); return true;
}
export function releaseWork(world: World, npc: Npc, taskId: string | undefined, actor: 'player' | 'owner'): void {
  const task = ownedWork(world, npc).find(t => t.id === taskId && t.claimedBy === actor);
  if (task) { delete task.claimedBy; delete task.promiseId; touch(npc); }
}
export function completeWork(world: World, npc: Npc, taskId: string | undefined, actor: 'player' | 'owner'): boolean {
  const index = world.work.tasks.findIndex(t => t.ownerId === npc.id && t.id === taskId && t.claimedBy === actor);
  if (index < 0) return false;
  world.work.tasks.splice(index, 1); world.flags[`chore_offered_${npc.id}`] = false; touch(npc); return true;
}
export function releasePlayerActivity(world: World): void {
  const activity = world.player.activity;
  if (activity?.kind !== 'help') return;
  const npc = world.npcs.find(n => n.id === activity.npcId);
  if (npc && !npc.mind.commitments.some(c => isHelpPromise(c.id) && c.status === 'active')) releaseWork(world, npc, activity.taskId, 'player');
}
