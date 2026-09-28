import { describe, expect, it } from 'vitest';
import { rankActions, type ActionForecast, type Drive } from '../src/character/motivation';

const drive = (id: string, pressure: number): Drive => ({ id, pressure, label: id, evidence: 'Observed state' });
const action = (id: string, effects: Record<string, number>, durationSeconds = 0, effort = 0): ActionForecast => ({ id, effects, durationSeconds, effort, notes: [] });

describe('reusable motivation baseline', () => {
  it('responds to the character’s needs rather than a fixed activity order', () => {
    const choices = [action('eat', { hunger: 48 }), action('rest', { energy: 42 })];
    expect(rankActions([drive('hunger', 90), drive('energy', 10)], choices)[0].id).toBe('eat');
    expect(rankActions([drive('hunger', 10), drive('energy', 90)], choices)[0].id).toBe('rest');
  });

  it('does not reward relief beyond what a character needs', () => {
    const scores = rankActions([drive('hunger', 10)], [action('snack', { hunger: 10 }), action('meal', { hunger: 65 })]);
    expect(scores[0].score).toBe(scores[1].score);
    expect(scores[0].score).toBe(1);
  });

  it('trades benefit against duration, effort and worsened needs', () => {
    const options = [action('nearby', { energy: 24 }, 10), action('distant', { energy: 42 }, 120), action('hard-work', { workPressure: 35, energy: -8 }, 16, 4)];
    const ranked = rankActions([drive('energy', 80), drive('workPressure', 10)], options);
    expect(ranked[0].id).toBe('distant');
    expect(ranked.at(-1)!.id).toBe('hard-work');
    const base = rankActions([drive('energy', 80)], [action('neutral', {})])[0].score;
    expect(rankActions([drive('energy', 80)], [action('costly', { energy: -8 })])[0].score).toBeLessThan(base);
  });

  it('has stable ties without mutating or aliasing the input', () => {
    const drives = [drive('social', 50)], options = [action('b', { social: 20 }), action('a', { social: 20 })];
    const before = JSON.stringify({ drives, options });
    const first = rankActions(drives, options);
    expect(first.map(a => a.id)).toEqual(['a', 'b']);
    first[0].score = 999;
    expect(rankActions(drives, options)[0].score).toBe(10);
    expect(JSON.stringify({ drives, options })).toBe(before);
  });

  it('rejects ambiguous or invalid state instead of ranking nonsense', () => {
    expect(() => rankActions([drive('hunger', NaN)], [])).toThrow();
    expect(() => rankActions([drive('hunger', -1)], [])).toThrow();
    expect(() => rankActions([drive('hunger', 101)], [])).toThrow();
    expect(() => rankActions([drive('hunger', 10), drive('hunger', 20)], [])).toThrow();
    expect(() => rankActions([], [action('a', {}), action('a', {})])).toThrow();
    expect(() => rankActions([], [action('a', {}, -1)])).toThrow();
    expect(() => rankActions([], [action('a', {}, 0, Infinity)])).toThrow();
    expect(() => rankActions([drive('hunger', 50)], [action('a', { hunger: NaN })])).toThrow();
    expect(() => rankActions([], [action('a', { unknown: 5 })])).toThrow();
    expect(rankActions([], [])).toEqual([]);
  });
});
