import { describe, expect, test } from '@jest/globals';

import { ShareEnvelopeSchema } from '@/shared/schemas/share';

import {
  type ChoiceLists,
  defaultHouseholdId,
  defaultListIdIn,
  householdLists,
  initialSaveChoice,
  saveButtonTitle,
  SHARE_SAVED_MESSAGE,
  shareEnvelopeTarget,
} from '../save-choice';

const HOME = '11111111-1111-4111-8111-111111111111';
const CABIN = '22222222-2222-4222-8222-222222222222';
const EMPTY = '33333333-3333-4333-8333-333333333333';
const GROCERIES = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COSTCO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CABIN_LIST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CABIN_SNACKS = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const lists = [
  { id: GROCERIES, householdId: HOME },
  { id: COSTCO, householdId: HOME },
  { id: CABIN_LIST, householdId: CABIN },
  { id: CABIN_SNACKS, householdId: CABIN },
];
const households = [{ id: HOME }, { id: CABIN }, { id: EMPTY }];

const choices = (over: Partial<ChoiceLists> = {}): ChoiceLists => ({
  lastOpenedListId: null,
  defaultListId: null,
  lists,
  households,
  ...over,
});

describe('defaultHouseholdId', () => {
  test("is the last opened list's household", () => {
    expect(defaultHouseholdId(choices({ lastOpenedListId: CABIN_SNACKS, defaultListId: GROCERIES }))).toBe(CABIN);
  });

  test("falls back to the default list's household when the last opened list is gone", () => {
    const gone = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    expect(defaultHouseholdId(choices({ lastOpenedListId: gone, defaultListId: CABIN_LIST }))).toBe(CABIN);
    expect(defaultHouseholdId(choices({ defaultListId: CABIN_LIST }))).toBe(CABIN);
  });

  test("falls back to the first list's household", () => {
    expect(defaultHouseholdId(choices())).toBe(HOME);
    expect(defaultHouseholdId(choices({ lists: [{ id: CABIN_LIST, householdId: CABIN }] }))).toBe(CABIN);
  });

  test('with no lists, is the first household', () => {
    expect(defaultHouseholdId(choices({ lists: [], households: [{ id: EMPTY }, { id: HOME }] }))).toBe(EMPTY);
  });

  test("ignores a list whose household isn't in the snapshot", () => {
    expect(defaultHouseholdId(choices({ lastOpenedListId: CABIN_LIST, households: [{ id: HOME }] }))).toBe(HOME);
  });

  test('is null with no households', () => {
    expect(defaultHouseholdId(choices({ lists: [], households: [] }))).toBeNull();
  });
});

describe('defaultListIdIn', () => {
  test('is the last opened list when it is in the household', () => {
    expect(defaultListIdIn(choices({ lastOpenedListId: COSTCO, defaultListId: GROCERIES }), HOME)).toBe(COSTCO);
  });

  test("skips a last opened or default list in another household, taking the household's first", () => {
    expect(defaultListIdIn(choices({ lastOpenedListId: COSTCO, defaultListId: GROCERIES }), CABIN)).toBe(CABIN_LIST);
  });

  test('then the default list when it is in the household', () => {
    expect(defaultListIdIn(choices({ lastOpenedListId: COSTCO, defaultListId: CABIN_SNACKS }), CABIN)).toBe(
      CABIN_SNACKS,
    );
  });

  test("is null for a household with no lists, or no household", () => {
    expect(defaultListIdIn(choices({ lastOpenedListId: COSTCO }), EMPTY)).toBeNull();
    expect(defaultListIdIn(choices(), null)).toBeNull();
  });

  test('householdLists keeps only that household, in order', () => {
    expect(householdLists(lists, CABIN).map((l) => l.id)).toEqual([CABIN_LIST, CABIN_SNACKS]);
    expect(householdLists(lists, EMPTY)).toEqual([]);
  });
});

describe('saveButtonTitle', () => {
  test('reads Save recipe with the list off, whatever list is picked', () => {
    expect(saveButtonTitle(false, 'Groceries')).toBe('Save recipe');
    expect(saveButtonTitle(false, null)).toBe('Save recipe');
  });

  test('names the list with it on', () => {
    expect(saveButtonTitle(true, 'Costco')).toBe('Save & add to Costco');
    expect(saveButtonTitle(true, null)).toBe('Save & add to list');
  });
});

describe('SHARE_SAVED_MESSAGE', () => {
  test('says the recipe is saved and prepared in the background, not that the app has to be opened', () => {
    expect(SHARE_SAVED_MESSAGE).toBe("Saved. We'll prepare it in the background.");
    expect(SHARE_SAVED_MESSAGE).not.toContain('open The Perfect Bite');
  });
});

describe('shareEnvelopeTarget', () => {
  const envelope = (target: ReturnType<typeof shareEnvelopeTarget>) => ({
    id: '019a0000-0000-7000-8000-000000000000',
    url: 'https://example.com/tikka',
    createdAt: '2026-10-12T09:00:00.000-07:00',
    appVersion: '1.0.0',
    source: 'share',
    ...target,
  });

  test('switch off: the household, addToList false and no list, even with one picked', () => {
    const target = shareEnvelopeTarget(CABIN, false, CABIN_LIST);
    expect(target).toEqual({ householdId: CABIN, addToList: false, listId: null });
    expect(ShareEnvelopeSchema.safeParse(envelope(target)).success).toBe(true);
  });

  test('switch on: the household, addToList true and the list', () => {
    const target = shareEnvelopeTarget(CABIN, true, CABIN_SNACKS);
    expect(target).toEqual({ householdId: CABIN, addToList: true, listId: CABIN_SNACKS });
    expect(ShareEnvelopeSchema.safeParse(envelope(target)).success).toBe(true);
  });

  test('switch on with no list (a household with no lists) saves the recipe only', () => {
    expect(shareEnvelopeTarget(EMPTY, true, null)).toEqual({ householdId: EMPTY, addToList: false, listId: null });
  });
});

describe('initialSaveChoice', () => {
  describe('from the Recipes tab', () => {
    test('the default household and its default list, the switch as remembered (off)', () => {
      expect(initialSaveChoice(choices({ lastOpenedListId: CABIN_SNACKS }), { from: 'recipes', rememberedAddToList: false })).toEqual({
        householdId: CABIN,
        addToList: false,
        listId: CABIN_SNACKS,
      });
    });

    test('the switch as remembered (on)', () => {
      expect(initialSaveChoice(choices(), { from: 'recipes', rememberedAddToList: true })).toEqual({
        householdId: HOME,
        addToList: true,
        listId: GROCERIES,
      });
    });

    test('with no lists: the first household, no list', () => {
      expect(initialSaveChoice(choices({ lists: [] }), { from: 'recipes', rememberedAddToList: true })).toEqual({
        householdId: HOME,
        addToList: true,
        listId: null,
      });
    });

    test('with no households: nothing to choose', () => {
      expect(initialSaveChoice(choices({ lists: [], households: [] }), { from: 'recipes', rememberedAddToList: false })).toEqual({
        householdId: null,
        addToList: false,
        listId: null,
      });
    });
  });

  describe("from a list's menu", () => {
    test("that list's household, the switch on with that list, whatever was last opened", () => {
      expect(initialSaveChoice(choices({ lastOpenedListId: GROCERIES }), { from: 'list', listId: CABIN_SNACKS })).toEqual({
        householdId: CABIN,
        addToList: true,
        listId: CABIN_SNACKS,
      });
    });

    test('a list that is gone falls back to the default rule, switch still on', () => {
      expect(initialSaveChoice(choices({ defaultListId: COSTCO }), { from: 'list', listId: 'gone' })).toEqual({
        householdId: HOME,
        addToList: true,
        listId: COSTCO,
      });
    });
  });

  describe('reopened by a failure', () => {
    test('the same household, switch and list', () => {
      expect(
        initialSaveChoice(choices({ lastOpenedListId: GROCERIES }), {
          from: 'retry',
          householdId: CABIN,
          addToList: true,
          listId: CABIN_SNACKS,
        }),
      ).toEqual({ householdId: CABIN, addToList: true, listId: CABIN_SNACKS });
    });

    test('recipe-only into a household with no lists stays recipe-only there', () => {
      expect(initialSaveChoice(choices(), { from: 'retry', householdId: EMPTY, addToList: false, listId: null })).toEqual({
        householdId: EMPTY,
        addToList: false,
        listId: null,
      });
    });

    test("a household that's gone falls back to the default household", () => {
      expect(
        initialSaveChoice(choices({ lastOpenedListId: CABIN_LIST }), { from: 'retry', householdId: 'gone', addToList: false, listId: null }),
      ).toEqual({ householdId: CABIN, addToList: false, listId: CABIN_LIST });
    });

    test("a list that's gone, or outside the household, gives the household's default list", () => {
      const retry = { from: 'retry', householdId: CABIN, addToList: true } as const;
      expect(initialSaveChoice(choices(), { ...retry, listId: 'gone' }).listId).toBe(CABIN_LIST);
      expect(initialSaveChoice(choices(), { ...retry, listId: GROCERIES }).listId).toBe(CABIN_LIST);
    });
  });
});
