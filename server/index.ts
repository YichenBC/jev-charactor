import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, decisionInput, DecisionError } from './jev';

const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4317);
const key = process.env.OPENROUTER_API_KEY || '';
let active = 0;
let requests = 0;
const requestTimes: number[] = [];
app.disable('x-powered-by');
app.use((req, res, next) => {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(req.headers.host || '')) return void res.status(403).json({ error: 'local_only' });
  if (req.path.toLowerCase().startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && !allowed.some(host => origin === `http://${host}`)) return void res.status(403).json({ error: 'origin_denied' });
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.json({ limit: '64kb' }));
app.get('/api/status', (_req, res) => {
  res.json({ app: 'jev-neighborhood', configured: Boolean(key), model: process.env.JEV_MODEL || 'typesafe/jev-1.13', active, requests, budget: 1200 });
});
app.post('/api/decide', async (req, res) => {
  const result = decisionInput.safeParse(req.body);
  if (!result.success) return void res.status(400).json({ error: 'invalid_input' });
  if (!key) return void res.status(503).json({ error: 'missing_key' });
  const now = Date.now();
  while (requestTimes[0] < now - 60000) requestTimes.shift();
  if (active >= 2 || requestTimes.length >= 90) return void res.status(429).json({ error: 'rate_limited' });
  if (requests >= 1200) return void res.status(429).json({ error: 'session_budget' });
  active++; requests++; requestTimes.push(now);
  const controller = new AbortController();
  const disconnected = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', disconnected);
  try { const answer = await decide(result.data, key, undefined, controller.signal); if (!controller.signal.aborted) res.json(answer); }
  catch (error) { if (!controller.signal.aborted) res.status(502).json({ error: error instanceof DecisionError ? error.message : 'decision_failed' }); }
  finally { active--; res.off('close', disconnected); }
});
app.use('/api', (_req, res) => { res.status(404).json({ error: 'not_found' }); });
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/', (_req, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number })?.status === 413 ? 413 : 400;
  res.status(status).json({ error: status === 413 ? 'body_too_large' : 'bad_request' });
});
app.listen(port, '127.0.0.1', () => console.log(`雾港街区 http://127.0.0.1:${port} · Jev ${key ? 'configured' : 'missing key'}`));
