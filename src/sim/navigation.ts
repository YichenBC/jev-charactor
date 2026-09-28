import { BUILDINGS, HEIGHT, TILE, WIDTH } from './data';
import type { Point } from './types';
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
export function isWalkable(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 24 && x <= WIDTH - 168 && y >= 24 && y <= HEIGHT - 24 && BUILDINGS.every(b => x < b.x - 13 || x > b.x + b.w + 13 || y < b.y - 13 || y > b.y + b.h + 13);
}
export function move(body: Point, dx: number, dy: number) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 6);
  if (steps > 4096) return;
  for (let i = 0; i < steps; i++) {
    if (isWalkable(body.x + dx / steps, body.y)) body.x += dx / steps;
    if (isWalkable(body.x, body.y + dy / steps)) body.y += dy / steps;
  }
}
export function route(start: Point, target: Point): Point[] {
  const cols = WIDTH / TILE;
  const key = (p: Point) => Math.floor(p.y / TILE) * cols + Math.floor(p.x / TILE);
  const point = (id: number): Point => ({ x: (id % cols) * TILE + TILE / 2, y: Math.floor(id / cols) * TILE + TILE / 2 });
  const from = key(start), to = key(target);
  if (!isWalkable(target.x, target.y)) return [];
  const queue = [from], previous = new Map<number, number>([[from, -1]]);
  for (let i = 0; i < queue.length && !previous.has(to); i++) {
    const current = queue[i], p = point(current);
    for (const d of [{ x: TILE, y: 0 }, { x: -TILE, y: 0 }, { x: 0, y: TILE }, { x: 0, y: -TILE }]) {
      const nextPoint = { x: p.x + d.x, y: p.y + d.y }, next = key(nextPoint);
      if (isWalkable(nextPoint.x, nextPoint.y) && !previous.has(next)) { previous.set(next, current); queue.push(next); }
    }
  }
  if (!previous.has(to)) return [];
  const path: Point[] = [];
  for (let at = to; at !== from; at = previous.get(at)!) path.unshift(point(at));
  if (distance(start, point(from)) > 1) path.unshift(point(from));
  if (distance(path.at(-1) ?? start, target) > 1) path.push({ ...target });
  return path;
}
