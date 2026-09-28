import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main, parseControlledArgs } from '../scripts/evaluate-controlled-characters';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('rejects unknown, missing, blank and out of bounds values before creating artifacts', () => {
  expect(parseControlledArgs([])).toMatchObject({ provider: 'authored-policy', maxRequests: 24, maxCost: 1, repeats: 1 });
  for (const args of [['--provider', 'fake'], ['--out'], ['--out', ''], ['--seed', ''], ['--repeats', '21'], ['--repeats', '1.5'], ['--max-requests', '0'], ['--max-cost', '-1'], ['--max-cost', 'NaN'], ['--max-cost', ''], ['--unknown']]) expect(() => parseControlledArgs(args)).toThrow();
});
it('exports a fresh dry run without constructing the explicitly selected online provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controlled-cli-')); roots.push(root);
  const out = join(root, 'dry');
  const args = ['--provider', 'jev', '--dry-run', '--out', out];
  await main(args);
  expect(JSON.parse(await readFile(join(out, 'cases.json'), 'utf8'))).toHaveLength(24);
  expect(JSON.parse(await readFile(join(out, 'dry-run.json'), 'utf8'))).toMatchObject({ requests: 0, plannedRequests: 24, provider: 'jev' });
  expect(JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'))).toHaveProperty('sourceGitSHA');
  await expect(main(args)).rejects.toThrow();
});
