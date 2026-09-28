import {z} from 'zod';
import {ACTION_INSTRUCTIONS, REACTION_INSTRUCTIONS} from '../../server/jev';
import {REACTION_OPTIONS} from '../../src/character';
import type {EvaluationProvider} from './types';
import {createEvaluationTransport, record, responseEvidence} from './llm-transport';

const answerSchema = z.object({
  action: z.string(),
  reaction: z.enum(['warm', 'guarded', 'focused', 'worried', 'irritated']),
  dialogue: z.string().max(1600).nullable(),
}).strict();
const envelopeSchema = z.object({
  choices: z.array(z.object({
    message: z.object({content: z.string().nullable()}),
    finish_reason: z.literal('stop'),
  })).min(1),
});

/** Full character baseline: the model chooses intentions and authors its own speech. */
export function llmCharacterProvider(
  fetcher?: typeof fetch,
): EvaluationProvider {
  const transport = createEvaluationTransport(600, fetcher);
  return {
    id: 'llm-character', model: transport.model, ...transport.providerMetadata, expressionMode: 'generated',
    protocolVersion: 'shared-action-reaction-dialogue-json-v2',
    async decide(input) {
      const start = performance.now();
      const interactive = Boolean(record(input.state.situation).pendingInteraction);
      const raw = await transport.request({
        messages: [
          {role: 'system', content: `Choose action and reaction as this fictional character. Action instructions: ${ACTION_INSTRUCTIONS}\nReaction instructions: ${REACTION_INSTRUCTIONS}\nReturn only structured action, reaction and dialogue. ${interactive ? "Respond to the pending player interaction in nonblank Chinese dialogue in the character's own voice, at most 1600 characters." : 'No player is speaking. Choose your next activity and set dialogue to null. Do not narrate or talk to yourself.'} Use only the supplied character's local knowledge and conversation history. Candidate descriptions may suggest wording; that wording is optional, not mandatory. Ground your words in the selected action and current evidence. Do not claim a delayed job is completed before the simulation records its completion. Do not add narrator commentary or meta explanations.`},
          {role: 'user', content: JSON.stringify({
            state: input.state,
            actionCriteria: Object.fromEntries(input.options.map(o => [o.id, o.description])),
            reactionCriteria: Object.fromEntries(REACTION_OPTIONS.map(r => [r.id, r.description])),
          })},
        ],
        response_format: {type: 'json_schema', json_schema: {
          name: 'character_action_reaction_dialogue_v2', strict: true,
          schema: {
            type: 'object', properties: {
              action: {type: 'string', enum: input.options.map(o => o.id)},
              reaction: {type: 'string', enum: REACTION_OPTIONS.map(r => r.id)},
              dialogue: {type: interactive ? 'string' : 'null'},
            },
            required: ['action', 'reaction', 'dialogue'], additionalProperties: false,
          },
        }},
      });
      const evidence = responseEvidence(raw, transport.selfHosted);
      const {rawContent} = evidence;
      let parsed: unknown = null;
      try { parsed = JSON.parse(rawContent ?? ''); } catch { /* Keep exact malformed content for audit. */ }
      const fields = record(parsed);
      const answer = answerSchema.safeParse(parsed);
      const contractValid = envelopeSchema.safeParse(raw).success && answer.success
        && input.options.some(o => o.id === answer.data.action)
        && (interactive ? typeof answer.data.dialogue === 'string' && answer.data.dialogue.trim().length > 0 : answer.data.dialogue === null);
      return {
        choice: typeof fields.action === 'string' ? fields.action : '',
        affect: typeof fields.reaction === 'string' ? fields.reaction : '',
        dialogue: typeof fields.dialogue === 'string' || fields.dialogue === null ? fields.dialogue : undefined,
        ...evidence, contractValid, latencyMs: performance.now() - start,
      };
    },
  };
}
