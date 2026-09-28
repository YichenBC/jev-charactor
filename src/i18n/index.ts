import { UI_EN, UI_TEMPLATES } from './catalog-ui';
import { SIM_EN, SIM_TEMPLATES } from './catalog-sim';
import type { Npc } from '../sim';
import type { InteractionChoice } from '../character/interaction';

export type Locale = 'en' | 'zh';
export const LANGUAGE_KEY = 'fog-harbor-language';
let locale: Locale = 'en';
const listeners = new Set<() => void>();
const catalog = { ...SIM_EN, ...UI_EN };
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = Object.entries({ ...SIM_TEMPLATES, ...UI_TEMPLATES }).map(([source, target]) => {
  const slots: number[] = [];
  let cursor=0, pattern='';
  for (const match of source.matchAll(/\{(\d+)\}/g)) {
    pattern += escapeRegex(source.slice(cursor,match.index)) + '(.*?)';
    slots.push(Number(match[1])); cursor=match.index!+match[0].length;
  }
  pattern+=escapeRegex(source.slice(cursor));
  return { source, target, slots, regex: new RegExp(`^${pattern}$`, 'u') };
}).sort((a,b)=>b.source.replace(/\{\d+\}/g,'').length-a.source.replace(/\{\d+\}/g,'').length);
const cache = new Map<string,string>();
const fragments=Object.keys(catalog).filter(key=>key.length>=2).sort((a,b)=>b.length-a.length);
function spokenNumber(source: string): string | undefined {
  if(!/^[零一二两三四五六七八九十]{1,3}$/.test(source))return undefined;
  const digits: Record<string,number>={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(!source.includes('十'))return source.length===1?String(digits[source]):undefined;
  const [tens,units]=source.split('十');return String((tens?digits[tens]:1)*10+(units?digits[units]:0));
}
export const getLocale = () => locale;
export function setLocale(value: Locale): void {
  if (locale===value) return;
  locale=value;
  for (const listener of listeners) listener();
}
export function onLocaleChange(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function restoreLocale(storage: Pick<Storage,'getItem'>): void {
  try { setLocale(storage.getItem(LANGUAGE_KEY)==='zh'?'zh':'en'); } catch { setLocale('en'); }
}

/** Only authored exact strings and bounded compositions are translated. Never mutate the world. */
const resolutions=new Map<string,string|undefined>();
function english(source:string, depth=0): string | undefined {
  if(resolutions.has(source))return resolutions.get(source);
  if(depth>64)return undefined;
  const result=resolveEnglish(source,depth);
  if(resolutions.size>8000)resolutions.clear();
  resolutions.set(source,result);return result;
}
function resolveEnglish(source:string, depth:number): string | undefined {
  if (Object.hasOwn(catalog,source)) return catalog[source];
  if (!/[\u3400-\u9fff]/u.test(source)) return source;
  const trimmed=source.trim();
  if(trimmed!==source){const value=english(trimmed,depth+1);if(value!==undefined)return source.slice(0,source.indexOf(trimmed))+value+source.slice(source.indexOf(trimmed)+trimmed.length);}
  for (const template of templates) {
    const match=source.match(template.regex);
    if (!match) continue;
    const values = new Map<number,string>();
    let valid=true;
    template.slots.forEach((slot,index)=>{
      const value=match[index+1];
      const translated=english(value,depth+1)??(template.source.includes(`{${slot}}回`)?spokenNumber(value):undefined);
      if(translated===undefined)valid=false;
      values.set(slot,translated??value);
    });
    if(valid) return template.target.replace(/\{(\d+)\}/g,(_,slot:string)=>values.get(Number(slot))??'');
  }
  // Preserve each authored sentence's punctuation while matching catalog entries.
  for(const match of source.matchAll(/[。；]/gu)) {
    const end=match.index!+1;
    if(end===source.length)continue;
    const first=english(source.slice(0,end),depth+1);
    if(first===undefined)continue;
    const rest=english(source.slice(end),depth+1);
    if(rest!==undefined)return `${first} ${rest}`;
  }
  if(/^[。，；]/u.test(source)) {
    const rest=english(source.slice(1),depth+1);
    if(rest!==undefined)return ({'。':'. ','，':', ','；':'; '} as Record<string,string>)[source[0]]+rest;
  }
  for(const fragment of fragments) {
    if(source.startsWith(fragment)&&source.length>fragment.length && /[\u3400-\u9fff。；，]/u.test(source.slice(fragment.length))) {
      const rest=english(source.slice(fragment.length),depth+1);
      if(rest!==undefined)return `${catalog[fragment]}${/^[.,;:!?…]/u.test(rest)?'':' '}${rest}`;
    }
  }
  // UI punctuation, sentence boundaries and numeric effects are compositional.
  // Require every Chinese segment to be recognized: custom save prose stays literal.
  const edges=source.match(/^(\s*[◇◆☷Ⅱ▶?→←↑↓↗↘↙↖×\d]*\s*)(.*?)(\s*[→×…。]*\s*)$/su);
  if(edges && edges[2]!==source && edges[2]) {
    const middle=english(edges[2],depth+1); if(middle!==undefined)return edges[1]+middle+edges[3].replace(/。/g,'.');
  }
  for(const separator of ['\n',' · ','：','。','，','；',' / ',': ']) {
    if(!source.includes(separator))continue;
    const parts=source.split(separator);
    const translated=parts.map(part=>english(part,depth+1));
    if(translated.every(part=>part!==undefined))return translated.join(({ '：':': ','。':'. ','，':', ','；':'; ' } as Record<string,string>)[separator]??separator);
  }
  const count=source.match(/^(.*?)(\s*[+-]?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?\s*)$/u);
  if(count?.[1] && ['饱腹','体力','社交满足','事务压力','个人打算进展','尚可','迫切','在意','渐渐信赖','有所戒备','正在认识','已完成','进行中'].includes(count[1].trim())) { const label=english(count[1].trim(),depth+1); if(label!==undefined)return `${label} ${count[2].trim()}`; }
  return undefined;
}
export function translate(value: unknown, language: Locale = locale): string {
  const source=String(value??''); if(language==='zh')return source;
  const known=cache.get(source); if(known!==undefined)return known;
  const result=english(source)??source;
  if(cache.size>4000)cache.clear(); cache.set(source,result); return result;
}

/** Saved identities have a narrower boundary than authored prose templates. */
const authoredIdentities=new Set(['林舟','阿棠','梅姐','阿岚','老周','杂货铺掌柜','爱画画的妹妹','茶馆老板娘','驿站送信人','临水亭守望人']);
export function translateIdentity(value: unknown, language: Locale=locale): string {
  const source=String(value??'');
  return language==='en'&&authoredIdentities.has(source)?catalog[source]:source;
}

/** Translate objective prose while treating its explicit customer field as an identity. */
export function presentObjective<T extends {title:string;detail:string;label:string}>(task:T,deliveryCustomer?:string):T {
  const name=translateIdentity(deliveryCustomer);
  return {...task,
    title:deliveryCustomer===undefined?translate(task.title):locale==='en'?`Deliver the meal to ${name}`:`把外卖送给${name}`,
    label:deliveryCustomer===undefined?translate(task.label):locale==='en'?`${name} · Recipient`:`${name} · 收件人`,
    detail:translate(task.detail),
  };
}

export function followUpDescription(npc: Npc, action: InteractionChoice): string {
  if(locale==='zh'||typeof action.parameters.turn!=='number')return action.description;
  const turn=npc.mind.dialogue.turns.find(t=>t.sequence===action.parameters.turn);
  if(!turn)return translate(action.description);
  const full=translate(turn.text);
  const excerpt=[...full].slice(0,180).join('');
  return `Earlier you said: “${excerpt}${[...full].length>180?'…':''}” Asking does not accept a job or make a promise.`;
}

/** Human text only. data-* IDs, saves, model prompts, and styles remain canonical. */
export function localizeDOM(root: HTMLElement): () => void {
  const originals=new WeakMap<Node,{source:string;rendered:string}>();
  const attributes=new WeakMap<Element,Map<string,{source:string;rendered:string}>>();
  const apply=()=>{
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let node: Node|null;
    while((node=walker.nextNode())) {
      if(node.parentElement?.closest('script,style,[translate="no"]'))continue;
      const current=node.textContent??'', previous=originals.get(node);
      const source=previous&&previous.rendered===current?previous.source:current;
      const rendered=translate(source);
      originals.set(node,{source,rendered}); if(current!==rendered)node.textContent=rendered;
    }
    for(const element of [root,...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
      if(element.closest('[translate="no"]'))continue;
      let stored=attributes.get(element); if(!stored){stored=new Map();attributes.set(element,stored);}
      for(const key of ['aria-label','title','placeholder']) {
        const current=element.getAttribute(key); if(current===null||element.hasAttribute(`data-literal-${key}`))continue;
        const previous=stored.get(key),source=previous&&previous.rendered===current?previous.source:current;
        const rendered=translate(source); stored.set(key,{source,rendered}); if(current!==rendered)element.setAttribute(key,rendered);
      }
    }
    document.documentElement.lang=locale==='en'?'en':'zh-CN';
    document.title=locale==='en'?'Fog Harbor — A Life Among Neighbors':'雾港生活 — 街坊之间';
    root.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.locale===locale)));
  };
  const observer=new MutationObserver(()=>{observer.disconnect();apply();observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','title','placeholder']});});
  const update=()=>{observer.disconnect();apply();observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','title','placeholder']});};
  onLocaleChange(update);update();return update;
}
