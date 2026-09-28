import { z } from 'zod';

/** A host-supplied interaction, independent of world rules and rendering. */
export type InteractionChoice = {
  id: string;
  intent: string;
  label: string;
  description: string;
  subject?: { id: string; label: string };
  parameters: Record<string, string | number | boolean>;
};

const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Text must not be blank');

export const interactionChoiceSchema = z.object({
  id: text(160),
  intent: text(80),
  label: text(500),
  description: text(2000),
  subject: z.object({ id: text(160), label: text(500) }).strict().optional(),
  parameters: z.record(text(80), z.union([z.string().max(2000), z.number().finite(), z.boolean()]))
    .refine(parameters => Object.keys(parameters).length <= 16, 'At most 16 parameters are allowed'),
}).strict();

export const interactionChoicesSchema = z.array(interactionChoiceSchema).max(64)
  .refine(choices => new Set(choices.map(choice => choice.id)).size === choices.length, 'Interaction choice IDs must be unique');

/** Parse the full offered set before returning a detached selection. */
export function selectInteractionChoice(choices: InteractionChoice[], id: string): InteractionChoice | undefined {
  return interactionChoicesSchema.parse(choices).find(choice => choice.id === id);
}
