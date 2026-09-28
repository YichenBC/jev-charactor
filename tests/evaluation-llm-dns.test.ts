import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({resolve4: vi.fn(), setServers: vi.fn(), cancel: vi.fn(), request: vi.fn()}));
vi.mock('node:dns/promises', () => ({Resolver: vi.fn(function () {
  return {resolve4: mocks.resolve4, setServers: mocks.setServers, cancel: mocks.cancel};
})}));
vi.mock('node:https', () => ({request: mocks.request}));
import {llmProvider} from '../scripts/evaluation/llm';
import {llmCharacterProvider} from '../scripts/evaluation/llm-character';
import {prepareDevelopmentCase} from '../scripts/evaluation/cases';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('EVAL_LLM_BACKEND', 'openrouter');
  vi.stubEnv('EVAL_LLM_MODEL', 'test/model');
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  vi.stubEnv('JEV_DNS_SERVER', '192.0.2.53');
  vi.stubEnv('EVAL_LLM_TIMEOUT_MS', '');
  vi.stubEnv('EVAL_LLM_THINKING', '');
  vi.stubEnv('EVAL_LLM_MAX_OUTPUT_TOKENS', '');
  mocks.resolve4.mockResolvedValue(['192.0.2.1']);
});
afterEach(() => {vi.unstubAllEnvs(); vi.restoreAllMocks();});

function mockHttpResponse(statusCode: number, content: string) {
  mocks.request.mockImplementation((_url, _options, callback) => Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    end: vi.fn(() => {
      const response = Object.assign(new PassThrough(), {
        statusCode, statusMessage: statusCode === 200 ? 'OK' : 'Found',
        rawHeaders: statusCode === 200 ? ['Content-Type', 'application/json'] : ['Location', 'https://elsewhere.example/'],
      });
      callback(response);
      response.end(content);
    }),
  }));
}

describe.each([['selector', llmProvider], ['full character', llmCharacterProvider]] as const)('%s real DNS wrapper', (_name, factory) => {
  it('passes requests through the real wrapper with its supported redirect policy', async () => {
    const input = prepareDevelopmentCase('mei/plan').scenario.input;
    mockHttpResponse(200, JSON.stringify({model: 'test/returned', usage: {cost: .001}, choices: [{
      finish_reason: 'stop', message: {content: JSON.stringify({action: input.options[0].id, reaction: 'focused',
        ...(factory === llmCharacterProvider ? {dialogue: '我先安排一下。'} : {}),
      })},
    }]}));
    const provider = factory();
    await expect(provider.decide(input)).resolves.toMatchObject({contractValid: true, cost: .001});
    expect(provider.runtimeSettings?.requestTimeoutMs).toBe(12000);
    expect(mocks.setServers).toHaveBeenCalledWith(['192.0.2.53']);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('surfaces a redirect without forwarding the API key or making a second request', async () => {
    mockHttpResponse(302, 'redirect response');
    await expect(factory().decide(prepareDevelopmentCase('mei/plan').scenario.input)).rejects.toThrow(/^upstream_302$/);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0].hostname).toBe('openrouter.ai');
  });

  it.each(['12001', '120000'])('rejects timeout %s exceeding the real DNS wrapper deadline', timeout => {
    vi.stubEnv('EVAL_LLM_TIMEOUT_MS', timeout);
    expect(() => factory()).toThrow(/^unsupported_evaluation_dns_timeout$/);
    expect(mocks.resolve4).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
