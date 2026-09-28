import {it,expect,vi} from 'vitest';
import {jevProvider} from '../scripts/evaluation/providers';
import {developmentCases} from '../scripts/evaluation/cases';
import { createWorld, getContext, getOptions, playerInteract } from '../src/sim';
import { ruleProvider, utilityProvider } from '../scripts/evaluation/providers';
import { decisionInput } from '../server/jev';

it('offers real work on explicit request, preserves ordinary speech and prioritizes urgent needs', async () => {
  for (const provider of [ruleProvider, utilityProvider]) {
    for (const action of ['request', 'ask', 'greet']) {
      const world = createWorld(), npc = world.npcs.find(n => n.id === 'mei')!;
      Object.assign(npc.needs, { hunger: 70, energy: 80 });
      Object.assign(world.player, { x: npc.x, y: npc.y });
      playerInteract(world, npc.id, action);
      const input = () => decisionInput.parse({ npcId: npc.id, revision: npc.revision,
        state: getContext(world, npc.id), options: getOptions(world, npc.id) });
      const reply = await provider.decide(input());
      if (action === 'request') expect(reply.choice).toBe('request_help');
      else expect(reply.choice).toMatch(/^reply/);
      npc.needs.hunger = 5;
      expect((await provider.decide(input())).choice).toBe('defer:eat:tavern');
    }
  }
});
it('real evaluation adapter preserves invalid choice and reported cost without inventing response model',async()=>{
  vi.stubEnv('OPENROUTER_API_KEY','test-only');
  try{
    const fake=(async()=>Response.json({answers:{action:{type:'choice',choice:'unoffered'},reaction:{type:'choice',choice:'focused'}},usage:{cost:.004}})) as typeof fetch;
    const result=await jevProvider(fake).decide(developmentCases()[0].input);
    expect(result.choice).toBe('unoffered');expect(result.cost).toBe(.004);expect(result.model).toBeUndefined();expect(result.contractValid).toBe(true);
    expect(JSON.parse(result.rawContent!)).toEqual({answers:{action:{type:'choice',choice:'unoffered'},reaction:{type:'choice',choice:'focused'}},usage:{cost:.004}});
  }finally{vi.unstubAllEnvs();}
});
it('flags the full upstream contract as invalid while keeping model and billing',async()=>{
  vi.stubEnv('OPENROUTER_API_KEY','test-only');
  try{
    const input=developmentCases()[0].input;
    const result=await jevProvider((async()=>Response.json({model:'observed',answers:{action:{choice:input.options[0].id},reaction:{choice:'focused'}},usage:{cost:.001}})) as typeof fetch).decide(input);
    expect(result.contractValid).toBe(false);expect(result.cost).toBe(.001);expect(result.model).toBe('observed');
    expect(JSON.parse(result.rawContent!)).toMatchObject({model:'observed',usage:{cost:.001},answers:{action:{choice:input.options[0].id}}});
  }finally{vi.unstubAllEnvs();}
});

it('rule baseline accepts an available invitation when social need is pressing, while protecting urgent physical needs',async()=>{
  const {ruleProvider}=await import('../scripts/evaluation/providers');
  const {socialCases}=await import('../scripts/evaluation/social-cases');
  for(const scenario of socialCases()){
    const response=await ruleProvider.decide(scenario.input);
    expect(scenario.acceptableChoices,scenario.id).toContain(response.choice);
  }
});

it('shared social rules use visible delivery history and disposition rather than always accepting',async()=>{
  const {ruleProvider,utilityProvider}=await import('../scripts/evaluation/providers');
  const {prepareDeliveryCase}=await import('../scripts/evaluation/delivery-cases');
  const scenarios=[
    ['delivery/impatient/late_cold/repeated_broken/unexplained','refuse_delivery'],
    ['delivery/forgiving/late_cold/reliable/explained','receive_exact'],
    ['delivery/forgiving/late_cold/repeated_broken/unexplained','receive_reduced'],
    ['delivery/impatient/timely/reliable/unexplained','receive_tip'],
    ['delivery/impatient/timely/repeated_broken/unexplained','receive_exact'],
  ];
  for(const provider of [ruleProvider,utilityProvider])for(const [id,choice] of scenarios){
    const {scenario}=prepareDeliveryCase(id);
    expect((await provider.decide(scenario.input)).choice).toBe(choice);
  }
});
