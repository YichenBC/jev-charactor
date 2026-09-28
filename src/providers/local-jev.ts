import type { DecisionFrame, DecisionProvider } from '../character/runtime';

/** Browser-safe transport to the local key-holding server; no credentials enter the core. */
export class LocalJevProvider implements DecisionProvider {
  readonly source = 'jev';
  constructor(private readonly endpoint = '/api/decide', private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}
  async decide(input: DecisionFrame, signal: AbortSignal): Promise<unknown> {
    if (input.characterId.length > 40 || input.options.length < 2 || input.options.length > 40) throw new Error('unsupported_frame');
    const response = await this.fetcher(this.endpoint, {
      method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ npcId: input.characterId, revision: input.revision, state: input.context, options: input.options }),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const code = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'decision_failed';
      throw new Error(code);
    }
    if (!result || typeof result !== 'object' || !('npcId' in result) || result.npcId !== input.characterId || !('revision' in result) || result.revision !== input.revision) throw new Error('invalid_response');
    return result;
  }
}
