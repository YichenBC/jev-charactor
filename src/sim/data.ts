import type { Building, Interaction, Npc } from './types';
import { createMind, type CharacterProfile } from '../character';
import { learnKnowledge } from '../character/knowledge';
import { createNpcNeeds } from './npcLife';

export const WIDTH = 1536;
export const HEIGHT = 1152;
export const TILE = 48;
export const BUILDINGS: Building[] = [
  { id: 'shop', name: '舟记杂货', subtitle: '日用与人情', x: 240, y: 240, w: 240, h: 192, color: 0xaa7855, door: { x: 360, y: 456 } },
  { id: 'tavern', name: '晚风茶馆', subtitle: '一盏茶的工夫', x: 912, y: 240, w: 288, h: 192, color: 0x976755, door: { x: 1032, y: 456 } },
  { id: 'home', name: '梧桐小院', subtitle: '兄妹的家', x: 240, y: 768, w: 240, h: 192, color: 0x718c79, door: { x: 360, y: 744 } },
  { id: 'post', name: '青石驿站', subtitle: '寄往远方', x: 912, y: 768, w: 240, h: 192, color: 0x778f9d, door: { x: 1032, y: 744 } },
  { id: 'watch', name: '临水亭', subtitle: '听潮看人', x: 1152, y: 528, w: 192, h: 144, color: 0x748d86, door: { x: 1224, y: 696 } },
];
export const INTERACTIONS: { id: Interaction; label: string; description: string }[] = [
  { id: 'greet', label: '打个招呼', description: '随口聊聊，彼此认识。' },
  { id: 'ask', label: '问问近况', description: '听对方愿意说的心事。' },
  { id: 'request', label: '询问临时工作', description: '先问清楚工作和报酬。' },
  { id: 'decline', label: '婉拒这份工作', description: '不接当前提议，不建立承诺。' },
  { id: 'help', label: '提出帮忙', description: '看看有没有能搭把手的事。' },
  { id: 'gift', label: '送点吃喝', description: '从背包中送出一份心意。' },
  { id: 'promise', label: '许下承诺', description: '答应下次帮忙，对方会记得。' },
  { id: 'expose', label: '提起秘密', description: '只能提起你亲耳得知的秘密。' },
  { id: 'apologize', label: '诚恳道歉', description: '为曾经的不妥表达歉意。' },
  { id: 'deliver', label: '交付这份外卖', description: '把对应订单的餐品交给收件人，等待验收和结算。' },
  { id: 'explain', label: '解释配送耽搁', description: '解释刚才的延误；居民会结合经历决定是否接受。' },
];

export const PROFILES: Record<string, CharacterProfile> = {
  lin: { role: 'Shopkeeper', traits: ['cautious with strangers', 'values reliable work', 'protective', 'patient when given an honest explanation'], values: ['keeping promises', 'family privacy', 'fair payment for real work'], speakingStyle: 'Brief practical sentences, warms up with earned trust.' },
  tang: { role: 'Young adult artist', traits: ['curious', 'generous', 'forgiving of honest mistakes', 'dislikes gossip'], values: ['kindness', 'family', 'freedom'], speakingStyle: 'Warm concrete observations, expressive but not verbose.' },
  mei: { role: 'Restaurant owner', traits: ['practical', 'assertive', 'respects effort', 'cares about repeat business'], values: ['honest transactions', 'food quality', 'reliability'], speakingStyle: 'Direct friendly business talk, clear offers and conditions.' },
  lan: { role: 'Busy courier', traits: ['impatient when deadlines are missed', 'punctual', 'anxious under pressure', 'respects demonstrated reliability'], values: ['time', 'professional promises', 'accurate delivery'], speakingStyle: 'Short brisk sentences; explains what is needed now.' },
  zhou: { role: 'Retired watchman', traits: ['patient', 'forgiving', 'observant', 'skeptical of empty promises'], values: ['care for neighbors', 'honesty', 'quiet routine'], speakingStyle: 'Calm plain speech, kindness expressed in practical acts.' },
};

/** Upgrade authored legacy identity text without treating changing debt as personality. */
export function stableIdentity(npc: Pick<Npc, 'persona' | 'goal'>): Pick<Npc, 'persona' | 'goal'> {
  return {
    persona: npc.persona.replace('Lin owes her money; she keeps this private and does not shame him.', 'Respects customers’ privacy and avoids shaming neighbors.'),
    goal: npc.goal.replace('Keep the shop running and quietly repay Mei.', 'Keep the shop running and honor obligations supported by current knowledge.')
      .replace('Welcome customers and arrange repayment privately.', 'Welcome customers and handle known business obligations discreetly.'),
  };
}

export const SECRET_FACTS: Record<string, { id: string; text: string }> = {
  lin: { id: 'lin-debt', text: '林舟欠梅姐一笔货款，一直没敢告诉妹妹阿棠。' },
  mei: { id: 'lin-debt', text: '林舟欠梅姐一笔货款，一直没敢告诉妹妹阿棠。' },
  lan: { id: 'lan-letter', text: '阿岚曾遗失一封给家人的信，当时很担心被人责怪。' },
};

export const FACT_LABELS: Record<string, string> = {
  'lin-debt': SECRET_FACTS.lin.text,
  'lan-letter': SECRET_FACTS.lan.text,
  'met-player': '已经和玩家认识。',
  'confided-to-player': '曾向玩家倾诉自己的秘密，并请对方保密。',
  'player-helped-me': '玩家曾经帮过我的忙。',
  'player-promised-help': '玩家承诺日后会来帮忙。',
  'promise-kept': '玩家兑现了先前的帮忙承诺。',
  'hurt-by-player': '玩家公开提起私事，让我感到受伤。',
  'apology-accepted': '我接受了玩家的道歉，信任仍需要时间修复。',
  'lan-letter-recovered': '在玩家的帮助下，阿岚已经找回那封遗失的信。',
  'tang-knows-debt': '我亲眼看见阿棠在场，听到了玩家公开说起林舟的欠款。',
};
export function describeFact(id: string): string {
  if (id.startsWith('heard-public:')) return `曾亲耳听见玩家在街上说起：${FACT_LABELS[id.slice('heard-public:'.length)] ?? '一件私事'}`;
  return FACT_LABELS[id] ?? id;
}

export const DIALOGUE: Record<string, { first: string; friendly: string; guarded: string; refuse: string; request: string; done: string; gift: string }> = {
  lin: { first: '新面孔呀，我是林舟。缺针线盐米，就来舟记找我。', friendly: '又见面了！铺子里刚收拾好，来坐会儿？', guarded: '铺子还有账要理，今天先不聊了。', refuse: '谢你的好意，铺子这点事我先自己张罗。', request: '货架上几箱日用品还没归位，得空帮我理一理吧？', done: '你整理的货架清清楚楚，今天终于能早些打烊。', gift: '你送的那份还惦记着呢，吃喝留给自己吧。' },
  tang: { first: '你好！我叫阿棠，正找一个画晚霞的好角度。', friendly: '你来得正好，看看我今天画的这片晚霞！', guarded: '我想安静画一会儿，有些话还没想明白。', refuse: '谢谢啦，这一笔我想自己慢慢画完。', request: '风把画纸吹乱了，能帮我收一收画具吗？', done: '画具都收妥了，多亏你！下回给你看新画。', gift: '上次那份心意我收到了，别把自己的点心都送掉呀。' },
  mei: { first: '客人好，我是梅姐。走累了，晚风茶馆有热茶。', friendly: '熟客来了，今天想喝清茶还是听听街坊闲话？', guarded: '茶还烫着，话也先放凉些再说吧。', refuse: '承你的情，茶馆的事我心里有数，先让我忙完。', request: '茶客刚散，愿意帮我擦一擦靠窗那张茶桌吗？', done: '茶桌擦得亮堂堂的，你坐着歇脚就好。', gift: '茶馆不缺吃喝，你的那份好意我已经记下了。' },
  lan: { first: '你好，我是阿岚，驿站送信的。今天脚步有点乱。', friendly: '是你呀！忙里见到熟人，赶路也轻快些。', guarded: '我还要赶路，今天先让我静一静。', refuse: '谢谢，我先自己把这一路再走一遍。', request: '今天待送的信件还没分好，能帮我整理一下吗？', done: '信件分好了，送信能准点出发。这次真谢谢你。', gift: '路上有你送过的心意就够了，这份留着自己吃。' },
  zhou: { first: '小友好，我是老周。沿岸慢些走，石阶上有潮气。', friendly: '又来听潮了？今天河面比昨天平静。', guarded: '有些话随风一吹就收不回了，让我清静一会儿吧。', refuse: '心意领了，这点岸边杂事，老头子还做得动。', request: '岸边落叶积了一堆，搭把手扫扫，过路人走着也稳当。', done: '岸边清爽多了，咱们坐亭里看看水就好。', gift: '吃喝够用了，你记得关照自己，老头子就高兴。' },
};

export function initialNpcs(): Npc[] {
  const people = [
    { id: 'lin', name: '林舟', role: '杂货铺掌柜', color: '#d99661', x: 792, y: 600, persona: 'A kind but guarded shopkeeper, protective of younger sister Tang. Use current known facts and memories as the authority on relationships and who knows what.', goal: 'Keep the shop running and quietly repay Mei.', mood: '有些心事', secret: SECRET_FACTS.lin.text },
    { id: 'tang', name: '阿棠', role: '爱画画的妹妹', color: '#e8b36c', x: 648, y: 504, persona: 'Curious young adult artist, Lin’s younger sister. Relies on her own memories and public observations. Never invent knowledge of private matters.', goal: 'Sketch the waterfront and meet friendly neighbors.', mood: '好奇', secret: '' },
    { id: 'mei', name: '梅姐', role: '茶馆老板娘', color: '#b283ac', x: 1008, y: 504, persona: 'Practical, warm tavern owner. Lin owes her money; she keeps this private and does not shame him.', goal: 'Welcome customers and arrange repayment privately.', mood: '从容', secret: SECRET_FACTS.mei.text },
    { id: 'lan', name: '阿岚', role: '驿站送信人', color: '#79a7c3', x: 888, y: 696, persona: 'An earnest courier who takes personal letters and promises seriously. Use current known facts and memories for resolved problems and information learned from neighbors.', goal: 'Sort letters at the post station and deliver them punctually.', mood: '焦急', secret: SECRET_FACTS.lan.text },
    { id: 'zhou', name: '老周', role: '临水亭守望人', color: '#9aab7c', x: 1224, y: 744, persona: 'Observant retired watchman. Talks about public activity and the weather, never guesses anyone’s private secrets.', goal: 'Watch the river and offer public directions.', mood: '平静', secret: '' },
  ];
  return people.map((person) => {
    const mind = createMind(PROFILES[person.id]);
    for (const building of BUILDINGS) learnKnowledge(mind, {
      id: `background:place:${building.id}`, topic: `place:${building.id}`,
      value: `${building.name}：${building.subtitle}。入口位于 (${building.door.x}, ${building.door.y})。`,
      learnedAt: 0, source: { kind: 'background' }, confidence: 1,
    });
    const fact = SECRET_FACTS[person.id];
    if (fact) learnKnowledge(mind, {
      id: `fact:${fact.id}:experienced`, topic: fact.id, value: fact.text,
      learnedAt: 0, source: { kind: 'experienced' }, confidence: 1,
    });
    return { ...person, ...stableIdentity(person), knownFacts: SECRET_FACTS[person.id] ? [SECRET_FACTS[person.id].id] : [], memories: [], trust: 0, activity: '在广场歇脚', lastDecision: '刚来到街区', revision: 0, cooldown: .5 + people.findIndex(p => p.id === person.id) * .4, path: [], mind, needs: createNpcNeeds(person.id), job: null };
  });
}
