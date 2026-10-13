import { describe, expect, it } from '@jest/globals';

import { ListSnapshotSchema, SiriEnvelopeSchema } from '../schemas/siri';
import snapshotFixture from './fixtures/list-snapshot.json';
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

// The app writes lists.json and Swift (SiriQueue.ListSnapshot) reads it; the fixture is the
// shape the app writes, which ListSnapshot must decode.
describe('ListSnapshotSchema', () => {
  const HOME = '019a4c0f-0000-7000-8000-0000000000a1';

  it('accepts lists across households with an optional default and the last opened list', () => {
    const snapshot = {
      defaultListId: '019a4c10-0000-7000-8000-00000000a001',
      lastOpenedListId: '019a4c10-0000-7000-8000-00000000c057',
      lists: [
        { id: '019a4c10-0000-7000-8000-00000000a001', name: 'Groceries', householdId: HOME, householdName: 'Test home' },
        { id: '019a4c10-0000-7000-8000-00000000c057', name: 'Costco', householdId: HOME, householdName: 'Test home' },
      ],
      households: [{ id: HOME, name: 'Test home' }],
    };
    expect(ListSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const empty = { lastOpenedListId: null, lists: [], households: [] };
    expect(ListSnapshotSchema.parse(empty)).toEqual(empty);
  });

  it("lists every household, including one with no lists, and each list's household", () => {
    const parsed = ListSnapshotSchema.parse(snapshotFixture);
    expect(parsed.households).toEqual([
      { id: HOME, name: 'Test home' },
      { id: '019a4c0f-0000-7000-8000-0000000000b1', name: 'Lake house' },
      { id: '019a4c0f-0000-7000-8000-0000000000c1', name: "Mom's" },
    ]);
    expect(parsed.lists.map((l) => l.householdId)).toEqual([HOME, HOME, '019a4c0f-0000-7000-8000-0000000000b1']);
  });

  it('requires households, and a household id on each list', () => {
    const { households: _households, ...noHouseholds } = snapshotFixture;
    expect(ListSnapshotSchema.safeParse(noHouseholds).success).toBe(false);
    const [first, ...rest] = snapshotFixture.lists;
    const { householdId: _householdId, ...noHouseholdId } = first;
    expect(ListSnapshotSchema.safeParse({ ...snapshotFixture, lists: [noHouseholdId, ...rest] }).success).toBe(false);
    expect(ListSnapshotSchema.safeParse({ ...snapshotFixture, households: [{ id: 'home', name: 'Home' }] }).success).toBe(
      false,
    );
  });

  it('round-trips through JSON, keeping lastOpenedListId (null included)', () => {
    const parsed = ListSnapshotSchema.parse(snapshotFixture);
    expect(parsed.lastOpenedListId).toBe('019a4c10-0000-7000-8000-00000000c057');
    expect(ListSnapshotSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(snapshotFixture);
    const none = { ...parsed, lastOpenedListId: null };
    expect(JSON.stringify(ListSnapshotSchema.parse(none))).toContain('"lastOpenedListId":null');
  });

  it('requires lastOpenedListId, and a UUID when set', () => {
    expect(ListSnapshotSchema.safeParse({ lists: [], households: [] }).success).toBe(false);
    expect(ListSnapshotSchema.safeParse({ lastOpenedListId: 'groceries', lists: [], households: [] }).success).toBe(false);
  });
});
