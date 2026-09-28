import { describe, expect, it } from 'vitest';
import { createMind, buildDecisionContext, mindSchema } from '../src/character';
import { inspectBelief, inspectKnowledge, knowledgeSchema, learnKnowledge, type KnowledgeClaim } from '../src/character/knowledge';
const mind = () => createMind({ role: 'Researcher', traits: ['careful'], values: ['evidence'], speakingStyle: 'Plain.' });
const claim = (id='seen', value='empty', learnedAt=1): Omit<KnowledgeClaim,'retiredAt'> => ({ id, topic: 'pantry', value, learnedAt, source: {kind:'observed'}, confidence:.9 });

describe('portable knowledge ledger', () => {
  it('records detached provenance without importing world truth or updating other minds', () => {
    const a=mind(), b=mind(), input=claim();
    expect(learnKnowledge(a,input)).toBe(true);input.value='caller mutation';
    expect(inspectBelief(a,'pantry',1)).toMatchObject({status:'known',values:['empty'],evidence:[{source:{kind:'observed'},confidence:.9,status:'current'}]});
    expect(inspectBelief(b,'pantry',1)).toMatchObject({status:'unknown',values:[],evidence:[]});
    expect(a.revision).toBe(1);expect(a.experiences).toEqual([]);
  });
  it('does not rewrite retained identities or apply new retirement instructions on replay', () => {
    const a=mind();learnKnowledge(a,claim());learnKnowledge(a,claim('other','stocked',2));const before=structuredClone(a);
    expect(learnKnowledge(a,{...claim(),value:'changed'},['other'])).toBe(false);
    expect(a).toEqual(before);
  });
  it('preserves conflicting testimony instead of promoting certainty to world truth', () => {
    const a=mind();learnKnowledge(a,claim());
    learnKnowledge(a,{...claim('report','stocked',2),source:{kind:'heard',from:'colleague'},confidence:1});
    expect(inspectBelief(a,'pantry',2)).toMatchObject({status:'conflicted',values:['empty','stocked']});
    expect(inspectBelief(a,'pantry',2).evidence[1].source).toEqual({kind:'heard',from:'colleague'});
  });
  it('lets the host explicitly retire conflicting evidence after checking, preserving its history', () => {
    const a=mind();learnKnowledge(a,claim());learnKnowledge(a,claim('report','stocked',2));
    learnKnowledge(a,claim('rechecked','empty',3),['seen','report']);
    expect(inspectBelief(a,'pantry',3)).toMatchObject({status:'known',values:['empty']});
    expect(inspectBelief(a,'pantry',3).evidence.map(e=>e.status)).toEqual(['retired','retired','current']);
    expect(inspectBelief(a,'pantry',2).status).toBe('conflicted');
    expect(inspectBelief(a,'pantry',2).evidence.every(entry=>entry.retiredAt===undefined)).toBe(true);
  });
  it('marks expiring evidence outdated at its deadline without erasing its source', () => {
    const a=mind();learnKnowledge(a,{...claim(),validUntil:5});
    expect(inspectBelief(a,'pantry',4).status).toBe('known');
    expect(inspectBelief(a,'pantry',5)).toMatchObject({status:'outdated',values:[],evidence:[{status:'expired',source:{kind:'observed'}}]});
  });
  it('never resurrects retired claims when the replacement expires', () => {
    const a=mind();learnKnowledge(a,claim());learnKnowledge(a,{...claim('new','stocked',2),validUntil:3},['seen']);
    expect(inspectBelief(a,'pantry',4).status).toBe('outdated');
  });
  it('excludes future information from queries and the model context', () => {
    const a=mind();learnKnowledge(a,claim('future-secret','hidden',10));
    expect(inspectKnowledge(a,9)).toEqual([]);
    expect(JSON.stringify(buildDecisionContext(a,{},9))).not.toContain('hidden');
    expect(inspectBelief(a,'pantry',10).values).toEqual(['hidden']);
  });
  it('builds detached classified context and requires an explicit clock for nonempty knowledge', () => {
    const a=mind();learnKnowledge(a,claim());
    expect(()=>buildDecisionContext(a,{})).toThrow();
    const context=buildDecisionContext(a,{},2);
    expect(context.knowledge).toMatchObject([{topic:'pantry',status:'known'}]);
    (context.knowledge as ReturnType<typeof inspectKnowledge>)[0].evidence[0].value='tampered';
    expect(a.knowledge[0].value).toBe('empty');
  });
  it('returns independent query results and rejects invalid query clocks', () => {
    const a=mind();learnKnowledge(a,claim());inspectBelief(a,'pantry',2).values.push('tampered');
    expect(inspectBelief(a,'pantry',2).values).toEqual(['empty']);
    for(const at of [NaN,Infinity,-1])expect(()=>inspectKnowledge(a,at)).toThrow();
  });
  it.each([
    {...claim(),confidence:2}, {...claim(),learnedAt:NaN}, {...claim(),validUntil:0},
    {...claim(),source:{kind:'heard'}}, {...claim(),source:{kind:'observed',from:'invented'}},
    {...claim(),retiredAt:5}, {...claim(),topic:' '},
  ])('rejects malformed updates atomically %j', input => {
    const a=mind(), before=structuredClone(a);
    expect(()=>learnKnowledge(a,input as never)).toThrow();expect(a).toEqual(before);
  });
  it('rejects unknown, cross-topic and backdated retirement before committing any change', () => {
    const a=mind();learnKnowledge(a,claim('seen','empty',3));learnKnowledge(a,{...claim('elsewhere'),topic:'weather'});
    const before=structuredClone(a);
    for(const [next,retire] of [[claim('new','stocked',4),['missing']],[claim('new','stocked',4),['elsewhere']],[claim('new','stocked',2),['seen']]] as const){
      expect(()=>learnKnowledge(a,next,[...retire])).toThrow();expect(a).toEqual(before);
    }
  });
  it('bounds working knowledge and evicts old retired evidence before current topics', () => {
    const a=mind();learnKnowledge(a,claim());learnKnowledge(a,claim('replacement','stocked',2),['seen']);
    for(let i=3;i<=65;i++)learnKnowledge(a,{...claim(`fact-${i}`,'yes',i),topic:`topic-${i}`});
    expect(a.knowledge).toHaveLength(64);expect(a.knowledge.some(e=>e.id==='seen')).toBe(false);
    expect(inspectBelief(a,'pantry',65)).toMatchObject({status:'known',values:['stocked']});
    expect(knowledgeSchema.safeParse(a.knowledge).success).toBe(true);
  });
  it('loads old minds with an empty ledger but rejects duplicate or invalid saved evidence', () => {
    const a=mind(), {knowledge: _removed,...legacy}=a;
    expect(mindSchema.parse(legacy).knowledge).toEqual([]);
    learnKnowledge(a,claim());expect(mindSchema.parse(a)).toEqual(a);
    expect(mindSchema.safeParse({...a,knowledge:[claim(),claim()]}).success).toBe(false);
    expect(mindSchema.safeParse({...a,knowledge:[{...claim(),retiredAt:0}]}).success).toBe(false);
  });
});
