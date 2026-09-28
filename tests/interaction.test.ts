import { describe, expect, it } from 'vitest';
import * as characterApi from '../src/character/api';
import {
  interactionChoiceSchema, interactionChoicesSchema, selectInteractionChoice,
  type InteractionChoice,
} from '../src/character/api';

const choice = (id = 'ask-journal'): InteractionChoice => ({
  id, intent: 'ask', label: 'Ask about the journal', description: 'Ask the archivist about a journal.',
  subject: { id: 'journal', label: 'Research journal' },
  parameters: { topic: 'journal', quantity: 1, discreet: true },
});

describe('portable interaction choices', () => {
  it('exports the schemas and selection helper from the public character API', () => {
    expect(characterApi).toHaveProperty('interactionChoiceSchema');
    expect(characterApi).toHaveProperty('interactionChoicesSchema');
    expect(characterApi).toHaveProperty('selectInteractionChoice');
  });

  it('accepts supplied primitive parameters and an optional subject', () => {
    expect(interactionChoiceSchema.parse(choice())).toEqual(choice());
    const { subject: _subject, ...withoutSubject } = choice();
    expect(interactionChoiceSchema.parse({ ...withoutSubject, parameters: {} }))
      .toEqual({ ...withoutSubject, parameters: {} });
  });

  it('rejects duplicate IDs even when their intents and subjects differ', () => {
    const choices = [choice(), { ...choice(), intent: 'offer', subject: { id: 'other', label: 'Other' } }];
    expect(interactionChoicesSchema.safeParse(choices).success).toBe(false);
    expect(() => selectInteractionChoice(choices, 'ask-journal')).toThrow();
  });

  it('bounds the number of choices while accepting distinct IDs', () => {
    const choices = Array.from({ length: 64 }, (_, i) => choice(`choice-${i}`));
    expect(interactionChoicesSchema.safeParse(choices).success).toBe(true);
    expect(interactionChoicesSchema.safeParse([...choices, choice('extra')]).success).toBe(false);
  });

  it.each([
    ['id', 160], ['intent', 80], ['label', 500], ['description', 2000],
  ] as const)('requires bounded nonblank %s text', (field, max) => {
    expect(interactionChoiceSchema.safeParse({ ...choice(), [field]: 'x'.repeat(max) }).success).toBe(true);
    for (const value of ['', ' \n ', 'x'.repeat(max + 1), 3, null]) {
      expect(interactionChoiceSchema.safeParse({ ...choice(), [field]: value }).success).toBe(false);
    }
  });

  it('rejects malformed subjects and unknown fields at either object level', () => {
    for (const input of [
      { ...choice(), extra: true }, { ...choice(), subject: null },
      { ...choice(), subject: { id: 'journal' } },
      { ...choice(), subject: { id: '', label: 'Journal' } },
      { ...choice(), subject: { id: 'x'.repeat(161), label: 'Journal' } },
      { ...choice(), subject: { id: 'journal', label: ' ' } },
      { ...choice(), subject: { id: 'journal', label: 'x'.repeat(501) } },
      { ...choice(), subject: { id: 'journal', label: 'Journal', hidden: true } },
    ]) expect(interactionChoiceSchema.safeParse(input).success).toBe(false);
  });

  it('requires parameters and rejects nested values and nonfinite numbers', () => {
    const { parameters: _parameters, ...missingParameters } = choice();
    expect(interactionChoiceSchema.safeParse(missingParameters).success).toBe(false);
    for (const parameters of [undefined, null, [], { nested: {} }, { nested: [] }, { value: null },
      { value: undefined }, { value: NaN }, { value: Infinity }, { value: -Infinity }]) {
      expect(interactionChoiceSchema.safeParse({ ...choice(), parameters }).success).toBe(false);
    }
  });

  it('bounds parameter keys, strings, and field count', () => {
    const atLimit = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`key-${i}`, i]));
    expect(interactionChoiceSchema.safeParse({ ...choice(), parameters: atLimit }).success).toBe(true);
    expect(interactionChoiceSchema.safeParse({ ...choice(), parameters: { ['x'.repeat(80)]: 'x'.repeat(2000) } }).success).toBe(true);
    for (const parameters of [{ ...atLimit, extra: 1 }, { '': true }, { ' ': true },
      { ['x'.repeat(81)]: true }, { value: 'x'.repeat(2001) }]) {
      expect(interactionChoiceSchema.safeParse({ ...choice(), parameters }).success).toBe(false);
    }
  });

  it('returns a detached copy whose subject and parameters cannot change the original', () => {
    const original = choice(), choices = [original], selected = selectInteractionChoice(choices, original.id)!;
    expect(selected).toEqual(original);
    expect(selected).not.toBe(original);
    expect(selected.subject).not.toBe(original.subject);
    expect(selected.parameters).not.toBe(original.parameters);
    selected.subject!.label = 'Changed';
    selected.parameters.topic = 'other';
    selected.label = 'Changed';
    expect(original).toEqual(choice());
    original.subject!.id = 'caller-change';
    original.parameters.quantity = 8;
    expect(selected.subject!.id).toBe('journal');
    expect(selected.parameters.quantity).toBe(1);
  });

  it('returns undefined for an absent ID or an empty choice set', () => {
    expect(selectInteractionChoice([choice()], 'missing')).toBeUndefined();
    expect(interactionChoicesSchema.parse([])).toEqual([]);
    expect(selectInteractionChoice([], 'missing')).toBeUndefined();
  });

  it('validates the entire choice set before returning a match or a miss', () => {
    const invalid = { ...choice('invalid'), parameters: { cost: Infinity } };
    for (const id of ['ask-journal', 'missing']) {
      expect(() => selectInteractionChoice([choice(), invalid], id)).toThrow();
    }
  });
});
