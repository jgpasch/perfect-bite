// The + hint (spec 4.1): a one-time callout over the tab bar's +, after three taps, when add mode ends.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AccessibilityInfo, ActionSheetIOS } from 'react-native';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';

import { pressAddButton, takePendingListAdd } from '../add-button';
import {
  ADD_HINT_SEEN_KEY,
  ADD_HINT_TAP_THRESHOLD,
  ADD_HINT_TIMEOUT_MS,
  ADD_TAP_COUNT_KEY,
  addModeEnded,
  countAddTap,
  dismissAddHint,
  isAddHintVisible,
  markAddHintSeen,
  resetAddHint,
  shouldShowAddHint,
} from '../add-hint';
import { addMenuOpened, showAddMenuSheet } from '../add-menu';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), navigate: jest.fn() }, useFocusEffect: () => {} }));

/** Nothing over the list. */
const onList = () => ({ sheetOpen: false, selecting: false });
let screenReader = false;

beforeEach(() => {
  jest.useFakeTimers();
  // Take down a hint left up by the last test, then forget that it was seen.
  dismissAddHint();
  resetDb();
  screenReader = false;
  jest
    .spyOn(AccessibilityInfo, 'isScreenReaderEnabled')
    .mockClear()
    .mockImplementation(() => Promise.resolve(screenReader));
});

afterEach(() => {
  takePendingListAdd();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const tapCount = () => getDeviceSetting<unknown>(ADD_TAP_COUNT_KEY, 0);
const seen = () => getDeviceSetting<unknown>(ADD_HINT_SEEN_KEY, false);

describe('the constants', () => {
  test('three taps, eight seconds', () => {
    expect(ADD_HINT_TAP_THRESHOLD).toBe(3);
    expect(ADD_HINT_TIMEOUT_MS).toBe(8000);
  });
});

describe('shouldShowAddHint', () => {
  const due = { tapCount: 3, seen: false, screenReaderOn: false, sheetOpen: false, selecting: false };

  test('shows from the third tap, unseen, on the list itself, with VoiceOver off', () => {
    expect(shouldShowAddHint(due)).toBe(true);
    expect(shouldShowAddHint({ ...due, tapCount: 4 })).toBe(true);
  });

  test('not under three taps', () => {
    expect(shouldShowAddHint({ ...due, tapCount: 0 })).toBe(false);
    expect(shouldShowAddHint({ ...due, tapCount: 2 })).toBe(false);
  });

  test('not once seen', () => {
    expect(shouldShowAddHint({ ...due, seen: true })).toBe(false);
  });

  test('not with VoiceOver on', () => {
    expect(shouldShowAddHint({ ...due, screenReaderOn: true })).toBe(false);
  });

  test('not while a sheet is over the list', () => {
    expect(shouldShowAddHint({ ...due, sheetOpen: true })).toBe(false);
  });

  test('not in Select mode', () => {
    expect(shouldShowAddHint({ ...due, selecting: true })).toBe(false);
  });
});

describe('counting taps on +', () => {
  test('each tap on + counts, up to three', () => {
    pressAddButton();
    expect(tapCount()).toBe(1);
    pressAddButton();
    pressAddButton();
    expect(tapCount()).toBe(3);
    pressAddButton();
    countAddTap();
    expect(tapCount()).toBe(3);
  });

  test('a count stored as something else starts over', () => {
    setDeviceSetting(ADD_TAP_COUNT_KEY, 'x');
    countAddTap();
    expect(tapCount()).toBe(1);
  });
});

describe('addModeEnded', () => {
  const tapThrice = () => [1, 2, 3].forEach(() => pressAddButton());

  test('after three taps it shows the hint; it goes after 8 s and is then seen', async () => {
    tapThrice();
    await addModeEnded(onList);
    expect(isAddHintVisible()).toBe(true);
    jest.advanceTimersByTime(ADD_HINT_TIMEOUT_MS - 1);
    expect(isAddHintVisible()).toBe(true);
    jest.advanceTimersByTime(1);
    expect(isAddHintVisible()).toBe(false);
    expect(seen()).toBe(true);
  });

  test('two taps are not enough', async () => {
    pressAddButton();
    pressAddButton();
    await addModeEnded(onList);
    expect(isAddHintVisible()).toBe(false);
    expect(seen()).toBe(false);
  });

  test('dismissing marks it seen, so the next add mode ending shows nothing', async () => {
    tapThrice();
    await addModeEnded(onList);
    dismissAddHint();
    expect(isAddHintVisible()).toBe(false);
    expect(seen()).toBe(true);
    await addModeEnded(onList);
    expect(isAddHintVisible()).toBe(false);
  });

  test('a dismissal with no hint up marks nothing', () => {
    dismissAddHint();
    expect(seen()).toBe(false);
  });

  test('a long-press before the third tap means it never shows', async () => {
    pressAddButton();
    addMenuOpened();
    expect(seen()).toBe(true);
    pressAddButton();
    pressAddButton();
    await addModeEnded(onList);
    expect(isAddHintVisible()).toBe(false);
  });

  test('the VoiceOver action "More ways to add" counts as opening the menu', async () => {
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    showAddMenuSheet(['item', 'recipe']);
    expect(seen()).toBe(true);
    tapThrice();
    await addModeEnded(onList);
    expect(isAddHintVisible()).toBe(false);
  });

  test('a long-press on + while it shows takes it away', async () => {
    tapThrice();
    await addModeEnded(onList);
    addMenuOpened();
    expect(isAddHintVisible()).toBe(false);
    expect(seen()).toBe(true);
  });

  test('with VoiceOver on it is marked seen and never shown', async () => {
    screenReader = true;
    tapThrice();
    await addModeEnded(onList);
    expect(isAddHintVisible()).toBe(false);
    expect(seen()).toBe(true);
  });

  test("VoiceOver isn't asked while the hint isn't due", async () => {
    await addModeEnded(onList);
    expect(AccessibilityInfo.isScreenReaderEnabled).not.toHaveBeenCalled();
  });

  test('not over a sheet or in Select mode, and it stays due for later', async () => {
    tapThrice();
    await addModeEnded(() => ({ sheetOpen: true, selecting: false }));
    await addModeEnded(() => ({ sheetOpen: false, selecting: true }));
    expect(isAddHintVisible()).toBe(false);
    expect(seen()).toBe(false);
    await addModeEnded(onList);
    expect(isAddHintVisible()).toBe(true);
  });

  test('Select mode or a sheet coming up while VoiceOver is asked still stops it', async () => {
    tapThrice();
    let selecting = false;
    jest.mocked(AccessibilityInfo.isScreenReaderEnabled).mockImplementation(() => {
      selecting = true;
      return Promise.resolve(false);
    });
    await addModeEnded(() => ({ sheetOpen: false, selecting }));
    expect(isAddHintVisible()).toBe(false);
  });

  test('dismissed early, its timer is cancelled', async () => {
    tapThrice();
    await addModeEnded(onList);
    jest.advanceTimersByTime(5000);
    markAddHintSeen();
    expect(isAddHintVisible()).toBe(false);
    jest.advanceTimersByTime(ADD_HINT_TIMEOUT_MS);
    expect(isAddHintVisible()).toBe(false);
  });
});

describe('resetAddHint (Settings > Developer)', () => {
  test('clears the seen flag and sets the count to 3, so the next add shows it', async () => {
    markAddHintSeen();
    resetAddHint();
    expect(seen()).toBe(false);
    expect(tapCount()).toBe(3);
    await addModeEnded(onList);
    expect(isAddHintVisible()).toBe(true);
  });
});
