import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const time = z.number().finite().nonnegative();
const turnSchema = z.object({
  sequence: z.number().int().positive().max(1e9), at: time,
  counterparty: text(160), topic: text(160), text: text(1600),
  followUp: text(200).optional(), subject: text(200).optional(),
  speaker: z.enum(['self','other']).default('self'),
  depth: z.number().int().min(0).max(16).default(0),
  inReplyTo: z.number().int().positive().optional(),
}).strict().refine(t=>t.inReplyTo===undefined||t.inReplyTo<t.sequence,'Reply must reference an earlier turn');
export const dialogueSchema = z.object({
  nextSequence: z.number().int().positive().max(1e9),
  turns: z.array(turnSchema).max(24), rewardedAt: time.optional(),
}).strict().refine(d => d.turns.every((t,i) => t.sequence < d.nextSequence && (!i || (t.sequence > d.turns[i-1].sequence && t.at >= d.turns[i-1].at))), 'Invalid dialogue order')
  .refine(d=>d.turns.every(t=>{const parent=d.turns.find(p=>p.sequence===t.inReplyTo);return !parent||parent.counterparty===t.counterparty;}),'Reply counterparty mismatch');
export type DialogueState = z.infer<typeof dialogueSchema>;
export type DialogueTurn = z.infer<typeof turnSchema>;
export type DialogueOwner = { dialogue: DialogueState; revision: number };
export function createDialogue(): DialogueState { return { nextSequence: 1, turns: [] }; }

/** The host decides what is safe to say. This ledger only tracks what was actually said. */
export function recentlySaid(owner: DialogueOwner, counterparty: string, value: string, now: number, window = 120): boolean {
  return owner.dialogue.turns.some(t => t.speaker !== 'other' && t.counterparty === counterparty && t.text === value && t.at <= now && now-t.at < window);
}
/** Latest unresolved, actually spoken subjects. Never discovers hidden topics.
 * At most four recent topics; callers must revalidate their underlying evidence.
 */
export function openDialogueTopics(owner:DialogueOwner,counterparty:string,now:number):DialogueTurn[] {
  time.parse(now);
  const turns=owner.dialogue.turns.filter(t=>t.counterparty===counterparty&&t.at<=now);
  const answered=new Set(turns.map(t=>t.inReplyTo).filter(t=>t!==undefined));
  const seen=new Set<string>(),result:DialogueTurn[]=[];
  for(const turn of [...turns].reverse()) {
    if(turn.speaker==='other')continue;
    const key=JSON.stringify([turn.topic,turn.subject??null]);
    if(seen.has(key))continue;seen.add(key);
    if(turn.followUp&&turn.depth<16&&!answered.has(turn.sequence)&&now-turn.at<120)result.push(structuredClone(turn));
    if(result.length===4)break;
  }
  return result;
}
/** Character-wide cooldown cannot be bypassed by changing topics or reopening a UI. */
export function canRewardDialogue(owner: DialogueOwner, now: number): boolean {
  return owner.dialogue.rewardedAt === undefined || now-owner.dialogue.rewardedAt >= 120;
}
export function recordDialogue(owner: DialogueOwner, input: Omit<z.input<typeof turnSchema>,'sequence'>, rewardEligible = false): boolean {
  const state = dialogueSchema.parse(owner.dialogue);
  if (state.nextSequence >= 1e9) throw new RangeError('Dialogue sequence exhausted');
  const turn = turnSchema.parse({ ...input, sequence: state.nextSequence });
  const parent=state.turns.find(t=>t.sequence===turn.inReplyTo);
  if(parent&&parent.counterparty!==turn.counterparty)throw new RangeError('Reply counterparty mismatch');
  if (turn.at < (state.turns.at(-1)?.at ?? 0) || turn.at < (state.rewardedAt ?? 0)) throw new RangeError('Dialogue time moved backwards');
  const reward = turn.speaker==='self' && rewardEligible && canRewardDialogue(owner,turn.at) && !recentlySaid(owner,turn.counterparty,turn.text,turn.at);
  owner.dialogue = { nextSequence:state.nextSequence+1, turns:[...state.turns,turn].slice(-24),
    ...(reward ? {rewardedAt:turn.at} : state.rewardedAt !== undefined ? {rewardedAt:state.rewardedAt} : {}) };
  owner.revision++;
  return reward;
}

type DialogueInput=Omit<z.input<typeof turnSchema>,'sequence'|'speaker'>;
/** Validate both voices on detached state before committing either. No world effects. */
export function recordDialogueExchange(owner:DialogueOwner,question:DialogueInput,response:Omit<DialogueInput,'inReplyTo'>,rewardEligible=false):boolean {
  if(question.counterparty!==response.counterparty)throw new RangeError('Exchange counterparty mismatch');
  const draft={dialogue:owner.dialogue,revision:owner.revision};
  const questionSequence=draft.dialogue.nextSequence;
  recordDialogue(draft,{...question,speaker:'other'});
  const reward=recordDialogue(draft,{...response,speaker:'self',inReplyTo:questionSequence},rewardEligible);
  owner.dialogue=draft.dialogue;owner.revision=draft.revision;
  return reward;
}
