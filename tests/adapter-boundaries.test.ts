import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { LocalJevProvider } from '../src/providers/local-jev';
import { FogHarborEnvironment } from '../src/adapters/fog-harbor/environment';
import { createWorld, playerInteract, serializeWorld, advance } from '../src/sim';
import { learnKnowledge } from '../src/character';

const root = resolve(import.meta.dirname, '..');
function imports(path: string) {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const dependencies: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) dependencies.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) dependencies.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file); return dependencies;
}
function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? typescriptFiles(resolve(dir, entry.name)) : entry.name.endsWith('.ts') ? [resolve(dir, entry.name)] : []);
}

describe('game and transport boundaries', () => {
  it('keeps every character core import inside core or its schema library', () => {
    const core = resolve(root, 'src/character');
    for (const path of typescriptFiles(core)) for (const dependency of imports(path)) {
      expect(dependency === 'zod' || (dependency.startsWith('.') && resolve(dirname(path), dependency).startsWith(core + '/')), `${path} imports ${dependency}`).toBe(true);
    }
  });
  it('keeps the second environment free of Fog Harbor and renderer dependencies', () => {
    const path = resolve(root, 'examples/cabin.ts');
    for (const dependency of imports(path)) {
      const target = resolve(dirname(path), dependency), core = resolve(root, 'src/character');
      expect(target === core || target.startsWith(core + '/'), dependency).toBe(true);
    }
  });
  it('maps the generic frame to the existing wire protocol without passing world state', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ npcId: 'ship-engineer', revision: 4, state: { own: 'tired' }, options: [{ id: 'rest', label: 'Rest', description: 'Rest.' }, { id: 'work', label: 'Work', description: 'Work.' }] });
      return Response.json({ npcId: 'ship-engineer', revision: 4, choice: 'rest', affect: 'focused' });
    });
    const provider = new LocalJevProvider('/api/decide', fetcher as typeof fetch);
    expect(await provider.decide({ characterId: 'ship-engineer', revision: 4, context: { own: 'tired' }, options: [{ id: 'rest', label: 'Rest', description: 'Rest.' }, { id: 'work', label: 'Work', description: 'Work.' }] }, new AbortController().signal)).toMatchObject({ choice: 'rest' });
  });
  it('rejects a response for the wrong actor before core execution', async () => {
    const provider = new LocalJevProvider('/api/decide', (async () => Response.json({ npcId: 'wrong', revision: 4, choice: 'rest', affect: 'focused' })) as typeof fetch);
    await expect(provider.decide({ characterId: 'ship-engineer', revision: 4, context: {}, options: [{ id: 'rest', label: 'Rest', description: 'Rest.' }, { id: 'work', label: 'Work', description: 'Work.' }] }, new AbortController().signal)).rejects.toThrow('invalid_response');
  });
  it('rejects old game captures and cannot execute the same capture twice', () => {
    let world = createWorld();
    const environment = new FogHarborEnvironment({ world: () => world, running: () => true, allows: () => true });
    playerInteract(world, 'lin', 'greet');
    const turn = environment.openTurn('lin')!;
    expect(turn.execute({ choice: 'reply', affect: 'warm' }, 'fixture').status).toBe('applied');
    const after = serializeWorld(world);
    expect(turn.execute({ choice: 'reply', affect: 'warm' }, 'fixture').status).toBe('rejected');
    expect(serializeWorld(world)).toBe(after);
    const old = environment.openTurn('lin')!;
    world = createWorld();
    expect(old.isCurrent()).toBe(false);
    expect(old.execute({ choice: 'wait', affect: 'focused' }, 'fixture').status).toBe('rejected');
  });
  it('rejects a captured conversation after the player leaves without mutating anything', () => {
    const world = createWorld();
    playerInteract(world, 'lin', 'greet');
    const environment = new FogHarborEnvironment({ world: () => world, running: () => true, allows: () => true });
    const turn = environment.openTurn('lin')!;
    world.player.x = 1500;
    const before = serializeWorld(world);
    expect(turn.isCurrent()).toBe(false);
    expect(turn.execute({ choice: 'reply', affect: 'warm' }, 'fixture').status).toBe('rejected');
    expect(serializeWorld(world)).toBe(before);
  });
  it('stages rule effects so an exception does not partially change the real world', () => {
    const world = createWorld(); playerInteract(world, 'lin', 'greet');
    const environment = new FogHarborEnvironment({ world: () => world, running: () => true, allows: () => true });
    const turn = environment.openTurn('lin')!, before = serializeWorld(world);
    // Host misuse bypasses runtime validation. The legacy rule mutates trust before checking affect.
    expect(() => turn.execute({ choice: 'reply', affect: 'invalid' as never }, 'fixture')).toThrow();
    expect(serializeWorld(world)).toBe(before);
  });

  it.each(['learnedAt', 'validUntil', 'retiredAt'] as const)('invalidates a capture exactly at a knowledge %s boundary', (boundary) => {
    const world = createWorld(), npc = world.npcs[0];
    const claim = npc.mind.knowledge.find(entry => entry.topic === 'lin-debt')!;
    claim[boundary] = 10;
    const environment = new FogHarborEnvironment({ world: () => world, running: () => true, allows: () => true });
    const turn = environment.openTurn('lin')!;
    world.time = 9;
    expect(turn.isCurrent()).toBe(true);
    world.time = 10;
    expect(turn.isCurrent()).toBe(false);
    const before = serializeWorld(world);
    expect(turn.execute({ choice: 'wait', affect: 'focused' }, 'fixture').status).toBe('rejected');
    expect(serializeWorld(world)).toBe(before);
  });

  it('invalidates on core knowledge changes even without a legacy NPC revision change', () => {
    const world = createWorld(), npc = world.npcs[0];
    const environment = new FogHarborEnvironment({ world: () => world, running: () => true, allows: () => true });
    const turn = environment.openTurn('lin')!, revision = npc.revision;
    learnKnowledge(npc.mind, { id: 'new', topic: 'supply', value: 'empty', learnedAt: 0, source: { kind: 'observed' }, confidence: 1 });
    expect(npc.revision).toBe(revision);
    expect(turn.isCurrent()).toBe(false);
  });

  it('invalidates composed speech when work pressure crosses its expression threshold', () => {
    const world = createWorld(), npc = world.npcs.find(n => n.id === 'mei')!;
    Object.assign(world.player, { x: npc.x, y: npc.y });
    Object.assign(npc.needs, { hunger: 65, energy: 65, social: 50, workPressure: 59.99 });
    playerInteract(world, npc.id, 'ask');
    const environment = new FogHarborEnvironment({ world: () => world, running: () => true, allows: () => true });
    const turn = environment.openTurn(npc.id)!;
    expect(turn.input.options.find(o => o.id === 'reply:state')!.description).toContain('今天还应付得来');
    advance(world, 1);
    expect(turn.isCurrent()).toBe(false);
    const before = serializeWorld(world);
    expect(turn.execute({ choice: 'reply:state', affect: 'focused' }, 'fixture').status).toBe('rejected');
    expect(serializeWorld(world)).toBe(before);
    const fresh = environment.openTurn(npc.id)!;
    expect(fresh.input.options.find(o => o.id === 'reply:state')!.description).toContain('手头还有不少事情');
    expect(fresh.execute({ choice: 'reply:state', affect: 'focused' }, 'fixture').status).toBe('applied');
    expect(npc.bubble).toContain('手头还有不少事情');
  });

});
