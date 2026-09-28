import { Resolver } from 'node:dns/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ALLOWED_OPTIONS = new Set(['method', 'headers', 'body', 'signal', 'redirect']);

/** Optional project-only DNS routing; certificates are still checked against openrouter.ai. */
export function createOpenRouterFetch(dnsServer?: string): typeof fetch {
  if (dnsServer === undefined) return globalThis.fetch;
  if (!isIP(dnsServer)) throw new TypeError('DNS server must be an IP address');

  return async (input, init = {}) => {
    if (input instanceof Request) throw new TypeError('Request objects are not supported');
    if (typeof input !== 'string' && !(input instanceof URL)) throw new TypeError('Only string or URL inputs are supported');
    let url: URL;
    try { url = new URL(input); } catch { throw new TypeError('Unsupported OpenRouter URL'); }
    if (url.protocol !== 'https:' || url.hostname !== 'openrouter.ai' || (url.port && url.port !== '443') ||
        url.username || url.password || !url.pathname.startsWith('/api/')) throw new TypeError('Unsupported OpenRouter URL');
    for (const [key, value] of Object.entries(init)) {
      if (value !== undefined && !ALLOWED_OPTIONS.has(key)) throw new TypeError(`Unsupported fetch option: ${key}`);
    }
    if (init.redirect !== undefined && init.redirect !== 'manual') throw new TypeError('Only manual redirects are supported');
    const method = (init.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'HEAD'].includes(method)) throw new TypeError('Unsupported HTTP method');
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new TypeError('Only string request bodies are supported');
    if ((method === 'GET' || method === 'HEAD') && init.body != null) throw new TypeError('GET/HEAD requests cannot have a body');
    const headers = new Headers(init.headers);
    if (headers.has('host')) throw new TypeError('Host header cannot be overridden');
    if (typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8');
    const requestHeaders: Record<string, string> = Object.create(null);
    headers.forEach((value, key) => { requestHeaders[key] = value; });
    const body = init.body ?? undefined;
    // Bound the complete DNS, TLS, and body-read path, even if the caller supplies no deadline.
    const timeout = AbortSignal.timeout(12000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    signal.throwIfAborted();

    return new Promise<Response>((resolve, reject) => {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers([dnsServer]);
      let request: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', abort);
      function fail(error: unknown) {
        if (settled) return;
        settled = true;
        cleanup();
        resolver.cancel();
        incoming?.destroy();
        request?.destroy();
        reject(error);
      }
      function abort() { fail(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')); }
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }

      void resolver.resolve4(url.hostname).then(addresses => {
        if (settled) return;
        const address = addresses.find(value => isIP(value) === 4);
        if (!address) { fail(new TypeError('OpenRouter DNS lookup failed')); return; }
        try {
          request = httpsRequest(url, {
            method, headers: requestHeaders,
            // Keep the original hostname for HTTP Host, TLS SNI, and certificate validation.
            servername: 'openrouter.ai', rejectUnauthorized: true, agent: false, family: 4,
            lookup: (_hostname, _options, callback) => callback(null, address, 4),
          }, response => {
            incoming = response;
            if (settled) { response.destroy(); return; }
            const chunks: Buffer[] = [];
            let bytes = 0;
            let ended = false;
            response.on('error', () => fail(new TypeError('OpenRouter response stream failed')));
            response.on('aborted', () => fail(new TypeError('OpenRouter response stream failed')));
            response.on('close', () => { if (!ended) fail(new TypeError('OpenRouter response stream failed')); });
            response.on('data', (chunk: Buffer) => {
              if (settled) return;
              bytes += chunk.length;
              if (bytes > MAX_RESPONSE_BYTES) { fail(new TypeError('OpenRouter response exceeds 2 MiB')); return; }
              chunks.push(chunk);
            });
            response.on('end', () => {
              ended = true;
              if (settled) return;
              try {
                const status = response.statusCode ?? 0;
                const responseHeaders = new Headers();
                for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
                const noBody = method === 'HEAD' || [204, 205, 304].includes(status);
                const result = new Response(noBody ? null : new Uint8Array(Buffer.concat(chunks)), {
                  status, statusText: response.statusMessage, headers: responseHeaders,
                });
                settled = true;
                cleanup();
                resolve(result);
              } catch { fail(new TypeError('Invalid OpenRouter HTTP response')); }
            });
          });
          request.on('error', () => fail(new TypeError('OpenRouter HTTPS request failed')));
          request.on('upgrade', (_response, socket) => { socket.destroy(); fail(new TypeError('OpenRouter protocol upgrades are not supported')); });
          request.end(body);
        } catch { fail(new TypeError('OpenRouter HTTPS request failed')); }
      }, () => fail(new TypeError('OpenRouter DNS lookup failed')));
    });
  };
}
