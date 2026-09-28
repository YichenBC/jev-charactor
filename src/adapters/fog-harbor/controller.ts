import { CharacterRuntime } from '../../character/runtime';
import { LocalJevProvider } from '../../providers/local-jev';
import { FogHarborEnvironment } from './environment';
import { activeOrder, chooseFallback, getOptions, distance, endPlayerInteraction, type Npc, type World } from '../../sim';
import { participatingConversation, socialInvitation } from '../../sim/npcLife';
import { pendingActionCurrent } from '../../sim/interactions';

/** Scheduling is independent of the render loop. Existing actions never await a network call. */
export class DecisionController {
  mode: 'jev' | 'rules' = 'jev';
  configured = false;
  checked = false;
  error = '';
  retryAt = 0;
  requests = 0;
  successes = 0;
  failures = 0;
  blocked = false;
  private readonly runtime: CharacterRuntime;
  get pending() { return this.runtime.pending; }
  private nextDispatch = 0;
  constructor(private hooks: { world: () => World; running: () => boolean; conversation?: () => string | null; changed: () => void; notify: (message: string) => void }) {
    const controller = this, jev = new LocalJevProvider();
    this.runtime = new CharacterRuntime(new FogHarborEnvironment({ world: hooks.world, running: hooks.running, allows: npc => this.conversationAllows(npc) }), {
      get source() { return controller.mode; },
      decide: async (frame, signal) => {
        if (this.mode === 'jev') return jev.decide(frame, signal);
        const world = hooks.world(), npc = world.npcs.find(n => n.id === frame.characterId);
        if (!npc) throw new Error('missing_character');
        return { choice: chooseFallback(world, npc.id), affect: npc.trust < 0 ? 'guarded' : 'focused' };
      },
    });
  }
  private conversationAllows(npc: Npc): boolean {
    const focused = this.hooks.conversation?.();
    return focused == null || (focused === npc.id && Boolean(npc.pendingInteraction));
  }
  cancel() { this.runtime.cancel(); }
  prioritize(npcId: string) { this.nextDispatch = 0; const npc = this.hooks.world().npcs.find(n => n.id === npcId); if (npc) npc.cooldown = 0; }
  async check() {
    try { const res = await fetch('/api/status', { signal: AbortSignal.timeout(4000) }); if (!res.ok) throw new Error(); const data = await res.json(); this.configured = data.configured === true; this.error = this.configured ? '' : '缺少服务端密钥'; this.blocked = !this.configured; this.failures = 0; this.retryAt = 0; }
    catch { this.configured = false; this.error = '本地服务未连接'; this.blocked = true; }
    this.checked = true; this.hooks.changed();
  }
  async tick() {
    if (!this.hooks.running() || Date.now() < Math.max(this.nextDispatch, this.retryAt) || this.pending.size >= 2) return;
    if (this.mode === 'jev' && (!this.configured || this.blocked)) return;
    const world = this.hooks.world(), order = activeOrder(world);
    // End abandoned conversations as a game event before capturing a new decision.
    for (const resident of world.npcs) if (resident.pendingInteraction && (distance(world.player, resident) > 110 || !pendingActionCurrent(world,resident))) {
      endPlayerInteraction(world, resident.id);
      this.hooks.notify('刚才的交互条件已变化，请重新选择。');
      this.hooks.changed();
    }
    const npc = [...world.npcs].filter(n => this.conversationAllows(n) && !this.pending.has(n.id) && n.cooldown <= 0 && (!n.path.length || n.pendingInteraction) && (!n.job || n.pendingInteraction) && !participatingConversation(world,n) && !(world.player.activity?.kind === 'help' && world.player.activity.npcId === n.id) && (n.id !== order?.customerId || n.pendingInteraction)).sort((a,b) => Number(Boolean(b.pendingInteraction)) - Number(Boolean(a.pendingInteraction)) || Number(Boolean(socialInvitation(world,b)))-Number(Boolean(socialInvitation(world,a))) || a.cooldown - b.cooldown)[0];
    if (!npc) return;
    const options = getOptions(world, npc.id);
    if (options.length < 2) { npc.cooldown = 1; return; }
    this.nextDispatch = Date.now() + (npc.pendingInteraction ? 80 : 350);
    const modelRequest = this.mode === 'jev';
    if (modelRequest) this.requests++;
    try {
      const turn = this.runtime.step(npc.id);
      this.hooks.changed();
      const result = await turn;
      if (result.status !== 'applied' || !modelRequest) return;
      this.successes++;
      // Another in-flight request may have established a terminal failure.
      if (!this.blocked) { this.failures = 0; this.error = ''; this.retryAt = 0; }
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      if (this.blocked) return;
      this.failures++;
      const terminal = ['missing_key','upstream_401','upstream_402','session_budget'].includes(code);
      this.blocked = terminal || this.failures >= 3;
      this.error = code === 'session_budget' ? '本次调用额度已用完' : code === 'upstream_402' ? 'OpenRouter 余额不足' : code === 'upstream_401' ? '密钥验证失败' : 'Jev 连接暂时中断';
      this.retryAt = Date.now() + Math.min(15000,this.failures * 2500);
      if (this.hooks.conversation?.() != null) {
        this.hooks.notify(this.blocked ? `${this.error}，可在角色记录中重连。世界仍暂停，结束交谈后恢复。` : '角色正在等候回复，稍后自动重试；世界仍暂停，也可以结束交谈。');
      } else {
        this.hooks.notify(this.blocked ? `${this.error}，可在角色记录中重连。已有动作继续执行。` : '角色正在等候回复，稍后自动重试；你可以继续行动。');
      }
    } finally {
      this.hooks.changed();
    }
  }
}
