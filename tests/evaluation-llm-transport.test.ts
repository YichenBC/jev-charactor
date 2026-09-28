import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {llmProvider} from '../scripts/evaluation/llm';
import {llmCharacterProvider} from '../scripts/evaluation/llm-character';
import {prepareDevelopmentCase} from '../scripts/evaluation/cases';

const input = () => prepareDevelopmentCase('mei/plan').scenario.input;
const providers = [
  ['selector', llmProvider, 200, false],
  ['full character', llmCharacterProvider, 600, true],
] as const;
function envelope(generated: boolean, overrides: Record<string, unknown> = {}) {
  return {model: 'kimi-k3', usage: {prompt_tokens: 40, completion_tokens: 12, total_tokens: 52},
    choices: [{finish_reason: 'stop', message: {content: JSON.stringify({
      action: input().options[0].id, reaction: 'focused', ...(generated ? {dialogue: '我先把事情安排好。'} : {}),
    })}}], ...overrides};
}
beforeEach(() => {
  vi.stubEnv('EVAL_LLM_BACKEND', 'self-hosted');
  vi.stubEnv('EVAL_LLM_BASE_URL', 'http://127.0.0.1:8000/v1/');
  vi.stubEnv('EVAL_LLM_MODEL', 'kimi-k3');
  vi.stubEnv('EVAL_LLM_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', 'must-not-leak');
  vi.stubEnv('EVAL_LLM_TIMEOUT_MS', '');
  vi.stubEnv('EVAL_LLM_MAX_OUTPUT_TOKENS', '');
  vi.stubEnv('EVAL_LLM_THINKING', '');
});
afterEach(() => {vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe.each(providers)('%s shared transport', (_name, factory, defaultTokens, generated) => {
  it('uses only local request settings and preserves usage and unmetered provenance', async () => {
    const fetcher = vi.fn(async () => Response.json(envelope(generated, {usage: {cost: 0, prompt_tokens: 40, completion_tokens: 12, total_tokens: 52}})));
    const provider = factory(fetcher as typeof fetch);
    expect(provider).toMatchObject({paid: false, billingMode: 'self-hosted-unmetered', runtimeSettings: {
      backend: 'self-hosted', endpoint: 'http://127.0.0.1:8000/v1/chat/completions', requestTimeoutMs: 12000, maxOutputTokens: defaultTokens,
    }});
    const result = await provider.decide(input());
    expect(result).toMatchObject({contractValid: true, model: 'kimi-k3', finishReason: 'stop', tokenUsage: {promptTokens: 40, completionTokens: 12, totalTokens: 52}});
    expect(result.rawContent).toBe(envelope(generated).choices[0].message.content);
    expect(result.cost).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe('http://127.0.0.1:8000/v1/chat/completions');
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(new Headers(init.headers).has('X-Title')).toBe(false);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({model: 'kimi-k3', max_tokens: defaultTokens});
    expect(body.provider).toBeUndefined();
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain('must-not-leak');
  });

  it('uses native fetch for self-hosted requests with a dedicated optional key', async () => {
    vi.stubEnv('JEV_DNS_SERVER', 'invalid-dns');
    vi.stubEnv('EVAL_LLM_API_KEY', 'local-secret');
    const native = vi.fn(async () => Response.json(envelope(generated)));
    vi.stubGlobal('fetch', native);
    await factory().decide(input());
    expect(native).toHaveBeenCalledTimes(1);
    const init = (native.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer local-secret');
  });

  it.each([
    [Object.assign(new TypeError('private host and credentials'), {cause:{code:'UND_ERR_SOCKET'}}), 'transport_socket_closed'],
    [Object.assign(new TypeError('private host'), {cause:{code:'ECONNRESET'}}), 'transport_connection_reset'],
    [new DOMException('private timeout details', 'TimeoutError'), 'transport_timeout'],
    [new Error('unknown private failure'), 'transport_error'],
  ])('retains only a safe transport category %#', async (error, code) => {
    const fetcher=vi.fn(async()=>{throw error;});
    await expect(factory(fetcher as typeof fetch).decide(input())).rejects.toThrow(new RegExp(`^${code}$`));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('applies bounded explicit timeout and token budget', async () => {
    vi.stubEnv('EVAL_LLM_TIMEOUT_MS', '120000');
    vi.stubEnv('EVAL_LLM_MAX_OUTPUT_TOKENS', '8192');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn(async () => Response.json(envelope(generated)));
    const provider = factory(fetcher as typeof fetch);
    await provider.decide(input());
    expect(timeout).toHaveBeenCalledWith(120000);
    expect(provider).toMatchObject({runtimeSettings: {requestTimeoutMs: 120000, maxOutputTokens: 8192}});
    expect(JSON.parse(String((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body)).max_tokens).toBe(8192);
  });

  it.each(['', 'ftp://localhost/v1', 'http://user:secret@localhost/v1', 'http://localhost/v1?secret=x', 'http://localhost/v1#secret', 'http://localhost/v1?', 'http://localhost/v1#', 'not-url'])('rejects unsafe or missing base URL %s with a redacted error', base => {
    vi.stubEnv('EVAL_LLM_BASE_URL', base);
    expect(() => factory()).toThrow(/^invalid_evaluation_base_url$/);
  });
  it.each(['enabled', 'disabled', 'invalid'])('rejects unsupported thinking setting %s instead of silently ignoring it', thinking => {
    vi.stubEnv('EVAL_LLM_THINKING', thinking);
    expect(() => factory()).toThrow(/^unsupported_evaluation_thinking$/);
  });
  it.each([['enabled', true], ['disabled', false]] as const)('sends and records the verified Kimi K3 thinking control: %s', async (setting, enabled) => {
    vi.stubEnv('EVAL_LLM_MODEL', 'moonshotai/Kimi-K3');
    vi.stubEnv('EVAL_LLM_THINKING', setting);
    const fetcher = vi.fn(async () => Response.json(envelope(generated)));
    const provider = factory(fetcher as typeof fetch);
    await provider.decide(input());
    const body = JSON.parse(String((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body));
    expect(body.chat_template_kwargs).toEqual({ thinking: enabled });
    expect(provider.runtimeSettings?.thinking).toBe(enabled);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not send the private Kimi rendering control to OpenRouter', () => {
    vi.stubEnv('EVAL_LLM_BACKEND', 'openrouter');
    vi.stubEnv('EVAL_LLM_MODEL', 'moonshotai/Kimi-K3');
    vi.stubEnv('EVAL_LLM_THINKING', 'disabled');
    expect(() => factory()).toThrow(/^unsupported_evaluation_thinking$/);
  });
  it.each(['0', '-1', '1.5', 'NaN', '120001'])('rejects invalid timeout %s', value => {
    vi.stubEnv('EVAL_LLM_TIMEOUT_MS', value);
    expect(() => factory()).toThrow(/^invalid_evaluation_timeout$/);
  });
  it.each(['0', '-1', '1.5', 'NaN', '8193'])('rejects invalid token budget %s', value => {
    vi.stubEnv('EVAL_LLM_MAX_OUTPUT_TOKENS', value);
    expect(() => factory()).toThrow(/^invalid_evaluation_max_output_tokens$/);
  });
  it('rejects unknown backends and a missing model before requesting', () => {
    vi.stubEnv('EVAL_LLM_MODEL', '');
    expect(() => factory()).toThrow(/^missing_evaluation_model$/);
    vi.stubEnv('EVAL_LLM_MODEL', 'kimi-k3');
    vi.stubEnv('EVAL_LLM_BACKEND', 'unknown');
    expect(() => factory()).toThrow(/^invalid_evaluation_backend$/);
  });
  it('retains valid usage even when other response metadata is malformed', async () => {
    const result = await factory((async () => Response.json(envelope(generated, {model: null}))) as typeof fetch).decide(input());
    expect(result).toMatchObject({tokenUsage: {promptTokens: 40, completionTokens: 12, totalTokens: 52}});
    expect(result.model).toBeUndefined();
  });
  it.each([
    {prompt_tokens: -1, completion_tokens: 2, total_tokens: 1},
    {prompt_tokens: 1, completion_tokens: 0.5, total_tokens: 1.5},
    {prompt_tokens: 1, completion_tokens: 2},
  ])('does not manufacture valid usage from malformed fields %#', async usage => {
    const result = await factory((async () => Response.json(envelope(generated, {usage}))) as typeof fetch).decide(input());
    expect(result.tokenUsage).toBeUndefined();
  });
});

it.each(['length', null, undefined])('requires a stop finish reason for selector responses (%s)', async finishReason => {
  const body = envelope(false);
  (body.choices[0] as {finish_reason: unknown}).finish_reason = finishReason;
  expect((await llmProvider((async () => Response.json(body)) as typeof fetch).decide(input())).contractValid).toBe(false);
});
it('rejects an unavailable selector action while preserving raw evidence', async () => {
  const body = envelope(false);
  body.choices[0].message.content = '{"action":"invented","reaction":"focused"}';
  const result = await llmProvider((async () => Response.json(body)) as typeof fetch).decide(input());
  expect(result).toMatchObject({contractValid: false, rawContent: body.choices[0].message.content, finishReason: 'stop'});
});
