import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {llmCharacterProvider} from '../scripts/evaluation/llm-character';
import {prepareDevelopmentCase} from '../scripts/evaluation/cases';
import {ACTION_INSTRUCTIONS, REACTION_INSTRUCTIONS} from '../server/jev';
import {REACTION_OPTIONS} from '../src/character';

const conversational = () => prepareDevelopmentCase('mei/plan').scenario.input;
const autonomous = () => prepareDevelopmentCase('mei/hungry').scenario.input;
const dialogue = '  我想先把眼前的事做好，再慢慢安排。\n';
const content = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  action: conversational().options[0].id, reaction: 'focused', dialogue, ...overrides,
});
const envelope = (rawContent: unknown = content(), finishReason: unknown = 'stop') => ({
  model: 'test/returned', usage: {cost: 0.002},
  choices: [{message: {content: rawContent}, finish_reason: finishReason}],
});
const fakeResponse = (body: unknown) => vi.fn(async () => Response.json(body)) as unknown as typeof fetch;

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-secret');
  vi.stubEnv('EVAL_LLM_MODEL', 'test/model');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('uses a versioned generated-expression protocol and preserves exact dialogue and raw output', async () => {
  const provider = llmCharacterProvider(fakeResponse(envelope()));
  expect(provider).toMatchObject({id: 'llm-character', model: 'test/model', paid: true, expressionMode: 'generated'});
  expect(provider.protocolVersion).toBe('shared-action-reaction-dialogue-json-v2');
  expect(await provider.decide(conversational())).toMatchObject({
    choice: conversational().options[0].id, affect: 'focused', dialogue, rawContent: content(),
    finishReason: 'stop', cost: 0.002, model: 'test/returned', contractValid: true,
  });
});

it('sends the same local context and choices with bounded strict structured generation', async () => {
  const input = conversational();
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({model: 'test/model', temperature: 0, max_tokens: 600, provider: {require_parameters: true}});
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const system = body.messages[0].content as string;
    expect(system).toContain(ACTION_INSTRUCTIONS);
    expect(system).toContain(REACTION_INSTRUCTIONS);
    expect(system).toMatch(/Chinese/);
    expect(system).toMatch(/not.*completed/);
    expect(system).toMatch(/optional/);
    const observation = JSON.parse(body.messages[1].content);
    expect(observation.state).toEqual(input.state);
    expect(observation.actionCriteria).toEqual(Object.fromEntries(input.options.map(o => [o.id, o.description])));
    expect(observation.reactionCriteria).toEqual(Object.fromEntries(REACTION_OPTIONS.map(r => [r.id, r.description])));
    expect(body.messages[1].content).not.toContain('acceptableChoices');
    expect(body.response_format).toMatchObject({type: 'json_schema', json_schema: {strict: true, schema: {
      type: 'object', required: ['action', 'reaction', 'dialogue'], additionalProperties: false,
      properties: {action: {enum: input.options.map(o => o.id)}, reaction: {enum: REACTION_OPTIONS.map(r => r.id)}, dialogue: {type: 'string'}},
    }}});
    return Response.json(envelope());
  });
  await llmCharacterProvider(fetcher as typeof fetch).decide(input);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(timeout).toHaveBeenCalledWith(12000);
});

it('requires autonomous decisions to use null dialogue', async () => {
  const input = autonomous();
  const result = await llmCharacterProvider(fakeResponse(envelope(content({action: input.options[0].id, dialogue: null})))).decide(input);
  expect(result).toMatchObject({dialogue: null, contractValid: true});
  const invalid = await llmCharacterProvider(fakeResponse(envelope(content({action: input.options[0].id})))).decide(input);
  expect(invalid).toMatchObject({dialogue, contractValid: false});
});

it('constrains the autonomous output schema to null instead of inviting unsupported speech', async () => {
  const input = autonomous();
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.response_format.json_schema.schema.properties.dialogue).toEqual({ type: 'null' });
    expect(body.messages[0].content).toContain('No player is speaking');
    return Response.json(envelope(content({ action: input.options[0].id, dialogue: null })));
  }) as typeof fetch;
  expect((await llmCharacterProvider(fetcher).decide(input)).contractValid).toBe(true);
});

it.each([
  ['unknown action', {action: 'invented'}],
  ['unknown reaction', {reaction: 'ecstatic'}],
  ['blank dialogue', {dialogue: ' \n\t'}],
  ['null dialogue in an interaction', {dialogue: null}],
  ['oversized dialogue', {dialogue: '啊'.repeat(1601)}],
  ['additional properties', {reasoning: 'extra'}],
  ['non-string dialogue', {dialogue: 1}],
])('rejects %s without losing model, billing or parseable dialogue', async (_label, overrides) => {
  const raw = content(overrides);
  const result = await llmCharacterProvider(fakeResponse(envelope(raw))).decide(conversational());
  expect(result).toMatchObject({contractValid: false, rawContent: raw, model: 'test/returned', cost: 0.002});
  const expected = 'dialogue' in overrides ? overrides.dialogue : dialogue;
  if (typeof expected === 'string' || expected === null) expect(result.dialogue).toBe(expected);
});

it('accepts dialogue at the exact 1600 character boundary', async () => {
  const result = await llmCharacterProvider(fakeResponse(envelope(content({dialogue: '啊'.repeat(1600)})))).decide(conversational());
  expect(result.contractValid).toBe(true);
});

it.each(['action', 'reaction', 'dialogue'])('rejects a missing required %s field', async field => {
  const answer = JSON.parse(content());
  delete answer[field];
  expect((await llmCharacterProvider(fakeResponse(envelope(JSON.stringify(answer)))).decide(conversational())).contractValid).toBe(false);
});

it.each(['length', 'content_filter', null, undefined])('rejects a non-stop finish reason %s and retains generated evidence', async reason => {
  const body = envelope();
  body.choices[0].finish_reason = reason;
  const result = await llmCharacterProvider(fakeResponse(body)).decide(conversational());
  expect(result).toMatchObject({contractValid: false, dialogue, rawContent: content(), finishReason: reason ?? null, cost: 0.002});
});

it.each(['invalid-json', '{"action":', 'null', '[]'])('retains malformed model output %s and known billing', async raw => {
  expect(await llmCharacterProvider(fakeResponse(envelope(raw))).decide(conversational())).toMatchObject({
    contractValid: false, rawContent: raw, finishReason: 'stop', model: 'test/returned', cost: 0.002,
  });
});

it.each([null, [], {}, {choices: []}, {choices: [{message: null}]}, {choices: [{message: {content: []}, finish_reason: 'stop'}]}])('safely rejects malformed envelopes %#', async body => {
  expect((await llmCharacterProvider(fakeResponse(body)).decide(conversational())).contractValid).toBe(false);
});

it('accepts missing optional model and cost metadata without manufacturing values', async () => {
  const result = await llmCharacterProvider(fakeResponse({choices: envelope().choices})).decide(conversational());
  expect(result.contractValid).toBe(true);
  expect(result.model).toBeUndefined();
  expect(result.cost).toBeUndefined();
});

it('extracts valid cost and model independently from malformed metadata', async () => {
  const invalidModel = {...envelope('broken'), model: {unexpected: true}};
  const first = await llmCharacterProvider(fakeResponse(invalidModel)).decide(conversational());
  expect(first).toMatchObject({contractValid: false, cost: 0.002});
  expect(first.model).toBeUndefined();
  const invalidCost = {...envelope('broken'), usage: {cost: -1}};
  const second = await llmCharacterProvider(fakeResponse(invalidCost)).decide(conversational());
  expect(second.model).toBe('test/returned');
  expect(second.cost).toBeUndefined();
});

it.each(['', ' '])('rejects a missing or blank key before sending requests', key => {
  vi.stubEnv('OPENROUTER_API_KEY', key);
  const fetcher = fakeResponse(envelope());
  expect(() => llmCharacterProvider(fetcher)).toThrow('missing_key');
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['', ' '])('rejects a missing or blank model before sending requests', model => {
  vi.stubEnv('EVAL_LLM_MODEL', model);
  expect(() => llmCharacterProvider(fakeResponse(envelope()))).toThrow('missing_evaluation_model');
});

it('redacts network errors and never retries', async () => {
  const fetcher = vi.fn(async () => { throw new Error('test-secret in upstream error'); });
  await expect(llmCharacterProvider(fetcher).decide(conversational())).rejects.toThrow(/^transport_error$/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('redacts failed HTTP response bodies', async () => {
  const fetcher = vi.fn(async () => new Response('test-secret', {status: 401}));
  await expect(llmCharacterProvider(fetcher).decide(conversational())).rejects.toThrow(/^upstream_401$/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('redacts invalid envelope JSON errors', async () => {
  const fetcher = vi.fn(async () => new Response('test-secret'));
  await expect(llmCharacterProvider(fetcher).decide(conversational())).rejects.toThrow(/^invalid_response$/);
});
