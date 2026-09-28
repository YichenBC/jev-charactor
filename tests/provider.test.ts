import { describe, it, expect } from 'vitest';
import { decide, decisionInput } from '../server/jev';

const input = { npcId: 'lin', revision: 2, state: { persona: 'protective' }, options: [
  { id: 'wait', label: '等待', description: 'Wait here' },
  { id: 'walk', label: '散步', description: 'Walk to the plaza' },
] };
describe('Jev Decisions boundary', () => {
  it('uses typed choice with a fixed endpoint and returns only validated metadata', async () => {
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
      const body = JSON.parse(init!.body as string);
      expect(body.questions.action.criteria).toEqual({ wait: 'Wait here', walk: 'Walk to the plaza' });
      expect(body.state).toEqual(input.state);
      expect(Object.keys(body.questions.reaction.criteria)).toHaveLength(5);
      return Response.json({ model: 'typesafe/jev-1.13-20260917', answers: { reaction: { type: 'choice', choice: 'focused' }, action: { type: 'choice', choice: 'walk', confidence: .8 } }, usage: { cost: .0001 } });
    };
    expect(await decide(input, 'test-key', fake as typeof fetch)).toMatchObject({ choice: 'walk', confidence: .8, cost: .0001, revision: 2, affect: 'focused' });
  });
  it('rejects provider answers outside legal candidates', async () => {
    await expect(decide(input, 'key', (async () => Response.json({ answers: { reaction: { type: 'choice', choice: 'focused' }, action: { choice: 'invented', type: 'choice' } } })) as typeof fetch)).rejects.toThrow('invalid_choice');
  });
  it.each([undefined, 'invented', ''])('rejects a missing or invalid reaction instead of inventing a fallback (%s)', async reaction => {
    const fake = async () => Response.json({ answers: {
      action: { choice: 'wait', type: 'choice' },
      ...(reaction === undefined ? {} : { reaction: { choice: reaction, type: 'choice' } }),
    } });
    await expect(decide(input, 'test-key', fake as typeof fetch)).rejects.toThrow('invalid_response');
  });
  it('fails explicitly without a key and never replaces Jev with rules', async () => {
    await expect(decide(input, '')).rejects.toThrow('missing_key');
  });
  it('does not expose upstream error contents', async () => {
    await expect(decide(input, 'secret', (async () => new Response('secret provider error', { status: 401 })) as typeof fetch)).rejects.toThrow('upstream_401');
  });
  it('propagates local cancellation to the upstream fetch', async () => {
    const controller = new AbortController();
    const fake = (async (_url: unknown, init?: RequestInit) => {
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        controller.abort();
      });
    }) as typeof fetch;
    await expect(decide(input, 'key', fake, controller.signal)).rejects.toThrow('connection_timeout');
  });
  it('rejects oversized, duplicate and unsafe candidate ids', () => {
    expect(decisionInput.safeParse({ ...input, options: [input.options[0], input.options[0]] }).success).toBe(false);
    expect(decisionInput.safeParse({ ...input, options: [{ ...input.options[0], id: '__proto__' }, input.options[1]] }).success).toBe(false);
    expect(decisionInput.safeParse({ ...input, revision: -1 }).success).toBe(false);
  });
});

describe('Jev evaluation transport evidence',()=>{
  it('retains returned model absence and known billing for an invalid choice',async()=>{
    const {requestJevDecision}=await import('../server/jev');
    const raw={answers:{action:{type:'choice',choice:'invented'},reaction:{type:'choice',choice:'focused'}},usage:{cost:.003}};
    const result=await requestJevDecision(input,'test-key',(async()=>Response.json(raw)) as typeof fetch);
    expect(result.raw).toEqual(raw);expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
