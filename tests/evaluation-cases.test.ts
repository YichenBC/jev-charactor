import {describe,it,expect} from 'vitest';
import {developmentCases,prepareDevelopmentCase,verifyExecution} from '../scripts/evaluation/cases';
import {ruleProvider,utilityProvider} from '../scripts/evaluation/providers';
import {decisionInput} from '../server/jev';
import {loadWorld,serializeWorld} from '../src/sim';

describe('development evaluation cases',()=>{
  it('builds reproducible distinct development fixtures with current legal alternatives',()=>{
    const cases=developmentCases();expect(cases.length).toBe(24);
    expect(cases).toEqual(developmentCases());expect(new Set(cases.map(c=>c.id)).size).toBe(cases.length);
    for(const c of cases){
      expect(c.split).toBe('development');expect(decisionInput.safeParse(c.input).success).toBe(true);
      expect(c.acceptableChoices.length).toBeGreaterThan(0);
      expect(c.acceptableChoices.every(id=>c.input.options.some(o=>o.id===id))).toBe(true);
      expect(c.input.state).not.toHaveProperty('acceptableChoices');
      const state=c.input.state.situation as Record<string,unknown>;
      expect(state).not.toHaveProperty('options');
      expect(loadWorld(serializeWorld(prepareDevelopmentCase(c.id).world))).not.toBeNull();
    }
  });
  it('baselines consume only visible input and are independent of candidate order',async()=>{
    for(const c of developmentCases())for(const p of [ruleProvider,utilityProvider]){
      const before=JSON.stringify(c.input),a=await p.decide(c.input),b=await p.decide({...c.input,options:[...c.input.options].reverse()});
      expect(a.choice).toBe(b.choice);expect(c.input.options.some(o=>o.id===a.choice)).toBe(true);
      expect(JSON.stringify(c.input)).toBe(before);
    }
  });
  it('replays actual consequences, distinguishes speech from execution, and rejects invented choices',()=>{
    const cases=developmentCases();const plan=cases.find(c=>c.tags.includes('plan'))!;
    const reply=verifyExecution(plan.id,'reply:goal','focused');
    expect(reply.applied).toBe(true);expect(reply.validSave).toBe(true);expect(reply.text).toContain('打算');
    expect(reply.goalProgressChanged).toBe(false);expect(reply.moneyDelta).toBe(0);
    expect(verifyExecution(plan.id,'invented','focused').applied).toBe(false);
    const hungry=cases.find(c=>c.tags.includes('hungry')&&!c.tags.includes('conversation'))!;
    const eat=verifyExecution(hungry.id,'eat:tavern','focused');
    expect(eat.applied).toBe(true);expect(eat.selectedActivityCompleted).toBe(true);expect(eat.needsAfter.hunger).toBeGreaterThan(eat.needsBefore.hunger);
  });
});

describe('replayed activity evidence',()=>{
  it('distinguishes immediate speech effects from goal progress after work completes',()=>{
    const result=verifyExecution('mei/overworked','work','focused');
    expect(result.immediateGoalProgressChanged).toBe(false);
    expect(result.selectedActivityCompleted).toBe(true);
    expect(result.goalProgressChanged).toBe(true);
  });
});
