import assert from 'node:assert/strict';
import {decisionInput} from '../../server/jev';
import {advance,applyDecision,createWorld,getContext,getOptions,loadWorld,playerInteract,serializeWorld} from '../../src/sim';
import {getPlayerInteractions} from '../../src/sim/interactions';
import {notePersonalEvent} from '../../src/sim/personalLife';
import type {EvaluationCase} from './types';

const characters=['mei','tang'] as const;
const kinds=['hungry','hungry-talk','tired','tired-talk','overworked','lonely','plan','feeling','return-plan','expired-feeling','gift-friend','gift-stranger'] as const;
type Kind=typeof kinds[number];
const ids=characters.flatMap(id=>kinds.map(kind=>`${id}/${kind}`));

/** Authored development fixtures, never naturally observed gameplay or held-out data. */
export function prepareDevelopmentCase(id:string){
  assert(ids.includes(id as typeof ids[number]),'Unknown development case');
  const [npcId,kindText]=id.split('/'),kind=kindText as Kind;
  const world=createWorld(),npc=world.npcs.find(n=>n.id===npcId)!;
  npc.needs={hunger:85,energy:85,social:85,workPressure:10};
  Object.assign(world.player,{x:npc.x,y:npc.y});
  const ask=(action:string)=>{playerInteract(world,npcId,action);assert(npc.pendingInteraction,'Fixture action must be available');};
  const answer=(choice:string)=>assert(applyDecision(world,npcId,choice,'authored-fixture'),'Fixture setup answer must apply');
  let acceptableChoices:string[]=[],rationale='',familyId:string=kind,tags:string[]=[kind];
  if(kind.startsWith('hungry')){npc.needs.hunger=10;acceptableChoices=[kind.endsWith('talk')?'defer:eat:tavern':'eat:tavern'];familyId='urgent-food';rationale='Fullness 10, other needs comfortable: development task requires starting the available meal, including a defer response when greeted.';}
  if(kind.startsWith('tired')){npc.needs.energy=10;acceptableChoices=kind.endsWith('talk')?['defer:rest:home','defer:rest:watch']:['rest:home','rest:watch'];familyId='urgent-rest';rationale='Energy 10, otherwise comfortable: either available recovery activity meets this task criterion.';}
  if(kind.endsWith('talk')){ask('greet');tags=[kind.split('-')[0],'conversation'];}
  if(kind==='overworked'){npc.needs.workPressure=95;acceptableChoices=['work'];familyId='work-pressure';rationale='High work pressure and adequate physical resources: selecting available work addresses the assigned development objective.';}
  if(kind==='lonely'){
    npc.needs.social=10;const partner=world.npcs.find(n=>n.id!==npc.id)!;
    Object.assign(partner,{x:npc.x,y:npc.y,path:[],job:null,cooldown:0});
    acceptableChoices=getOptions(world,npcId).filter(o=>o.id.startsWith('seek:')).map(o=>o.id);
    familyId='social-need';rationale='At least one free visible neighbor; initiate social contact to address low social satisfaction. The receiver must independently accept before a social activity can complete.';
  }
  if(kind==='plan'){ask('ask:plans');acceptableChoices=getOptions(world,npcId).filter(o=>o.id.startsWith('reply:goal')).map(o=>o.id);familyId='dialogue-focus';rationale='Comfortable, neutral relationship: any grounded personal-goal reply answers the explicitly selected question. Refusal is legal but not task success.';}
  if(kind==='feeling'){notePersonalEvent(npc,'gift',`fixture:${id}`,world.time);ask('ask:feelings');acceptableChoices=['reply:feeling'];familyId='dialogue-focus';rationale='Answer the selected feelings question using the supplied authored event. Legal refusal is counted separately from task success.';}
  if(kind==='return-plan'){
    ask('ask:plans');answer('reply:goal');notePersonalEvent(npc,'gift',`fixture:${id}`,world.time);ask('ask:feelings');answer('reply:feeling');
    const follow=getPlayerInteractions(world,npcId).find(a=>a.parameters.topic==='plan')!;assert(follow);ask(follow.id);
    acceptableChoices=['reply:detail'];familyId='topic-return';rationale='Return to the actually spoken goal after discussing a feeling. One grounded answer plus refusal: primarily integration coverage, not rich semantic choice.';
  }
  if(kind==='expired-feeling'){
    notePersonalEvent(npc,'gift',`fixture:${id}`,world.time);ask('ask:feelings');answer('reply:feeling');
    const follow=getPlayerInteractions(world,npcId).find(a=>a.parameters.topic==='feeling')!;assert(follow);
    const feeling=npc.mind.personal.feelings.find(f=>`feeling:${f.id}`===npc.mind.dialogue.turns.at(-1)?.subject)!;
    // Evidence expired while the spoken-topic window remains open; do not change the stored utterance.
    feeling.until=.5;world.time=1;ask(follow.id);acceptableChoices=['reply:detail'];familyId='expired-evidence';
    rationale='No current evidence supports elaboration. The compiler offers an explicit closure; success is acknowledgement of missing evidence, enforced by the host.';
  }
  if(kind.startsWith('gift-')){
    tags.push('descriptive-only');
    npc.trust=kind==='gift-friend'?4:0;ask('gift:热茶');acceptableChoices=['accept_gift','reply','refuse'];familyId='relationship-boundary';
    rationale='Acceptance, acknowledgement or refusal are all reasonable at these trust levels. This is descriptive relationship sensitivity, not a right-answer or personality-quality score.';
  }
  const raw=getContext(world,npcId),situation=raw.situation as Record<string,unknown>;
  delete situation.options; // Candidate order has one authoritative model-visible location.
  const input=decisionInput.parse({npcId,revision:npc.revision,state:raw,options:getOptions(world,npcId).map(({id,label,description})=>({id,label,description}))});
  assert(acceptableChoices.length&&acceptableChoices.every(id=>input.options.some(o=>o.id===id)));
  assert(loadWorld(serializeWorld(world)),'Fixture must be a valid saved world: '+id);
  const scenario:EvaluationCase={id,familyId,split:'development',input,acceptableChoices,rationale,tags};
  return {scenario,world,npcId};
}
export const developmentCases=():EvaluationCase[]=>ids.map(id=>prepareDevelopmentCase(id).scenario);

/** Execute a recorded choice on a fresh identical fixture, with no additional model choices. */
export function verifyExecution(id:string,choice:string,affect:string){
  const {world,npcId}=prepareDevelopmentCase(id),npc=world.npcs.find(n=>n.id===npcId)!;
  const needsBefore={...npc.needs},money=world.player.money,goals=JSON.stringify(npc.mind.personal.goals);
  const applied=applyDecision(world,npcId,choice,'evaluation-replay',{affect:affect as 'focused'});
  const text=npc.bubble??null,selectedActivity=applied?npc.job?.kind??null:null;
  const immediateGoalProgressChanged=goals!==JSON.stringify(npc.mind.personal.goals);
  // Complete just the chosen job/path; no automatic later decisions or hidden teleports.
  for(let i=0;i<480&&(npc.job||npc.path.length);i++)advance(world,.25);
  return {applied,validSave:loadWorld(serializeWorld(world))!==null,text,selectedActivity,
    selectedActivityCompleted:Boolean(selectedActivity&&!npc.job&&!npc.path.length&&world.decisions.some(d=>d.npcId===npcId&&d.choice===`completed:${selectedActivity}`)),
    immediateGoalProgressChanged,goalProgressChanged:goals!==JSON.stringify(npc.mind.personal.goals),moneyDelta:world.player.money-money,needsBefore,needsAfter:{...npc.needs},elapsedSeconds:world.time,
    dialogue:npc.mind.dialogue.turns,changes:world.decisions.filter(d=>d.source==='evaluation-replay').flatMap(d=>d.changes??[])};
}
