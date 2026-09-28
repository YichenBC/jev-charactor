import { describe, expect, it, vi } from 'vitest';
import { CharacterRuntime, type CharacterDecision, type CharacterEnvironment, type DecisionFrame, type DecisionProvider } from '../src/character/runtime';

const frame = (id = 'archivist'): DecisionFrame => ({ characterId: id, revision: 1, context: { own: { energy: 20 } }, options: [
  { id: 'sleep', label: 'Sleep', description: 'Rest in the cabin.' },
  { id: 'work', label: 'Work', description: 'Finish the report.' },
] });
function setup() {
  let current = true;
  const input = frame(), execute = vi.fn(() => ({ status: 'applied' as const, detail: 'Rested', changes: ['energy +20'] }));
  const environment: CharacterEnvironment = { openTurn: id => ({ input: { ...input, characterId: id }, isCurrent: () => current, execute }) };
  const calls: Array<{ input: DecisionFrame; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const provider: DecisionProvider = { source: 'fixture', decide: (input, signal) => new Promise((resolve, reject) => calls.push({ input, signal, resolve, reject })) };
  const runtime = new CharacterRuntime(environment, provider, { maxConcurrent: 2 });
  const answer = { choice: 'sleep', affect: 'focused', latencyMs: 1 };
  return { input, runtime, calls, answer, execute, stale: () => { current = false; } };
}

describe('portable character runtime', () => {
  it('executes a validated decision once and returns actual environment feedback', async () => {
    const h = setup(), turn = h.runtime.step('archivist');
    h.calls[0].resolve(h.answer);
    expect(await turn).toEqual({ status: 'applied', execution: { status: 'applied', detail: 'Rested', changes: ['energy +20'] } });
    expect(h.execute).toHaveBeenCalledExactlyOnceWith(h.answer, 'fixture');
    expect(h.runtime.pending.size).toBe(0);
  });
  it('isolates provider input from environment data and the candidate validation snapshot', async () => {
    const h = setup(), turn = h.runtime.step('archivist');
    (h.calls[0].input.context.own as { energy: number }).energy = 999;
    h.calls[0].input.options.push({ id: 'invented', label: 'Invented', description: 'Not offered.' });
    h.calls[0].resolve({ ...h.answer, choice: 'invented' });
    await expect(turn).rejects.toThrow('invalid_choice');
    expect(h.input.context).toEqual({ own: { energy: 20 } });
    expect(h.input.options).toHaveLength(2);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it.each([{ affect: undefined }, { affect: 'invented' }, { confidence: 2 }, { latencyMs: -1 }, { cost: Infinity }])('rejects malformed selection metadata %j', async invalid => {
    const h = setup(), turn = h.runtime.step('archivist');
    h.calls[0].resolve({ ...h.answer, ...invalid });
    await expect(turn).rejects.toThrow('invalid_response');
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('rejects duplicate options before contacting a provider', async () => {
    const h = setup(); h.input.options.push(h.input.options[0]);
    await expect(h.runtime.step('archivist')).rejects.toThrow('invalid_frame');
    expect(h.calls).toHaveLength(0);
  });
  it('skips empty or missing turns without a model call', async () => {
    const h = setup(); h.input.options.length = 0;
    expect(await h.runtime.step('archivist')).toEqual({ status: 'skipped' });
    expect(h.calls).toHaveLength(0);
    const missing = new CharacterRuntime({ openTurn: () => null }, { source: 'fixture', decide: vi.fn() });
    expect(await missing.step('absent')).toEqual({ status: 'skipped' });
  });
  it('allows a single candidate with a provider that supports it', async () => {
    const h = setup(); h.input.options.pop();
    const turn = h.runtime.step('archivist'); h.calls[0].resolve(h.answer);
    expect((await turn).status).toBe('applied');
  });
  it('skips duplicate characters and limits concurrency', async () => {
    const h = setup(), first = h.runtime.step('archivist');
    expect(await h.runtime.step('archivist')).toEqual({ status: 'skipped' });
    const second = h.runtime.step('engineer');
    expect(await h.runtime.step('visitor')).toEqual({ status: 'skipped' });
    expect(h.calls).toHaveLength(2);
    h.calls.forEach(call => call.resolve(h.answer)); await Promise.all([first, second]);
    expect(h.execute).toHaveBeenCalledTimes(2);
  });
  it('drops a stale success and a stale provider failure without executing', async () => {
    const h = setup(), first = h.runtime.step('archivist'), second = h.runtime.step('engineer');
    h.stale(); h.calls[0].resolve(h.answer); h.calls[1].reject(new Error('outdated network failure'));
    expect(await first).toEqual({ status: 'stale' });
    expect(await second).toEqual({ status: 'stale' });
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('does not dispatch an already stale snapshot', async () => {
    const h = setup(); h.stale();
    expect(await h.runtime.step('archivist')).toEqual({ status: 'stale' });
    expect(h.calls).toHaveLength(0);
  });
  it('settles cancellation even if the provider ignores abort and preserves a replacement request', async () => {
    const h = setup(), old = h.runtime.step('archivist');
    h.runtime.cancel('archivist');
    expect(h.calls[0].signal.aborted).toBe(true);
    expect(await old).toEqual({ status: 'cancelled' });
    const replacement = h.runtime.step('archivist'), active = h.runtime.pending.get('archivist');
    h.calls[0].resolve(h.answer); await Promise.resolve();
    expect(h.runtime.pending.get('archivist')).toBe(active);
    h.calls[1].resolve(h.answer); await replacement;
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it('propagates a current provider failure without executing or falling back', async () => {
    const h = setup(), turn = h.runtime.step('archivist');
    h.calls[0].reject(new Error('provider_unavailable'));
    await expect(turn).rejects.toThrow('provider_unavailable');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.runtime.pending.size).toBe(0);
  });
  it('returns rejected execution separately from model and transport failure', async () => {
    const runtime = new CharacterRuntime({ openTurn: () => ({ input: frame(), isCurrent: () => true, execute: () => ({ status: 'rejected', detail: 'Resource was reserved by another action.', changes: [] }) }) }, { source: 'fixture', decide: async () => ({ choice: 'sleep', affect: 'focused' } satisfies CharacterDecision) });
    expect(await runtime.step('archivist')).toMatchObject({ status: 'rejected', execution: { changes: [] } });
  });
  it('rejects an environment returning another character and invalid concurrency', async () => {
    const provider = { source: 'fixture', decide: vi.fn() };
    const environment: CharacterEnvironment = { openTurn: () => ({ input: frame('other'), isCurrent: () => true, execute: vi.fn() }) };
    await expect(new CharacterRuntime(environment, provider).step('archivist')).rejects.toThrow('invalid_frame');
    expect(() => new CharacterRuntime(environment, provider, { maxConcurrent: 0 })).toThrow();
    expect(provider.decide).not.toHaveBeenCalled();
  });
});
