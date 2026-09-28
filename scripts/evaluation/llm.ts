import {z} from 'zod';
import {ACTION_INSTRUCTIONS, REACTION_INSTRUCTIONS} from '../../server/jev';
import {REACTION_OPTIONS} from '../../src/character';
import {createEvaluationTransport, record, responseEvidence} from './llm-transport';
import type {EvaluationProvider} from './types';

/** General AR model chooses the same action/reaction contract; it does not write NPC dialogue. */
export function llmProvider(fetcher?: typeof fetch): EvaluationProvider {
  const transport = createEvaluationTransport(200, fetcher);
  return {
    id: 'llm', model: transport.model, ...transport.providerMetadata,
    protocolVersion: 'shared-action-reaction-json-v1',
    async decide(input) {
      const start = performance.now();
      const raw = await transport.request({
        messages: [
          {role: 'system', content: `Choose action and reaction for the fictional character. Action instructions: ${ACTION_INSTRUCTIONS}\nReaction instructions: ${REACTION_INSTRUCTIONS}\nReturn only the structured action and reaction. Do not generate dialogue.`},
          {role: 'user', content: JSON.stringify({
            state: input.state,
            actionCriteria: Object.fromEntries(input.options.map(o => [o.id, o.description])),
            reactionCriteria: Object.fromEntries(REACTION_OPTIONS.map(r => [r.id, r.description])),
          })},
        ],
        response_format: {type: 'json_schema', json_schema: {
          name: 'character_decision', strict: true,
          schema: {
            type: 'object', properties: {
              action: {type: 'string', enum: input.options.map(o => o.id)},
              reaction: {type: 'string', enum: REACTION_OPTIONS.map(r => r.id)},
            },
            required: ['action', 'reaction'], additionalProperties: false,
          },
        }},
      });
      const evidence = responseEvidence(raw, transport.selfHosted);
      let parsed: unknown = null;
      try { parsed = JSON.parse(evidence.rawContent ?? ''); } catch { /* Preserve malformed output for audit. */ }
      const answer = z.object({action: z.string(), reaction: z.enum(['warm', 'guarded', 'focused', 'worried', 'irritated'])}).strict().safeParse(parsed);
      const fields = record(parsed);
      return {
        choice: typeof fields.action === 'string' ? fields.action : '',
        affect: typeof fields.reaction === 'string' ? fields.reaction : '',
        contractValid: evidence.finishReason === 'stop' && answer.success && input.options.some(o => o.id === answer.data.action),
        latencyMs: performance.now() - start, ...evidence,
      };
    },
  };
}
