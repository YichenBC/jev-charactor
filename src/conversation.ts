import { distance, endPlayerInteraction, type World } from './sim';

/** Transient conversation focus; it is deliberately not part of the saved world. */
export class ConversationSession {
  private focusedNpcId: string | null = null;
  get npcId(): string | null { return this.focusedNpcId; }
  open(world: World, id: string): boolean {
    const npc = world.npcs.find(n => n.id === id);
    if (!npc || world.survival.dead || world.player.activity || distance(world.player, npc) > 110) return false;
    if (this.focusedNpcId === id) return true;
    this.close(world);
    this.focusedNpcId = id;
    return true;
  }
  close(world: World): void {
    if (this.focusedNpcId !== null) endPlayerInteraction(world, this.focusedNpcId);
    this.focusedNpcId = null;
  }
}
