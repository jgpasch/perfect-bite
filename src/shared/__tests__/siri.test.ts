import { describe, expect, it } from '@jest/globals';

import { ListSnapshotSchema, SiriEnvelopeSchema } from '../schemas/siri';
import defaultList from './fixtures/siri-envelope.default-list.json';
import namedList from './fixtures/siri-envelope.named-list.json';

// Contract test: the fixtures are JSON as targets/_shared/SiriQueue.swift encodes it
// (JSONEncoder omits nil optionals). Update both sides together.
describe('SiriEnvelopeSchema', () => {
  it('accepts an add to the default list (no listId)', () => {
    expect(SiriEnvelopeSchema.parse(defaultList).listId).toBeUndefined();
  });

  it('accepts an add to a named list', () => {
    expect(SiriEnvelopeSchema.parse(namedList).listId).toBe('019a4c10-0000-7000-8000-00000000c057');
  });

  it('rejects empty text and other sources', () => {
    expect(SiriEnvelopeSchema.safeParse({ ...defaultList, text: '' }).success).toBe(false);
    expect(SiriEnvelopeSchema.safeParse({ ...defaultList, source: 'manual' }).success).toBe(false);
  });
});

describe('ListSnapshotSchema', () => {
  it('accepts lists across households with an optional default', () => {
    const snapshot = {
      defaultListId: '019a4c10-0000-7000-8000-00000000a001',
      lists: [
        { id: '019a4c10-0000-7000-8000-00000000a001', name: 'Groceries', householdName: 'Test home' },
        { id: '019a4c10-0000-7000-8000-00000000c057', name: 'Costco', householdName: 'Test home' },
      ],
    };
    expect(ListSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(ListSnapshotSchema.parse({ lists: [] })).toEqual({ lists: [] });
  });
});
