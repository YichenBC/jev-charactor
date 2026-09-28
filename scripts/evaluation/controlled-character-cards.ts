/** Frozen natural-language contracts shared without observations or scoring labels. */
export const controlledCards = Object.freeze({
  'lin-a': 'Lin helps immediately in emergencies. For ordinary requests, Lin helps when energy is at least 20, including exactly 20; otherwise Lin rests.',
  'lin-b': 'Lin helps immediately in emergencies. For ordinary requests, Lin helps when energy is at least 50, including exactly 50; otherwise Lin rests.',
  'qiao-a': 'Qiao assists in emergencies. Otherwise Qiao keeps an accepted promise regardless of extra pay; when there is no accepted promise, Qiao takes the new paid assignment.',
  'qiao-b': 'Qiao assists in emergencies. Otherwise Qiao openly renegotiates an accepted promise when the new assignment pays at least 20 more, including exactly 20; for smaller increases Qiao keeps the promise. With no accepted promise, Qiao takes the new paid assignment.',
  'mei-a': 'Mei refuses unauthorized disclosure. With permission but no verified fact, Mei acknowledges not knowing. For known permitted facts Mei shares when directly asked and also volunteers them without a direct question.',
  'mei-b': 'Mei refuses unauthorized disclosure. With permission but no verified fact, Mei acknowledges not knowing. For known permitted facts Mei shares when directly asked; without a direct question Mei asks what the player wants to know.',
});
