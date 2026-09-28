import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';
import type { RequestOptions } from 'node:https';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve4: vi.fn(), setServers: vi.fn(), cancel: vi.fn(), request: vi.fn(), resolver: vi.fn() }));
vi.mock('node:dns/promises', () => ({ Resolver: vi.fn(function (options) {
  mocks.resolver(options);
  return { resolve4: mocks.resolve4, setServers: mocks.setServers, cancel: mocks.cancel };
}) }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { createOpenRouterFetch } from '../server/openrouter-fetch';

const endpoint = 'https://openrouter.ai/api/alpha/decisions';
type MockResponse = PassThrough & { statusCode: number; statusMessage: string; headers: IncomingHttpHeaders; rawHeaders: string[] };
let request: EventEmitter & { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
let respond: (response: MockResponse) => void;
function response(statusCode = 200, headers: IncomingHttpHeaders = {}): MockResponse {
  return Object.assign(new PassThrough(), { statusCode, statusMessage: 'OK', headers, rawHeaders: Object.entries(headers).flatMap(([key, value]) => [key, String(value)]) });
}
async function waitForRequest() { await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce()); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.resolve4.mockResolvedValue(['104.18.2.115']);
  request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  mocks.request.mockImplementation((_url, _options, callback) => { respond = callback; return request; });
});

describe('project-scoped OpenRouter DNS transport', () => {
  it('returns native fetch unchanged when no override is configured', () => {
    expect(createOpenRouterFetch()).toBe(globalThis.fetch);
    expect(mocks.resolver).not.toHaveBeenCalled();
  });
  it.each(['', 'dns.example', 'http://192.168.1.1', '192.168.1.1:53', '999.1.1.1'])('rejects non-IP DNS overrides: %s', dns => {
    expect(() => createOpenRouterFetch(dns)).toThrow('DNS server must be an IP address');
  });
  it.each(['http://openrouter.ai/api/test', 'https://example.com/api/test', 'https://openrouter.ai:444/api/test',
    'https://secret@openrouter.ai/api/test', 'https://openrouter.ai/not-api/test', 'https://openrouter.ai/api'])('restricts endpoints before DNS: %s', url => {
    return expect(createOpenRouterFetch('192.168.1.1')(url)).rejects.toThrow('Unsupported OpenRouter URL');
  });
  it('rejects unsupported inputs, options, methods and body types without DNS calls', async () => {
    const fetcher = createOpenRouterFetch('192.168.1.1');
    await expect(fetcher(new Request(endpoint))).rejects.toThrow('Request objects are not supported');
    await expect(fetcher(endpoint, { method: 'PUT', body: 'x' })).rejects.toThrow('Unsupported HTTP method');
    await expect(fetcher(endpoint, { method: 'POST', body: new Uint8Array([1]) })).rejects.toThrow('Only string request bodies are supported');
    await expect(fetcher(endpoint, { method: 'GET', body: 'x' })).rejects.toThrow('GET/HEAD requests cannot have a body');
    await expect(fetcher(endpoint, { credentials: 'include' })).rejects.toThrow('Unsupported fetch option');
    await expect(fetcher(endpoint, { headers: { Host: 'evil.example' } })).rejects.toThrow('Host header cannot be overridden');
    expect(mocks.resolve4).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('uses the specified resolver while preserving host, certificate checks, headers and exact body', async () => {
    const body = '{"prompt":"你好"}';
    const pending = createOpenRouterFetch('192.168.1.1')(new URL(endpoint), { method: 'POST',
      headers: { Authorization: 'Bearer fixture-key', 'Content-Type': 'application/json', 'X-Title': 'test' }, body });
    await waitForRequest();
    expect(mocks.setServers).toHaveBeenCalledWith(['192.168.1.1']);
    expect(mocks.resolver).toHaveBeenCalledWith({ timeout: 2000, tries: 1 });
    expect(mocks.resolve4).toHaveBeenCalledWith('openrouter.ai');
    const [url, options] = mocks.request.mock.calls[0] as [URL, RequestOptions];
    expect(url.href).toBe(endpoint); expect(options).toMatchObject({ rejectUnauthorized: true, servername: 'openrouter.ai', method: 'POST' });
    expect(options).not.toHaveProperty('checkServerIdentity');
    expect(options.headers).toMatchObject({ authorization: 'Bearer fixture-key', 'content-type': 'application/json', 'x-title': 'test' });
    const lookupResult = vi.fn(); options.lookup!('openrouter.ai', {}, lookupResult);
    expect(lookupResult).toHaveBeenCalledWith(null, '104.18.2.115', 4);
    expect(request.end).toHaveBeenCalledWith(body);
    const incoming = response(200, { 'content-type': 'application/json', 'x-request-id': 'fixture-response' }); respond(incoming); incoming.end('{"ok":true}');
    const result = await pending; expect(result.status).toBe(200); expect(result.headers.get('x-request-id')).toBe('fixture-response');
    expect(await result.json()).toEqual({ ok: true });
  });
  it('aborts before DNS work starts', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(createOpenRouterFetch('192.168.1.1')(endpoint, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.resolve4).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('aborts DNS promptly and never starts a request after late resolution', async () => {
    let finishDNS!: (addresses: string[]) => void;
    mocks.resolve4.mockReturnValue(new Promise<string[]>(resolve => { finishDNS = resolve; }));
    const controller = new AbortController();
    const pending = createOpenRouterFetch('192.168.1.1')(endpoint, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await rejected;
    expect(mocks.cancel).toHaveBeenCalledOnce(); finishDNS(['104.18.2.115']); await Promise.resolve();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('aborts an ongoing response and destroys the request', async () => {
    const controller = new AbortController(); const pending = createOpenRouterFetch('192.168.1.1')(endpoint, { signal: controller.signal });
    await waitForRequest(); const incoming = response(); respond(incoming); incoming.write('partial');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await rejected;
    expect(request.destroy).toHaveBeenCalledOnce(); expect(incoming.destroyed).toBe(true);
  });
  it('rejects oversized response bodies and stops reading', async () => {
    const pending = createOpenRouterFetch('192.168.1.1')(endpoint); await waitForRequest();
    const incoming = response(); respond(incoming); const rejected = expect(pending).rejects.toThrow('OpenRouter response exceeds 2 MiB');
    incoming.write(Buffer.alloc(2 * 1024 * 1024 + 1)); await rejected;
    expect(request.destroy).toHaveBeenCalledOnce(); expect(incoming.destroyed).toBe(true);
  });
  it('surfaces redirects without forwarding credentials and handles bodyless 204 responses', async () => {
    const fetcher = createOpenRouterFetch('192.168.1.1');
    const redirect = fetcher(endpoint, { headers: { Authorization: 'Bearer fixture-key' } }); await waitForRequest();
    const moved = response(302, { location: 'https://elsewhere.example/' }); respond(moved); moved.end();
    expect((await redirect).status).toBe(302); expect(mocks.request).toHaveBeenCalledOnce();
    mocks.request.mockClear(); const empty = fetcher(endpoint); await waitForRequest(); const noContent = response(204); respond(noContent); noContent.end();
    const result = await empty; expect(result.status).toBe(204); expect(await result.text()).toBe('');
  });
  it('propagates DNS, TLS and response-stream failures as safe errors', async () => {
    mocks.resolve4.mockRejectedValueOnce(new Error('DNS fixture failure'));
    await expect(createOpenRouterFetch('192.168.1.1')(endpoint)).rejects.toThrow('OpenRouter DNS lookup failed');
    const pending = createOpenRouterFetch('192.168.1.1')(endpoint); await waitForRequest();
    const rejected = expect(pending).rejects.toThrow('OpenRouter HTTPS request failed'); request.emit('error', new Error('certificate failure')); await rejected;
    mocks.request.mockClear(); const streaming = createOpenRouterFetch('192.168.1.1')(endpoint); await waitForRequest(); const incoming = response(); respond(incoming);
    const streamRejected = expect(streaming).rejects.toThrow('OpenRouter response stream failed'); incoming.emit('error', new Error('stream fixture failure')); await streamRejected;
  });
});
