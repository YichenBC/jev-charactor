import { z } from 'zod';
import type { AffectId } from './index.js';

export type ChoiceOption = { id: string; label: string; description: string };
/** Only information this character is allowed to know belongs in context. */
export type DecisionFrame = {
  characterId: string; revision: number;
  context: Record<string, unknown>; options: ChoiceOption[];
};
export type CharacterDecision = {
  choice: string; affect: AffectId;
  confidence?: number; latencyMs?: number; model?: string; cost?: number;
};
/** Applied means the attempt executed, not necessarily that its goal succeeded. */
export type ExecutionResult = { status: 'applied' | 'rejected'; detail: string; changes: string[] };
export interface CharacterTurn {
  input: DecisionFrame;
  /** Include world identity, relevant revisions and external pause/eligibility conditions. */
  isCurrent(): boolean;
  /** Atomic, synchronous, no successful effects on rejection. Never throw after committing. */
  execute(decision: CharacterDecision, source: string): ExecutionResult;
}
export interface CharacterEnvironment { openTurn(characterId: string): CharacterTurn | null }
export interface DecisionProvider {
  readonly source: string;
  /** Provider owns timeout/transport; runtime never silently falls back to another policy. */
  decide(input: DecisionFrame, signal: AbortSignal): Promise<unknown>;
}
export type TurnResult =
  | { status: 'applied' | 'rejected'; execution: ExecutionResult }
  | { status: 'skipped' | 'stale' | 'cancelled' };

const choiceId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/);
const frameSchema = z.object({
  characterId: z.string().trim().min(1).max(160), revision: z.number().int().nonnegative().safe(),
  context: z.record(z.string(), z.unknown()),
  options: z.array(z.object({ id: choiceId, label: z.string().max(160), description: z.string().min(1).max(2000) })).max(256),
}).refine(frame => new Set(frame.options.map(option => option.id)).size === frame.options.length);
const decisionSchema = z.object({
  choice: choiceId, affect: z.enum(['warm', 'guarded', 'focused', 'worried', 'irritated']),
  confidence: z.number().finite().min(0).max(1).optional(),
  latencyMs: z.number().finite().nonnegative().optional(), model: z.string().max(240).optional(),
  cost: z.number().finite().nonnegative().optional(),
});

/** Portable orchestration. Scheduling frequency and simulation time belong to the host. */
export class CharacterRuntime {
  private readonly active = new Map<string, AbortController>();
  private readonly maxConcurrent: number;
  constructor(private readonly environment: CharacterEnvironment, private readonly provider: DecisionProvider, options: { maxConcurrent?: number } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 2;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1) throw new RangeError('invalid_concurrency');
    if (!provider.source.trim()) throw new RangeError('invalid_source');
  }
  get pending(): ReadonlyMap<string, AbortController> { return this.active; }
  cancel(characterId?: string): void {
    for (const [id, controller] of this.active) {
      if (characterId !== undefined && id !== characterId) continue;
      this.active.delete(id);
      controller.abort();
    }
  }
  async step(characterId: string): Promise<TurnResult> {
    if (this.active.has(characterId) || this.active.size >= this.maxConcurrent) return { status: 'skipped' };
    const turn = this.environment.openTurn(characterId);
    if (!turn) return { status: 'skipped' };
    const parsed = frameSchema.safeParse(turn.input);
    if (!parsed.success || parsed.data.characterId !== characterId) throw new Error('invalid_frame');
    // Keep the validation snapshot separate even from a provider that mutates its input.
    const frame = structuredClone(parsed.data);
    if (!frame.options.length) return { status: 'skipped' };
    if (!turn.isCurrent()) return { status: 'stale' };
    const controller = new AbortController(), source = this.provider.source;
    this.active.set(characterId, controller);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('cancelled'));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const raw = await Promise.race([this.provider.decide(structuredClone(frame), controller.signal), cancelled]);
      if (controller.signal.aborted) return { status: 'cancelled' };
      if (!turn.isCurrent()) return { status: 'stale' };
      const result = decisionSchema.safeParse(raw);
      if (!result.success) throw new Error('invalid_response');
      if (!frame.options.some(option => option.id === result.data.choice)) throw new Error('invalid_choice');
      const execution = turn.execute(result.data, source);
      return { status: execution.status, execution };
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled' };
      if (!turn.isCurrent()) return { status: 'stale' };
      throw error;
    } finally {
      controller.signal.removeEventListener('abort', abort);
      if (this.active.get(characterId) === controller) this.active.delete(characterId);
    }
  }
}
