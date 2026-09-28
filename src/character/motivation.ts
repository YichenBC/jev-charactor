/** Environment-neutral observations and expected outcomes, not model explanations.
 * Pressure: 0 = satisfied, 100 = most pressing. Positive effects relieve pressure.
 * The transparent baseline is for rules mode / evaluation only, never a Jev answer.
 */
export type Drive = { id: string; label: string; pressure: number; evidence: string };
export type ActionForecast = {
  id: string;
  durationSeconds: number;
  effort: number;
  effects: Record<string, number>;
  notes: string[];
};

export function rankActions(drives: readonly Drive[], actions: readonly ActionForecast[]): { id: string; score: number }[] {
  const pressures = new Map<string, number>();
  for (const drive of drives) {
    if (!drive.id.trim() || pressures.has(drive.id) || !Number.isFinite(drive.pressure) || drive.pressure < 0 || drive.pressure > 100) {
      throw new RangeError('Drives require unique IDs and finite pressure between 0 and 100');
    }
    pressures.set(drive.id, drive.pressure);
  }
  const ids = new Set<string>();
  const ranked = actions.map(action => {
    if (!action.id.trim() || ids.has(action.id) || !Number.isFinite(action.durationSeconds) || action.durationSeconds < 0 || !Number.isFinite(action.effort) || action.effort < 0) {
      throw new RangeError('Actions require unique IDs and finite nonnegative costs');
    }
    ids.add(action.id);
    let score = -action.durationSeconds * .08 - action.effort * .5;
    for (const [driveId, effect] of Object.entries(action.effects)) {
      const pressure = pressures.get(driveId);
      if (pressure === undefined || !Number.isFinite(effect)) throw new RangeError('Effects require a known drive and finite value');
      score += effect >= 0
        ? pressure * Math.min(effect, pressure) / 100
        : Math.max(effect, pressure - 100) * (.5 + pressure / 100);
    }
    if (!Number.isFinite(score)) throw new RangeError('Action score overflow');
    return { id: action.id, score };
  });
  return ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
