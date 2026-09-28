import { describe, it, expect } from 'vitest';
import { createMind } from '../src/character';
import { addFeeling, addGoal, advanceGoal, inspectPersonal } from '../src/character/personal';
const mind=()=>createMind({role:'Reader',traits:[],values:[],speakingStyle:'plain'});
describe('portable personal life',()=>{
  it('retains an event feeling while its influence fades, without changing expression',()=>{
    const m=mind();
    const feeling={id:'meal-1',label:'A good meal',basis:'meal completed',valence:1,strength:.8,since:0,until:100};
    expect(addFeeling(m,feeling)).toBe(true);
    expect(addFeeling(m,feeling)).toBe(false);
    expect(inspectPersonal(m,50).feelings[0].influence).toBeCloseTo(.4);
    expect(inspectPersonal(m,100).feelings).toEqual([]);
    expect(m.affect).toBe('focused');
  });
  it('advances goals only from distinct valid completed events and never reopens completion',()=>{
    const m=mind();
    addGoal(m,{id:'read',label:'Read two chapters',activity:'reading',target:2,createdAt:10});
    expect(advanceGoal(m,'read',{id:'chapter1',at:11})).toBe(true);
    expect(advanceGoal(m,'read',{id:'chapter1',at:12})).toBe(false);
    expect(advanceGoal(m,'read',{id:'chapter2',at:13})).toBe(true);
    expect(advanceGoal(m,'read',{id:'chapter3',at:14})).toBe(false);
    expect(m.personal.goals[0].completedAt).toBe(13);
    expect(inspectPersonal(m,12).goals[0].progress).toBe(1);
  });
  it('rejects invalid chronology without partial mutations',()=>{
    const m=mind();addGoal(m,{id:'g',label:'g',activity:'work',target:2,createdAt:10});
    const before=JSON.stringify(m);
    expect(()=>advanceGoal(m,'g',{id:'bad',at:9})).toThrow();
    expect(()=>addFeeling(m,{id:'bad',label:'bad',basis:'event',valence:1,strength:1,since:10,until:9})).toThrow();
    expect(JSON.stringify(m)).toBe(before);
  });
  it('bounds feelings and rejects excess goals rather than silently losing active goals',()=>{
    const m=mind();
    for(let i=0;i<20;i++)addFeeling(m,{id:`f${i}`,label:'felt',basis:'event',valence:-1,strength:.5,since:i,until:i+10});
    expect(m.personal.feelings).toHaveLength(12);
    for(let i=0;i<8;i++)addGoal(m,{id:`g${i}`,label:'goal',activity:'act',target:2,createdAt:0});
    expect(()=>addGoal(m,{id:'overflow',label:'goal',activity:'act',target:2,createdAt:0})).toThrow();
    expect(m.personal.goals).toHaveLength(8);
  });
});
