// Asking once at a good moment (spec 4.13): the moment rule, and the one-time prompt showing once
// whatever the answer, only while the permission was never asked, and never by itself at launch.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { Modal, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { getDeviceSetting } from '@/features/settings/device-settings';
import type { PushPermission } from '@/features/push/registration';
import { resetDb } from '@/test/db';

import {
  clearPushMoment,
  householdMateJoined,
  notePushMoment,
  PUSH_ASKED_KEY,
  pushAsked,
  pushMomentPending,
  setPushAsked,
} from '../ask';
import { PushAskPrompt } from '../push-ask-prompt';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));

const mockPermission: { now: PushPermission } = { now: 'undetermined' };
const mockRequest = jest.fn(async (): Promise<PushPermission> => 'granted');
jest.mock('../registration', () => ({
  getPushPermission: async () => mockPermission.now,
  requestPushPermission: () => mockRequest(),
}));

let tree: ReactTestRenderer | null = null;
const flush = () => act(async () => new Promise<void>((resolve) => setImmediate(resolve)));

async function render() {
  await act(async () => {
    tree = create(createElement(PushAskPrompt));
  });
  await flush();
  return tree!.root;
}

const visible = (root: ReactTestInstance) => root.findByType(Modal).props.visible as boolean;
const texts = (root: ReactTestInstance) => root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
const button = (root: ReactTestInstance, label: string) =>
  root.find((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label && typeof n.type !== 'string');

async function moment() {
  await act(async () => notePushMoment());
  await flush();
}

beforeEach(() => {
  resetDb();
  clearPushMoment();
  mockPermission.now = 'undetermined';
  mockRequest.mockClear();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe('householdMateJoined', () => {
  it('is a household that was just you, now with someone else', () => {
    expect(householdMateJoined(['me'], ['me', 'u2'], 'me')).toBe(true);
    expect(householdMateJoined(['me'], ['u2'], 'me')).toBe(true);
  });

  it('is not filling an empty cache, more of the same, or signed out', () => {
    expect(householdMateJoined([], ['me', 'u2'], 'me')).toBe(false);
    expect(householdMateJoined(['me', 'u2'], ['me', 'u2', 'u3'], 'me')).toBe(false);
    expect(householdMateJoined(['me'], ['me'], 'me')).toBe(false);
    expect(householdMateJoined(['me'], [], 'me')).toBe(false);
    expect(householdMateJoined(['me'], ['me', 'u2'], null)).toBe(false);
  });
});

describe('notePushMoment', () => {
  it('marks a moment, and none once the prompt has shown', () => {
    notePushMoment();
    expect(pushMomentPending()).toBe(true);
    clearPushMoment();
    setPushAsked();
    notePushMoment();
    expect(pushMomentPending()).toBe(false);
  });
});

describe('PushAskPrompt', () => {
  it('shows nothing by itself, at launch', async () => {
    const root = await render();
    expect(visible(root)).toBe(false);
    expect(pushAsked()).toBe(false);
  });

  it('shows at a moment with the explanation, Turn on and Not now, and marks the device asked', async () => {
    const root = await render();
    await moment();
    expect(visible(root)).toBe(true);
    expect(texts(root)).toEqual(
      expect.arrayContaining([
        'Turn on notifications?',
        'Know when someone in your household adds to a list or starts shopping.',
      ]),
    );
    expect(getDeviceSetting(PUSH_ASKED_KEY, null)).toBe(true);
    expect(pushMomentPending()).toBe(false);
    expect(button(root, 'Turn on')).toBeTruthy();
    expect(button(root, 'Not now')).toBeTruthy();
  });

  it('Turn on asks for the permission and closes', async () => {
    const root = await render();
    await moment();
    await act(async () => button(root, 'Turn on').props.onPress());
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(visible(root)).toBe(false);
  });

  it("Not now closes without asking, and it doesn't show again", async () => {
    const root = await render();
    await moment();
    await act(async () => button(root, 'Not now').props.onPress());
    expect(visible(root)).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();

    await moment();
    expect(visible(root)).toBe(false);
  });

  it('shows once even after Turn on, and across launches (the device setting)', async () => {
    let root = await render();
    await moment();
    await act(async () => button(root, 'Turn on').props.onPress());
    await moment();
    expect(visible(root)).toBe(false);

    act(() => tree?.unmount());
    root = await render();
    await moment();
    expect(visible(root)).toBe(false);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it.each<PushPermission>(['granted', 'denied', 'unavailable'])(
    "doesn't show when the permission is %s, and stays unasked",
    async (permission) => {
      mockPermission.now = permission;
      const root = await render();
      await moment();
      expect(visible(root)).toBe(false);
      expect(pushAsked()).toBe(false);
      expect(pushMomentPending()).toBe(false);
    },
  );

  it('a moment noted before the prompt mounted still shows it', async () => {
    notePushMoment();
    const root = await render();
    expect(visible(root)).toBe(true);
  });
});
