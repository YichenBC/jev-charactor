import Phaser from 'phaser';
import { translate, presentObjective, translateIdentity, getLocale } from './i18n';
import { WIDTH, HEIGHT, BUILDINGS, PLAZA, movePlayer, advance, nearbyNpc, objective, nearestPlace, activeOrder, dayOf, worldClock, isWalkable, route, type Point, type World, type Npc } from './sim';

type Hooks = { world: () => World; running: () => boolean; controlsEnabled: () => boolean; selected: () => string | undefined; interact: (id: string) => void; openLife: () => void };
type Actor = { body: Phaser.GameObjects.Container; name: Phaser.GameObjects.Text; bubble: Phaser.GameObjects.Text; cue: Phaser.GameObjects.Text; feet: Phaser.GameObjects.Ellipse; lastX: number; lastY: number };
const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';

export class Neighborhood extends Phaser.Scene {
  private hooks: Hooks;
  private localizedTexts = new Map<Phaser.GameObjects.Text, string>();
  private renderedLocale = getLocale();
  presentationText(): string[] { return Array.from(this.localizedTexts.keys()).filter(text=>text.active).map(text=>text.text); }
  navigationLayout() {
    if(!this.navigation||!this.navigationBackdrop)return null;
    return {
      textBottom:this.navigation.y+this.navigation.height,
      panelBottom:this.navigationBackdrop.y+this.navigationBackdrop.height,
      textRight:this.navigation.x+this.navigation.width,
      panelRight:this.navigationBackdrop.x+this.navigationBackdrop.width,
      panelHeight:this.navigationBackdrop.height,
      hitAreaHeight:(this.navigationBackdrop.input?.hitArea as Phaser.Geom.Rectangle|undefined)?.height,
    };
  }
  private localizedText(x: number, y: number, source: string, style: Phaser.Types.GameObjects.Text.TextStyle, present: (source:string)=>string=translate) {
    const text=this.add.text(x,y,present(source),style);
    const original=text.setText.bind(text);
    this.localizedTexts.set(text,source);
    text.setText=(value: string | string[])=>{
      const canonical=Array.isArray(value)?value.join('\n'):value;
      this.localizedTexts.set(text,canonical);
      return original(present(canonical));
    };
    return text;
  }
  private actors = new Map<string, Actor>();
  private player!: Actor;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private focusRing!: Phaser.GameObjects.Ellipse;
  private prompt!: Phaser.GameObjects.Text;
  private targetRing!: Phaser.GameObjects.Ellipse;
  private targetLabel!: Phaser.GameObjects.Text;
  private nightTint!: Phaser.GameObjects.Rectangle;
  private miniMap!: Phaser.GameObjects.Graphics;
  private navigationBackdrop!: Phaser.GameObjects.Rectangle;
  private navigation!: Phaser.GameObjects.Text;
  private dayClock!: Phaser.GameObjects.Text;
  private hudCamera!: Phaser.Cameras.Scene2D.Camera;
  private walkPath: Point[] = [];
  private walkGuide!: Phaser.GameObjects.Graphics;
  private walkWorld?: World;
  private clock = 0;
  constructor(hooks: Hooks) { super('neighborhood'); this.hooks = hooks; }

  create() {
    this.drawTown();
    for (const npc of this.hooks.world().npcs) this.actors.set(npc.id, this.makeActor(npc.id, npc.name, npc.color));
    this.player = this.makeActor('player', '你', '#eee8ce');
    this.player.name.setColor('#f9eed1');
    this.focusRing = this.add.ellipse(0, 0, 42, 22).setStrokeStyle(2, 0xffd987, .8).setDepth(3000);
    this.prompt = this.localizedText(0, 0, 'E  交谈', { fontFamily: FONT, fontSize: '12px', color: '#29352d', backgroundColor: '#f1deac', padding: { x: 8, y: 5 } },value=>value).setOrigin(.5).setDepth(5000);
    this.targetRing = this.add.ellipse(0, 0, 56, 28).setStrokeStyle(2, 0xffd989, .9).setDepth(2999);
    this.targetLabel = this.localizedText(0, 0, '', { fontFamily: FONT, fontSize: '11px', color: '#f9dfa1', backgroundColor: '#26372de8', padding: { x: 8, y: 5 } },value=>value).setOrigin(.5).setDepth(3000);
    this.nightTint = this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x162b4a, 0).setOrigin(0).setDepth(2998);
    this.walkGuide = this.add.graphics().setDepth(1);
    this.walkWorld = this.hooks.world();
    this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SHIFT,E') as Record<string, Phaser.Input.Keyboard.Key>;
    this.input.keyboard!.addCapture(['W', 'A', 'S', 'D', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE']);
    // Handle the edge directly: a fast key tap can begin and end between two frames.
    this.keys.E.on('down', () => {
      if (!this.hooks.running() || !this.hooks.controlsEnabled()) return;
      const target = this.interactionTarget(this.hooks.world());
      if (target) this.walkPath = [];
      if (target?.npcId) this.hooks.interact(target.npcId);
      else if (target) this.hooks.openLife();
    });
    this.cameras.main.setBounds(0, 0, WIDTH, HEIGHT);
    this.cameras.main.startFollow(this.player.body, true, .09, .09);
    this.cameras.main.setZoom(1.08);
    this.cameras.main.setBackgroundColor('#3b4c43');
    this.createNavigation();
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      const world = this.hooks.world();
      if (over.length || !pointer.leftButtonDown() || !this.hooks.running() || !this.hooks.controlsEnabled() || world.survival.dead || world.player.activity) return;
      const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
      if (!isWalkable(point.x, point.y)) return;
      this.walkWorld = world;
      this.walkPath = route(world.player, { x: point.x, y: point.y });
    });
    this.scale.on('resize', () => {
      this.cameras.main.setSize(this.scale.width, this.scale.height);
      this.hudCamera.setSize(this.scale.width, this.scale.height);
    });
  }

  private followWalkPath(world: World, dt: number) {
    let remaining = 148 * (world.player.energy < 15 ? .65 : 1) * dt;
    while (this.walkPath.length && remaining > 0) {
      const next = this.walkPath[0];
      const dx = next.x - world.player.x, dy = next.y - world.player.y;
      const distance = Math.hypot(dx, dy);
      if (distance < .5) { this.walkPath.shift(); continue; }
      const step = Math.min(remaining, distance);
      movePlayer(world, dx / distance * step, dy / distance * step);
      remaining -= step;
      const after = Math.hypot(next.x - world.player.x, next.y - world.player.y);
      if (after < .5) this.walkPath.shift();
      else if (after >= distance - .01) { this.walkPath = []; break; }
    }
  }

  private drawWalkPath(world: World) {
    const g = this.walkGuide.clear();
    if (!this.walkPath.length) return;
    g.lineStyle(2, 0xcfe1b6, .32).beginPath().moveTo(world.player.x, world.player.y);
    for (const point of this.walkPath) g.lineTo(point.x, point.y);
    g.strokePath();
    const target = this.walkPath[this.walkPath.length - 1];
    g.lineStyle(2, 0xe0edbf, .8).strokeCircle(target.x, target.y, 7);
    g.lineBetween(target.x - 11, target.y, target.x - 4, target.y).lineBetween(target.x + 4, target.y, target.x + 11, target.y);
  }

  private createNavigation() {
    const backdrop = this.add.rectangle(16, 16, 166, 178, 0x20372f, .93).setOrigin(0).setStrokeStyle(1, 0x9f9970, .5).setDepth(6000).setInteractive();
    this.navigationBackdrop = backdrop;
    this.dayClock = this.localizedText(26, 25, '', { fontFamily: FONT, fontSize: '11px', color: '#e8dab6' }).setDepth(6001);
    this.miniMap = this.add.graphics().setDepth(6001);
    this.navigation = this.localizedText(26, 158, '', { fontFamily: FONT, fontSize: '10px', color: '#f1d591', wordWrap: { width: 146 } },value=>value).setDepth(6001);
    const hud = [backdrop, this.dayClock, this.miniMap, this.navigation];
    this.hudCamera = this.cameras.add(0, 0, this.scale.width, this.scale.height, false, 'navigation');
    this.hudCamera.ignore(this.children.list.filter(child => !hud.includes(child as typeof hud[number])));
    this.cameras.main.ignore(hud);
  }

  private updateNavigation(world: World) {
    const order=activeOrder(world);
    const task=presentObjective(objective(world),order?.status==='carrying'?world.npcs.find(n=>n.id===order.customerId)?.name:undefined),g=this.miniMap;
    const panelX = Math.max(16, this.scale.width - 182), panelY = 70;
    this.navigationBackdrop.setPosition(panelX, panelY);
    this.dayClock.setPosition(panelX + 10, panelY + 9);
    this.navigation.setPosition(panelX + 10, panelY + 142);
    const scale = 144 / WIDTH, offsetX = panelX + 10, offsetY = panelY + 27;
    g.clear().fillStyle(0x536555).fillRect(offsetX, offsetY, 144, HEIGHT * scale);
    g.fillStyle(0x326269).fillRect(offsetX + 1392 * scale, offsetY, 144 * scale, HEIGHT * scale);
    g.fillStyle(0x87927a, .5).fillRect(offsetX + 552 * scale, offsetY, 288 * scale, HEIGHT * scale).fillRect(offsetX, offsetY + 480 * scale, 1392 * scale, 240 * scale);
    for (const building of BUILDINGS) {
      g.fillStyle(building.color).fillRect(offsetX + building.x * scale, offsetY + building.y * scale, building.w * scale, building.h * scale);
      g.fillStyle(0xd8c99d).fillCircle(offsetX + building.door.x * scale, offsetY + building.door.y * scale, 1.5);
    }
    g.lineStyle(1.5, 0xf9d17a).strokeCircle(offsetX + task.target.x * scale, offsetY + task.target.y * scale, 4 + Math.sin(this.clock * 3) * .5);
    g.fillStyle(0xfff9e1).fillCircle(offsetX + world.player.x * scale, offsetY + world.player.y * scale, 2.8);
    const angle = Math.atan2(task.target.y - world.player.y, task.target.x - world.player.x);
    const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
    const direction = arrows[(Math.round(angle / (Math.PI / 4)) + 8) % 8];
    const steps = Math.ceil(Math.hypot(task.target.x - world.player.x, task.target.y - world.player.y) / 40);
    this.navigation.setText(world.survival.dead ? translate('旅程结束 · 可以重新开始') : `${direction} ${task.label}\n${translate(steps <= 2 ? '就在附近' : `约 ${steps} 步`)} · ${translate('白点是你')}`);
    // English captions can wrap to four lines. Rectangle.setSize also resizes its
    // default interactive hit area, so clicking the expanded HUD cannot move the player.
    const navigationHeight=Math.max(178,142+this.navigation.height+10);
    if(this.navigationBackdrop.height!==navigationHeight)this.navigationBackdrop.setSize(166,navigationHeight);
    const time = worldClock(world);
    this.dayClock.setText(`第 ${dayOf(world)} 天   ${time}`);
    const hour = Number(time.slice(0, 2));
    this.nightTint.setAlpha(hour >= 20 || hour < 6 ? .23 : hour >= 18 || hour < 8 ? .1 : 0);
    this.targetRing.setPosition(task.target.x, task.target.y).setScale(1 + Math.sin(this.clock * 3) * .07).setVisible(!world.survival.dead);
    this.targetLabel.setText(`◆ ${task.label}`).setPosition(task.target.x, task.target.y + 52).setVisible(!world.survival.dead);
  }

  private interactionTarget(world: World): { caption: string; x: number; y: number; npcId?: string } | undefined {
    if (world.survival.dead) return undefined;
    if (world.player.activity) return { caption: `E  查看${world.player.activity.label}`, x: world.player.x, y: world.player.y };
    const order = activeOrder(world);
    const customer = order && world.npcs.find(npc => npc.id === order.customerId && Math.hypot(npc.x - world.player.x, npc.y - world.player.y) <= 110);
    if (customer) return { caption: order?.status === 'carrying' ? `E  向${customer.name}交付外卖` : `E  与收件人${customer.name}交谈`, x: customer.x, y: customer.y, npcId: customer.id };
    const place = nearestPlace(world);
    if (place) {
      const actions: Record<string, string> = { tavern: '接单 / 取餐 / 买饭', shop: '购买面包', home: '住宿休息', post: '打工赚钱', watch: '免费歇脚' };
      return { caption: `E  ${actions[place.id] ?? place.name}`, x: place.door.x, y: place.door.y };
    }
    if (Math.hypot(world.player.x - PLAZA.x, world.player.y - PLAZA.y) <= 120) return { caption: 'E  广场长椅 · 免费歇脚', x: PLAZA.x, y: PLAZA.y };
    const npc = nearbyNpc(world, 110);
    return npc ? { caption: `E  与${npc.name}交谈`, x: npc.x, y: npc.y, npcId: npc.id } : undefined;
  }

  private drawTown() {
    const g = this.add.graphics();
    // Fixed noise avoids visual flickering or a random world between reloads.
    const noise = (x: number, y: number) => ((x * 113 + y * 43 + (x * y) % 71) % 97) / 97;
    g.fillStyle(0x435548).fillRect(0, 0, WIDTH, HEIGHT);
    for (let y = 0; y < HEIGHT; y += 12) for (let x = 0; x < 1392; x += 12) {
      if (noise(x, y) > .7) g.fillStyle(0x53624b, .4).fillRect(x, y, 3, 3);
    }
    // Street grid, broad central square, and footpaths to front doors.
    const streets = [{ x: 552, y: 0, w: 288, h: HEIGHT }, { x: 0, y: 480, w: 1392, h: 240 }];
    for (const s of streets) {
      g.fillStyle(0x798071).fillRect(s.x - 8, s.y - 8, s.w + 16, s.h + 16);
      g.fillStyle(0x626e64).fillRect(s.x, s.y, s.w, s.h);
    }
    for (const b of BUILDINGS) {
      const centerX = b.door.x;
      const fromY = Math.min(b.door.y, 600);
      g.fillStyle(0x626e64).fillRect(centerX - 34, fromY, 68, Math.abs(600 - b.door.y));
    }
    for (let y = 0; y < HEIGHT; y += 24) for (let x = 0; x < 1392; x += 32) {
      if ((x >= 552 && x <= 840) || (y >= 480 && y < 720)) {
        g.lineStyle(1, 0x394e45, .25).strokeRect(x + (y % 48 ? 16 : 0), y, 32, 24);
        if (noise(x, y) > .8) g.fillStyle(0x89917f, .25).fillRect(x + 6, y + 5, 19, 3);
      }
    }
    // Waterfront and a raised stone quay.
    g.fillStyle(0x284c50).fillRect(1392, 0, 144, HEIGHT);
    g.fillStyle(0x8d967e).fillRect(1378, 0, 14, HEIGHT);
    g.fillStyle(0x374b43).fillRect(1370, 0, 8, HEIGHT);
    for (let y = 8; y < HEIGHT; y += 38) {
      g.fillStyle(0x547d77, .6).fillRect(1410 + (y % 56), y, 38, 2);
      g.fillStyle(0x73968a, .3).fillRect(1400, y + 16, 18, 2);
    }
    g.fillStyle(0x635544).fillRect(1392, 868, 118, 64);
    for (let x = 1392; x < 1510; x += 12) g.lineStyle(2, 0x3d4238).lineBetween(x, 868, x, 932);
    // Small garden beds sit outside the walkable street and do not hide collisions.
    for (const [x, y] of [[120, 170], [120, 840], [1008, 110], [1260, 160], [1300, 1000], [455, 1050], [130, 1010]]) this.tree(x, y);
    for (const b of BUILDINGS) this.building(b);
    for (const [x, y] of [[510, 456], [866, 456], [510, 752], [866, 752], [1340, 430], [1340, 800]]) this.lamp(x, y);
    this.localizedText(690, 415, '雾 港 广 场', { fontFamily: FONT, fontSize: '14px', color: '#b5bca2', letterSpacing: 4 }).setOrigin(.5).setAlpha(.6);
    this.localizedText(690, 1060, '↓  南 码 头', { fontFamily: FONT, fontSize: '13px', color: '#a5b4a0', letterSpacing: 0 }).setOrigin(.5).setAlpha(.7);
    // A dry decorative compass painted onto the plaza; no invisible obstacles.
    g.lineStyle(1, 0xa0a487, .3).strokeCircle(696, 600, 65).strokeCircle(696, 600, 61);
    g.lineBetween(696, 546, 696, 654).lineBetween(642, 600, 750, 600);
    g.fillStyle(0xb7ac7d, .35).fillTriangle(696, 559, 685, 599, 696, 590);
  }

  private building(b: typeof BUILDINGS[number]) {
    const g = this.add.graphics().setDepth(b.y + b.h - 40);
    // Building body remains within the collision footprint; roof overhang is visual only.
    g.fillStyle(0x172c29, .35).fillRect(b.x + 14, b.y + 15, b.w, b.h);
    g.fillStyle(0xc4b391).fillRect(b.x, b.y, b.w, b.h);
    g.fillStyle(0x6a6350).fillRect(b.x, b.y + b.h - 12, b.w, 12);
    const roofH = b.h * .64;
    g.fillStyle(b.color).fillRect(b.x - 5, b.y - 5, b.w + 10, roofH);
    g.fillStyle(0x182e2a, .2).fillRect(b.x - 5, b.y + roofH - 10, b.w + 10, 12);
    for (let y = b.y + 5; y < b.y + roofH - 8; y += 12) {
      g.lineStyle(2, 0x213a33, .25).lineBetween(b.x, y, b.x + b.w, y);
      for (let x = b.x + (y % 24 ? 12 : 0); x < b.x + b.w; x += 28) g.lineBetween(x, y, x, y + 11);
    }
    for (let x = b.x + 22; x < b.x + b.w - 20; x += 58) {
      g.fillStyle(0x45504a).fillRect(x - 3, b.y + roofH + 7, 29, 34);
      g.fillStyle(0xf0ca81).fillRect(x, b.y + roofH + 10, 23, 26);
      g.lineStyle(2, 0x786745).lineBetween(x + 12, b.y + roofH + 10, x + 12, b.y + roofH + 36);
      g.lineBetween(x, b.y + roofH + 22, x + 23, b.y + roofH + 22);
    }
    // Door faces the configured approach; northern doors remain visible above the roof.
    const north = b.door.y < b.y;
    const dy = north ? b.y : b.y + b.h - 39;
    g.fillStyle(0x3d4a3e).fillRect(b.door.x - 17, dy, 34, 39);
    g.fillStyle(0xa88755).fillRect(b.door.x - 13, dy + 4, 26, 35);
    g.fillStyle(0xf4d59b).fillRect(b.door.x + 7, dy + 23, 3, 3);
    g.fillStyle(0xa2a18b).fillRect(b.door.x - 24, north ? b.y - 9 : b.y + b.h, 48, 9);
    g.fillStyle(0x545b4e).fillRect(b.x + b.w - 54, b.y - 16, 20, 34);
    g.fillStyle(0x777568).fillRect(b.x + b.w - 58, b.y - 18, 28, 7);
    this.localizedText(b.x + b.w / 2, b.y + 40, b.name, { fontFamily: FONT, fontSize: '14px', color: '#fff0ce', backgroundColor: '#283b32dd', padding: { x: 14, y: 8 }, letterSpacing: 0 }).setOrigin(.5).setDepth(b.y + b.h + 1);
    this.localizedText(b.x + b.w / 2, b.y + 68, b.subtitle, { fontFamily: FONT, fontSize: '10px', color: '#e4dcc0', letterSpacing: 0 }).setOrigin(.5).setDepth(b.y + b.h + 1).setAlpha(.8);
    this.add.zone(b.door.x, b.door.y - 12, 64, 60).setDepth(b.y + b.h + 2).setInteractive({ useHandCursor: true }).on('pointerdown', () => { if(!this.hooks.running() || !this.hooks.controlsEnabled())return; this.walkPath = []; this.hooks.openLife(); });
  }

  private tree(x: number, y: number) {
    const g = this.add.graphics().setDepth(y);
    g.fillStyle(0x152f29, .35).fillEllipse(x + 8, y + 8, 68, 22);
    g.fillStyle(0x706044).fillRect(x - 5, y - 34, 10, 37);
    g.fillStyle(0x2b4437).fillRect(x - 29, y - 64, 58, 39).fillRect(x - 21, y - 79, 42, 57);
    g.fillStyle(0x52684a).fillRect(x - 24, y - 68, 41, 25).fillRect(x - 14, y - 79, 28, 21);
    g.fillStyle(0x738051).fillRect(x - 17, y - 66, 12, 8).fillRect(x + 8, y - 47, 12, 7);
  }

  private lamp(x: number, y: number) {
    const g = this.add.graphics().setDepth(y);
    g.fillStyle(0xf5d492, .045).fillCircle(x, y, 58);
    g.fillStyle(0xf5d492, .07).fillCircle(x, y, 36);
    g.fillStyle(0x344139).fillRect(x - 2, y - 37, 4, 39).fillRect(x - 8, y - 47, 16, 3);
    g.fillStyle(0xffd58a).fillRect(x - 5, y - 44, 10, 10);
    g.fillStyle(0x344139).fillRect(x - 8, y - 34, 16, 3);
  }

  private makeActor(id: string, name: string, color: string): Actor {
    const body = this.add.container(0, 0);
    const shadow = this.add.ellipse(0, 1, 23, 10, 0x142c28, .45);
    const pixels = this.add.graphics();
    pixels.fillStyle(0x26332e).fillRect(-7, -8, 5, 9).fillRect(2, -8, 5, 9);
    pixels.fillStyle(Phaser.Display.Color.HexStringToColor(color).color).fillRect(-9, -23, 18, 17).fillRect(-12, -20, 4, 12).fillRect(8, -20, 4, 12);
    pixels.fillStyle(0xdbb687).fillRect(-6, -35, 12, 13).fillRect(-12, -10, 4, 5).fillRect(8, -10, 4, 5);
    pixels.fillStyle(id === 'zhou' ? 0xc5c1a8 : 0x3b3d31).fillRect(-7, -37, 14, 6).fillRect(-7, -32, 3, 7);
    pixels.fillStyle(0x343b2e).fillRect(3, -29, 2, 2);
    if (id === 'player') pixels.fillStyle(0x9c6455).fillRect(-9, -24, 18, 4);
    if (id === 'lan') pixels.fillStyle(0x8d7249).fillRect(4, -23, 10, 11);
    const label = this.localizedText(0, -53, name, { fontFamily: FONT, fontSize: '12px', color: '#f1e7cc', backgroundColor: '#243b32c9', padding: { x: 6, y: 3 } },id==='player'?translate:translateIdentity).setOrigin(.5);
    body.add([shadow, pixels, label]);
    body.setSize(40, 65).setInteractive(new Phaser.Geom.Rectangle(-20, -45, 40, 60), Phaser.Geom.Rectangle.Contains);
    if (id !== 'player') body.on('pointerdown', () => { if(!this.hooks.running() || !this.hooks.controlsEnabled())return; this.walkPath = []; this.hooks.interact(id); });
    const bubble = this.localizedText(0, 0, '', { fontFamily: FONT, fontSize: '12px', color: '#344437', backgroundColor: '#fff2dbeF', padding: { x: 10, y: 7 }, wordWrap: { width: 220 }, align: 'center', lineSpacing: 4 }).setOrigin(.5, 1).setDepth(5000).setVisible(false);
    const cue = this.localizedText(0, 0, '', { fontFamily: FONT, fontSize: '10px', color: '#c9d6bb', backgroundColor: '#263b30ba', padding: { x: 5, y: 2 } }).setOrigin(.5).setDepth(3001).setVisible(false);
    return { body, name: label, bubble, cue, feet: shadow, lastX: -1, lastY: -1 };
  }

  update(_time: number, delta: number) {
    if (!this.player) return;
    if(this.renderedLocale!==getLocale()) {
      this.renderedLocale=getLocale();
      for(const [text,source] of this.localizedTexts)text.setText(source);
    }
    const dt = Math.min(delta / 1000, .05);
    const world = this.hooks.world();
    if (world !== this.walkWorld || world.survival.dead || world.player.activity || !this.hooks.running() || !this.hooks.controlsEnabled()) this.walkPath = [];
    this.walkWorld = world;
    this.clock += dt;
    if (this.hooks.running()) {
      if (this.hooks.controlsEnabled()) {
        const x = Number(this.keys.D.isDown || this.keys.RIGHT.isDown) - Number(this.keys.A.isDown || this.keys.LEFT.isDown);
        const y = Number(this.keys.S.isDown || this.keys.DOWN.isDown) - Number(this.keys.W.isDown || this.keys.UP.isDown);
        const fatigued = world.player.energy < 15;
        const speed = (fatigued ? 148 * .65 : this.keys.SHIFT.isDown ? 235 : 148) * dt / (x && y ? Math.SQRT2 : 1);
        if (x || y) { this.walkPath = []; movePlayer(world, x * speed, y * speed); }
        else this.followWalkPath(world, dt);
      }
      advance(world, dt);

    }
    const position = (actor: Actor, person: { x: number; y: number }, npc?: Npc) => {
      const moving = Math.hypot(person.x - actor.lastX, person.y - actor.lastY) > .1;
      const bob = moving && this.hooks.running() ? Math.sin(this.clock * 16) * 1.4 : 0;
      actor.body.setPosition(person.x, person.y + bob).setDepth(person.y);
      actor.name.setText(npc?.name??'你');
      actor.lastX = person.x; actor.lastY = person.y;
      const speaking = Boolean(npc?.bubble && (npc.bubbleUntil || 0) > world.time);
      actor.bubble.setVisible(speaking);
      if (speaking) actor.bubble.setText(npc!.bubble!).setPosition(person.x, person.y - 72);
      const intent = npc?.mind.intent;
      const active = intent && ['planning', 'acting', 'waiting'].includes(intent.phase);
      const cueVisible = Boolean(npc) && !speaking;
      actor.cue.setVisible(cueVisible);
      if (npc && cueVisible) {
        const colors = { warm: '#dfc588', guarded: '#b9c6b6', focused: '#afc8cd', worried: '#e0b58b', irritated: '#dca196' };
        const progress = active ? intent.phase === 'waiting' ? ' · 等候中' : intent.phase === 'acting' ? moving ? ' · 行进中' : ' · 进行中' : ' · 斟酌中' : '';
        actor.cue.setText(`${npc.mind.expression}${progress}`).setColor(colors[npc.mind.affect]).setPosition(person.x, person.y - 76);
      }
    };
    position(this.player, world.player);
    for (const npc of world.npcs) { const actor = this.actors.get(npc.id); if (actor) position(actor, npc, npc); }
    const target = this.interactionTarget(world);
    this.prompt.setVisible(Boolean(target) && this.hooks.running() && this.hooks.controlsEnabled());
    if (target) {
      const npc=world.npcs.find(person=>person.id===target.npcId),order=activeOrder(world);
      const name=translateIdentity(npc?.name);
      const caption=npc&&getLocale()==='en'
        ? order?.customerId===npc.id
          ? order.status==='carrying'?`E  Deliver to ${name}`:`E  Talk to customer ${name}`
          : `E  Talk to ${name}`
        : npc?target.caption:translate(target.caption);
      this.prompt.setText(caption).setPosition(target.x,target.y+28);
    }
    this.updateNavigation(world);
    this.drawWalkPath(world);
    const selected = world.npcs.find(n => n.id === this.hooks.selected());
    this.focusRing.setVisible(Boolean(selected));
    if (selected) this.focusRing.setPosition(selected.x, selected.y + 1).setDepth(selected.y - 1);
  }
}

export function createGame(parent: HTMLElement, hooks: Hooks) {
  return new Phaser.Game({ type: Phaser.AUTO, parent, backgroundColor: '#435548', pixelArt: true, antialias: false,
    scale: { mode: Phaser.Scale.RESIZE, width: parent.clientWidth, height: parent.clientHeight },
    scene: [new Neighborhood(hooks)], render: { roundPixels: true }, audio: { noAudio: true },
  });
}
