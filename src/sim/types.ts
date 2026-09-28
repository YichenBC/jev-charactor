import type { AffectId, CharacterMind } from '../character';
import type { WorkBoard } from './work';
import type { InteractionChoice } from '../character/interaction';
export type Point = { x: number; y: number };
export type Interaction = 'greet' | 'ask' | 'request' | 'decline' | 'help' | 'gift' | 'promise' | 'expose' | 'apologize' | 'deliver' | 'explain';
export type Memory = { time: number; text: string; kind: string };
export type ActionOption = { id: string; label: string; description: string; kind: string; target?: string };
export type Npc = Point & {
  id: string; name: string; role: string; color: string; persona: string; goal: string;
  secret: string; knownFacts: string[]; memories: Memory[]; trust: number; mood: string;
  activity: string; lastDecision: string; revision: number; cooldown: number;
  path: Point[]; destination?: string; pendingInteraction?: Interaction;
  pendingAction?: InteractionChoice;
  bubble?: string; bubbleUntil?: number;
  mind: CharacterMind;
  needs: { hunger: number; energy: number; social: number; workPressure: number };
  job: { taskId?: string; kind: 'eat' | 'rest' | 'work' | 'social' | 'hobby'; target: Point; placeId?: string; partnerId?: string; phase: 'travel' | 'invite' | 'perform'; consent?: 'pending' | 'accepted'; expiresAt?: number; startedAt: number; duration: number; endsAt?: number } | null;
};
export type WorldEvent = { id: number; time: number; text: string; kind: string; npcId?: string };
export type DecisionRecord = { time: number; npcId: string; choice: string; label: string; source: string; latencyMs?: number; confidence?: number; model?: string; cost?: number; affect?: AffectId; changes?: string[] };
export type DeliveryOrder = {
  id: string; customerId: string; address: Point; status: 'offered' | 'accepted' | 'ready' | 'carrying' | 'delivered' | 'rejected' | 'expired';
  createdAt: number; readyAt: number; deadline: number; expiresAt: number; reward: number;
  pickedUpAt?: number; settledAt?: number; payout?: number; explanation?: boolean;
};
export type PlayerActivity = { taskId?: string; kind: 'rest' | 'sleep' | 'work' | 'help'; label: string; startedAt: number; endsAt: number; npcId?: string; origin: Point };
export type Survival = { orders: DeliveryOrder[]; nextOrder: number; stock: { meals: number; bread: number }; restockedDay: number; delivered: number; failed: number; earned: number; spent: number; jobReadyAt: number; nextOfferAt: number; milestone: boolean; dead: boolean };
export type World = {
  version: 2; time: number; seed: number;
  player: Point & { inventory: string[]; knowledge: string[]; health: number; hunger: number; energy: number; money: number; activity: PlayerActivity | null };
  npcs: Npc[]; events: WorldEvent[]; decisions: DecisionRecord[]; flags: Record<string, boolean>;
  survival: Survival;
  work: WorkBoard;
};
export type Building = { id: string; name: string; subtitle: string; x: number; y: number; w: number; h: number; color: number; door: Point };
export type DecisionMeta = { revision?: number; latencyMs?: number; confidence?: number; model?: string; cost?: number; affect?: AffectId;
  /** Optional player-directed presentation. Text never grants world effects or permissions. */
  dialogueText?: string;
};
