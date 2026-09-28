import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const consumer = await mkdtemp(path.join(tmpdir(), 'jev-core-consumer-'));
let phase = 'build';

async function run(command, args, cwd = consumer) {
  try {
    return await exec(command, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed\n${error.stdout ?? ''}${error.stderr ?? ''}`, { cause: error });
  }
}

const runtimeContract = `
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createMind, learnKnowledge, inspectBelief, CharacterRuntime, compileResponses, addGoal, advanceGoal, addFeeling, inspectPersonal, recordDialogue, recordDialogueExchange, openDialogueTopics, recentlySaid } from '@jev-character/core';

const mind = createMind({ role: 'Archivist', traits: ['careful'], values: ['truth'], speakingStyle: 'Plain.' });
assert.equal(learnKnowledge(mind, { id: 'seen', topic: 'cabinet', value: 'empty', learnedAt: 0, source: { kind: 'observed' }, confidence: 1 }), true);
assert.equal(inspectBelief(mind, 'cabinet', 0).status, 'known');
assert.deepEqual(inspectBelief(mind, 'cabinet', 0).values, ['empty']);
addGoal(mind, { id: 'read', label: 'Read a chapter', activity: 'reading', target: 1, createdAt: 0 });
assert.equal(advanceGoal(mind, 'read', { id: 'chapter-1', at: 1 }), true);
assert.equal(advanceGoal(mind, 'read', { id: 'chapter-1', at: 2 }), false);
addFeeling(mind, { id: 'pleased', label: 'Pleased', basis: 'chapter-1', valence: 1, strength: 1, since: 1, until: 11 });
assert.equal(inspectPersonal(mind, 6).feelings[0].influence, 0.5);
assert.equal(inspectPersonal(mind, 6).goals[0].completed, true);
recordDialogue(mind, { counterparty: 'visitor', topic: 'book', text: 'A book', followUp: 'Which book?', at: 6 });
assert.equal(openDialogueTopics(mind, 'visitor', 6)[0].sequence, 1);
assert.equal(recordDialogue(mind, { speaker: 'other', counterparty: 'visitor', topic: 'book', text: 'Which book?', inReplyTo: 1, at: 6 }, true), false);
assert.equal(recentlySaid(mind, 'visitor', 'Which book?', 6), false);
assert.deepEqual(openDialogueTopics(mind, 'visitor', 6), []);
recordDialogueExchange(mind, { counterparty: 'visitor', topic: 'book', text: 'Another book?', at: 6 }, { counterparty: 'visitor', topic: 'book', text: 'Yes.', at: 6 });
assert.equal(mind.dialogue.turns.at(-1).inReplyTo, 3);

assert.equal(compileResponses([{ id: 'say', intent: 'answer', parts: [{ literal: 'Known: ' }, { fact: 'cabinet' }] }], [{ id: 'cabinet', text: 'empty', basis: 'seen', disclosable: true, validFrom: 0 }], 0)[0].text, 'Known: empty');

let done = false;
let executions = 0;
const environment = {
  openTurn(characterId) {
    return {
      input: { characterId, revision: 0, context: {}, options: [{ id: 'rest', label: 'Rest', description: 'Recover energy.' }] },
      isCurrent: () => !done,
      execute(decision, source) {
        assert.equal(decision.choice, 'rest');
        assert.equal(decision.affect, 'focused');
        assert.equal(source, 'fixture');
        done = true;
        executions++;
        return { status: 'applied', detail: 'Energy recovered.', changes: ['energy'] };
      },
    };
  },
};
const provider = { source: 'fixture', async decide(input) {
  assert.equal(input.characterId, 'ada');
  return { choice: 'rest', affect: 'focused' };
} };
const runtime = new CharacterRuntime(environment, provider);
const first = runtime.step('ada');
assert.equal((await runtime.step('ada')).status, 'skipped');
assert.deepEqual(await first, { status: 'applied', execution: { status: 'applied', detail: 'Energy recovered.', changes: ['energy'] } });
assert.equal(done, true);
assert.equal(executions, 1);
assert.equal((await runtime.step('ada')).status, 'stale');
assert.equal(executions, 1);
assert.equal(runtime.pending.size, 0);

done = false;
let resolveDecision;
let providerSignal;
const deferred = new CharacterRuntime(environment, { source: 'fixture', decide(_input, signal) {
  providerSignal = signal;
  return new Promise(resolve => { resolveDecision = resolve; });
} });
const pending = deferred.step('ada');
assert.equal(deferred.pending.size, 1);
deferred.cancel('ada');
const cancelled = await Promise.race([
  pending,
  new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Cancellation waited for provider')), 2000);
    timer.unref();
  }),
]);
assert.equal(cancelled.status, 'cancelled');
assert.equal(providerSignal.aborted, true);
assert.equal(deferred.pending.size, 0);
assert.equal(done, false);
resolveDecision({ choice: 'rest', affect: 'focused' });
await setImmediate();
assert.equal(done, false);
assert.equal(executions, 1, 'Late provider response must never execute');
console.log('runtime contract passed');
`;

const typeContract = `
import { CharacterRuntime, createMind, learnKnowledge, inspectBelief, type CharacterEnvironment, type DecisionProvider, type TurnResult, type CharacterDecision, compileResponses, type ResponsePlan, type SpeechFact, type RealizedResponse } from '@jev-character/core';
const mind = createMind({ role: 'Archivist', traits: ['careful'], values: ['truth'], speakingStyle: 'Plain.' });
learnKnowledge(mind, { id: 'seen', topic: 'cabinet', value: 'empty', learnedAt: 0, source: { kind: 'observed' }, confidence: 1 });
const status: 'unknown' | 'known' | 'conflicted' | 'outdated' = inspectBelief(mind, 'cabinet', 0).status;
const environment: CharacterEnvironment = { openTurn(characterId) {
  return { input: { characterId, revision: 0, context: {}, options: [{ id: 'rest', label: 'Rest', description: 'Recover energy.' }] },
    isCurrent: () => true, execute: () => ({ status: 'applied', detail: 'Rested.', changes: ['energy'] }) };
} };
const provider: DecisionProvider = { source: 'fixture', async decide(input, signal) {
  const aborted: boolean = signal.aborted;
  return { choice: input.options[0].id, affect: 'focused' };
} };
const result: TurnResult = await new CharacterRuntime(environment, provider).step('ada');
const valid: CharacterDecision = { choice: 'rest', affect: 'focused' };
// @ts-expect-error The installed declarations must enforce the affect vocabulary.
const invalid: CharacterDecision = { choice: 'rest', affect: 'not-an-affect' };
const plans: ResponsePlan[] = [{ id: 'reply', intent: 'inform', parts: [{ fact: 'state' }] }];
const facts: SpeechFact[] = [{ id: 'state', text: 'Tired.', basis: 'energy', disclosable: true, validFrom: 0 }];
const speech: RealizedResponse[] = compileResponses(plans, facts, 0);
void [status, result, valid, invalid, speech];
`;

try {
  await run('npm', ['run', 'build:core'], root);
  console.log('[core-package] build passed');
  phase = 'pack and inspect';
  const { stdout } = await run('npm', ['pack', './packages/core', '--pack-destination', consumer, '--json', '--ignore-scripts'], root);
  const [pack] = JSON.parse(stdout);
  assert.equal(pack.filename, 'jev-character-core-0.1.0-alpha.5.tgz');
  const tarball = path.join(consumer, pack.filename);
  const expected = ['README.md', 'package.json', ...['api', 'index', 'interaction', 'knowledge', 'motivation', 'runtime', 'response', 'dialogue', 'personal'].flatMap(name => [`dist/${name}.js`, `dist/${name}.d.ts`])].sort();
  assert.deepEqual(pack.files.map(file => file.path).sort(), expected, 'Unexpected or missing packed file');
  const archive = await run('tar', ['-tzf', tarball]);
  assert.deepEqual(archive.stdout.trim().split('\n').sort(), expected.map(file => `package/${file}`).sort(), 'Actual archive differs from the allowlist');
  const { stdout: manifestText } = await run('tar', ['-xOzf', tarball, 'package/package.json']);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.name, '@jev-character/core');
  assert.equal(manifest.version, '0.1.0-alpha.5');
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, 'UNLICENSED');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, './dist/api.js');
  assert.equal(manifest.types, './dist/api.d.ts');
  assert.deepEqual(manifest.exports, { '.': { types: './dist/api.d.ts', import: './dist/api.js' } });
  assert.deepEqual(manifest.files, ['dist', 'README.md']);
  assert.deepEqual(manifest.dependencies, { zod: '^4.1.0' });
  assert.equal(manifest.scripts, undefined, 'The consumer package must not have lifecycle scripts');
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
  console.log(`[core-package] archive passed (${expected.length} files): ${expected.join(', ')}`);

  phase = 'install external consumer';
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'core-contract-consumer', private: true, type: 'module' }));
  await run('npm', ['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund']);
  console.log('[core-package] tarball installation passed');

  phase = 'native Node runtime contract';
  await writeFile(path.join(consumer, 'contract.mjs'), runtimeContract);
  await run(process.execPath, ['contract.mjs']);
  console.log('[core-package] native Node state, exactly-once and cancellation contracts passed');

  phase = 'README example';
  const readme = await readFile(path.join(consumer, 'node_modules/@jev-character/core/README.md'), 'utf8');
  const examples = [...readme.matchAll(/```js\n([\s\S]*?)```/g)];
  assert.equal(examples.length, 1, 'Expected one executable JavaScript quickstart');
  await writeFile(path.join(consumer, 'example.mjs'), examples[0][1]);
  const example = await run(process.execPath, ['example.mjs']);
  assert.equal(example.stdout.trim(), 'known\napplied 1', 'README quickstart must demonstrate knowledge and an applied state change');
  console.log('[core-package] installed README example passed with plain Node');

  phase = 'strict NodeNext declaration consumer';
  await writeFile(path.join(consumer, 'contract.mts'), typeContract);
  await writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: [], lib: ['ES2022', 'DOM'] }, files: ['contract.mts'] }));
  await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
  console.log('[core-package] strict NodeNext installed declarations passed');
} catch (error) {
  console.error(`[core-package] FAILED during ${phase}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(consumer, { recursive: true, force: true });
}
