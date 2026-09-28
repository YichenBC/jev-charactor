import type { inspectPersonal } from '../character/personal';
import type { Npc } from './types';

export type DialogueGoal = ReturnType<typeof inspectPersonal>['goals'][number];

/** Four host-authored goal definitions. Methods are ideas, never observations or receipts. */
export const AUTHORED_PLAN_PROFILES = [
  {
    npcId: 'mei', goalId: 'personal-interest', label: '试想三份茶点搭配', activity: 'hobby',
    subject: '这阵子想琢磨几份茶点搭配，给茶馆添点新意。',
    method: '我想先比较茶味的浓淡和点心的轻重：茶味清些时，点心也别太抢味。先想清楚一组搭配，再慢慢调整。',
    reason: '茶馆不能只顾着忙呀。我喜欢琢磨茶和点心怎么配，想给自己留点尝试的工夫。',
  },
  {
    npcId: 'mei', goalId: 'personal-routine', label: '把两次茶馆事务处理妥当', activity: 'work',
    subject: '这阵子打算把茶馆的事务一件件理顺。',
    method: '想先把一份事务的内容和分工说清楚，免得安排混在一起。',
    reason: '茶馆的事一件件办妥，我才放心得下。把安排说清楚、把手上的活做好，比嘴上答应得漂亮更要紧。',
  },
  {
    npcId: 'tang', goalId: 'personal-interest', label: '积累三幅水边速写', activity: 'hobby',
    subject: '这阵子想攒几幅水边速写，留住自己喜欢的光。',
    method: '我想先挑水面的一小块来观察，试着只画明暗，再考虑添颜色。先把自己想看的地方找准。',
    reason: '我想给自己留一点认真观察水边的时间。我期待的是，画的时候能发现一点以前没注意到的东西。',
  },
  {
    npcId: 'tang', goalId: 'personal-routine', label: '和街坊认真聊两次日常', activity: 'social',
    subject: '这阵子想找街坊聊聊，听听大家眼里的日常。',
    method: '想找个有空的街坊，先问问对方平时留意街上的什么；如果对方愿意聊，再听听跟我不同的看法。',
    reason: '我喜欢画画，也想听听街坊眼里的日常。同一条街，每个人注意到的东西都不一样；不过得等人家有空，不能拉住忙着的人说个不停。',
  },
] as const;

export function authoredPlanProfile(npc: Npc, goal: Pick<DialogueGoal, 'id' | 'label' | 'activity'>) {
  return AUTHORED_PLAN_PROFILES.find(profile => profile.npcId === npc.id &&
    profile.goalId === goal.id && profile.label === goal.label && profile.activity === goal.activity);
}
