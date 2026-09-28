import {transportErrorCode} from './transport-errors';
import {z} from 'zod';
import {createOpenRouterFetch} from '../../server/openrouter-fetch';
import {DecisionError} from '../../server/jev';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function boundedSetting(name: string, fallback: number, limit: number, error: string): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new DecisionError(error);
  return value;
}

function localEndpoint(): string {
  try {
    const url = new URL(process.env.EVAL_LLM_BASE_URL?.trim() ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')) throw new Error();
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    return url.href;
  } catch { throw new DecisionError('invalid_evaluation_base_url'); }
}

/** One explicit endpoint and credential source; no fallback or retry across providers. */
export function createEvaluationTransport(defaultTokens: number, suppliedFetch?: typeof fetch) {
  const backend = process.env.EVAL_LLM_BACKEND?.trim() || 'openrouter';
  if (backend !== 'openrouter' && backend !== 'self-hosted') throw new DecisionError('invalid_evaluation_backend');
  const selfHosted = backend === 'self-hosted';
  const model = process.env.EVAL_LLM_MODEL?.trim();
  const key = (selfHosted ? process.env.EVAL_LLM_API_KEY : process.env.OPENROUTER_API_KEY)?.trim();
  if (!selfHosted && !key) throw new DecisionError('missing_key');
  if (!model) throw new DecisionError('missing_evaluation_model');
  const thinkingSetting = process.env.EVAL_LLM_THINKING?.trim();
  if (thinkingSetting && (!selfHosted || model !== 'moonshotai/Kimi-K3' || !['enabled', 'disabled'].includes(thinkingSetting))) {
    throw new DecisionError('unsupported_evaluation_thinking');
  }
  // Verified against the deployed K3 renderer/parser; leave other models untouched.
  const thinking = thinkingSetting ? thinkingSetting === 'enabled' : undefined;
  const endpoint = selfHosted ? localEndpoint() : 'https://openrouter.ai/api/v1/chat/completions';
  const requestTimeoutMs = boundedSetting('EVAL_LLM_TIMEOUT_MS', 12000, 120000, 'invalid_evaluation_timeout');
  const maxOutputTokens = boundedSetting('EVAL_LLM_MAX_OUTPUT_TOKENS', defaultTokens, 8192, 'invalid_evaluation_max_output_tokens');
  const dnsServer = process.env.JEV_DNS_SERVER?.trim() || undefined;
  const usesDnsTransport = !selfHosted && suppliedFetch === undefined && dnsServer !== undefined;
  // The existing DNS wrapper has its own 12-second deadline and never follows redirects.
  if (usesDnsTransport && requestTimeoutMs > 12000) throw new DecisionError('unsupported_evaluation_dns_timeout');
  const fetcher = suppliedFetch ?? (selfHosted ? globalThis.fetch : createOpenRouterFetch(dnsServer));
  return {
    model, selfHosted,
    providerMetadata: {
      paid: !selfHosted,
      ...(selfHosted ? {billingMode: 'self-hosted-unmetered' as const} : {}),
      runtimeSettings: {backend, endpoint, requestTimeoutMs, maxOutputTokens,
        ...(thinking !== undefined ? {thinking} : {})},
    },
    async request(body: Record<string, unknown>): Promise<unknown> {
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: 'POST', redirect: usesDnsTransport ? 'manual' : 'error', signal: AbortSignal.timeout(requestTimeoutMs),
          headers: {
            'Content-Type': 'application/json',
            ...(key ? {Authorization: `Bearer ${key}`} : {}),
            ...(!selfHosted ? {'X-Title': 'Jev Character Controlled Evaluation'} : {}),
          },
          body: JSON.stringify({
            ...body, model, temperature: 0, max_tokens: maxOutputTokens,
            ...(thinking !== undefined ? {chat_template_kwargs: {thinking}} : {}),
            ...(!selfHosted ? {provider: {require_parameters: true}} : {}),
          }),
        });
      } catch(error) { throw new DecisionError(transportErrorCode(error)); }
      if (!response.ok) throw new DecisionError(`upstream_${response.status}`);
      try { return await response.json(); } catch { throw new DecisionError('invalid_response'); }
    },
  };
}

/** Extract evidence independently so one malformed field cannot erase the rest. */
export function responseEvidence(raw: unknown, selfHosted: boolean) {
  const metadata = record(raw);
  const first = record(Array.isArray(metadata.choices) ? metadata.choices[0] : undefined);
  const message = record(first.message);
  const usage = record(metadata.usage);
  const cost = z.number().finite().nonnegative().safeParse(usage.cost);
  const responseModel = z.string().safeParse(metadata.model);
  const tokens = z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).safeParse(usage);
  return {
    rawContent: typeof message.content === 'string' ? message.content : null,
    finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : null,
    cost: !selfHosted && cost.success ? cost.data : undefined,
    model: responseModel.success ? responseModel.data : undefined,
    tokenUsage: tokens.success ? {
      promptTokens: tokens.data.prompt_tokens,
      completionTokens: tokens.data.completion_tokens,
      totalTokens: tokens.data.total_tokens,
    } : undefined,
  };
}
