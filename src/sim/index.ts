export * from './types';
export { WIDTH, HEIGHT, TILE, BUILDINGS, INTERACTIONS, FACT_LABELS, describeFact } from './data';
export { createWorld, advance, movePlayer, isWalkable, nearbyNpc, getOptions, getContext, applyDecision, playerInteract, endPlayerInteraction, chooseFallback } from './engine';
export { serializeWorld, loadWorld } from './persistence';
export * from './survival';
export { distance, route } from './navigation';

export { getNpcMotivation, forecastNpcActions } from './motivation';
export { getPlayerInteractions } from './interactions';
