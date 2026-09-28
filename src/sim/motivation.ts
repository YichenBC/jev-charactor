import { canRewardDialogue } from '../character/dialogue';
import { ordinaryResponses } from './dialogue';
import { inspectPersonal } from '../character/personal';
/** Derived game adapter: own pressures and consequences, without hidden neighbors or scores. */
import type { ActionForecast, Drive } from '../character/motivation';
import { BUILDINGS } from './data';
import { clamp, distance, route } from './navigation';
import { npcJobPlan } from './npcLife';
import { FOOD, isFood } from './survival';
import type { ActionOption, Npc, Point, World } from './types';

export function getNpcMotivation(world: World, npc: Npc, options: ActionOption[] = []): {drives: Drive[]; forecasts: ActionForecast[]} {
  const drives: Drive[] = [
    {id:'hunger',label:'饥饿',pressure:clamp(100-npc.needs.hunger),evidence:`自身饱腹 ${npc.needs.hunger.toFixed(1)}/100`},
    {id:'energy',label:'疲劳',pressure:clamp(100-npc.needs.energy),evidence:`自身体力 ${npc.needs.energy.toFixed(1)}/100`},
    {id:'social',label:'想与人交流',pressure:clamp(100-npc.needs.social),evidence:`自身社交满足 ${npc.needs.social.toFixed(1)}/100`},
    {id:'workPressure',label:'待办事务',pressure:clamp(npc.needs.workPressure),evidence:`自身事务压力 ${npc.needs.workPressure.toFixed(1)}/100`},
  ];
  for(const goal of inspectPersonal(npc.mind,world.time).goals.filter(g=>!g.completed)) {
    const weight=npc.mind.personal.preferences.find(p=>p.activity===goal.activity)?.weight??1;
    drives.push({id:`goal:${goal.id}`,label:goal.label,pressure:30*weight*(goal.target-goal.progress)/goal.target,evidence:`实际完成 ${goal.progress}/${goal.target}；个人偏好权重 ${weight}`});
  }
  return {drives,forecasts:forecastNpcActions(world,npc,options)};
}

function travelSeconds(npc: Npc, path: Point[]): number {
  let previous:Point=npc, length=0;
  for(const point of path){length+=distance(previous,point);previous=point;}
  return length/50;
}

export function forecastNpcActions(world: World, npc: Npc, options: ActionOption[]): ActionForecast[] {
  return options.flatMap(option => {
    const id=option.id.replace(/^defer:/,''), effects:Record<string,number>={};
    let durationSeconds=0, effort=0;
    const notes:string[]=['Effects are gross pressure relief at completion; ongoing natural need decay is separate. Positive effects reduce pressure.'];
    const gain=(key:'hunger'|'energy'|'social',amount:number)=>{effects[key]=Math.min(100-npc.needs[key],amount);};
    if(option.kind==='npc_job'||option.kind==='defer'||id==='work'){
      const plan=npcJobPlan(world,npc,{...option,id});
      if(!plan)return [];
      durationSeconds=travelSeconds(npc,plan.path)+plan.duration;
      effort=plan.kind==='work'?8:0;
      if(plan.kind==='eat'){gain('hunger',48);gain('energy',4);}
      if(plan.kind==='rest')gain('energy',plan.place?.id==='home'?42:24);
      if(plan.kind==='social'){gain('social',30);notes.push('Conditional on the partner independently accepting after arrival and remaining nearby. They may decline or defer; no private partner state is assumed.');}
      if(plan.kind==='work'){effects.workPressure=Math.min(npc.needs.workPressure,35);effects.energy=-Math.min(npc.needs.energy,8);}
      if(plan.kind==='hobby'){effects.energy=-Math.min(npc.needs.energy,4);effort=4;}
      for(const goal of inspectPersonal(npc.mind,world.time).goals.filter(g=>!g.completed&&g.activity===plan.kind)){
        const preference=npc.mind.personal.preferences.find(p=>p.activity===goal.activity);
        effects[`goal:${goal.id}`]=30*(preference?.weight??1)/goal.target;
        notes.push(`Only completion advances personal plan: ${goal.label} (${goal.progress}/${goal.target}). Preference: ${preference?.label??'ordinary'}.`);
      }
      notes.push(`Reachable route at 50 pixels/second, then ${plan.duration} uninterrupted seconds. No gain until completion.`);
    }else if(id==='social:accept'){
      durationSeconds=8;gain('social',30);
      for(const goal of inspectPersonal(npc.mind,world.time).goals.filter(g=>!g.completed&&g.activity==='social')){
        const weight=npc.mind.personal.preferences.find(p=>p.activity==='social')?.weight??1;effects[`goal:${goal.id}`]=30*weight/goal.target;
      }
      notes.push('Your own explicit acceptance starts a public conversation. Benefits only after eight uninterrupted seconds for both participants.');
    }else if(option.kind==='move'){
      let target:Point|undefined;
      if(id.startsWith('visit:'))target=BUILDINGS.find(b=>b.id===option.target)?.door;
      else if(id==='follow')target=world.player;
      else if(id==='avoid')target=[...BUILDINGS].sort((a,b)=>distance(world.player,b.door)-distance(world.player,a.door))[0]?.door;
      else target=world.npcs.find(n=>n.id===option.target);
      if(!target)return [];
      const path=distance(npc,target)>2?route(npc,target):[];
      if(distance(npc,target)>2&&!path.length)return [];
      durationSeconds=travelSeconds(npc,path);
      notes.push('Travel alone restores no needs.');
    }else if(id==='accept_gift'){
      const selected=npc.pendingAction?.parameters.item;
      const item=typeof selected==='string'&&isFood(selected)&&world.player.inventory.includes(selected)?selected:undefined;
      if(item){gain('hunger',FOOD[item].hunger);gain('energy',FOOD[item].energy);notes.push(`Immediately consumes the offered ${item}, once.`);}
    }else if(id.startsWith('receive_')){
      gain('hunger',FOOD['热饭'].hunger);gain('energy',FOOD['热饭'].energy);notes.push('Accepts and immediately eats this delivery once.');
    }else if(id==='reply'||id.startsWith('reply:')){
      if(npc.trust>=0 && canRewardDialogue(npc.mind,world.time) && (npc.pendingInteraction==='greet'||npc.pendingInteraction==='ask') && ordinaryResponses(npc,npc.pendingInteraction,npc.knownFacts.includes('met-player'),world.time,world).find(r=>r.id===id)?.rewardEligible) gain('social',8);
      notes.push('A substantive ordinary reply at nonnegative trust restores up to 8 social satisfaction at most once per 120 simulation seconds; repetition acknowledgements, guarded replies, refusals and deferrals do not.');
    }else if(id==='accept_help'){
      durationSeconds=12;effects.workPressure=Math.min(npc.needs.workPressure,20);notes.push('Only after the player completes all twelve seconds of help.');
    }
    return [{id:option.id,durationSeconds,effort,effects,notes}];
  });
}
