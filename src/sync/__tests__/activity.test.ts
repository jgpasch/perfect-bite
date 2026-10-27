// What push and pull report for the sync status (spec 7.5).
import { beforeEach, expect, jest, test } from '@jest/globals';

import { getSyncActivity, reportSyncActivity, resetSyncActivity, subscribeSyncActivity } from '../activity';

beforeEach(() => {
  resetSyncActivity();
});

test('starts idle, with connectivity unknown', () => {
  expect(getSyncActivity()).toEqual({ pushing: false, pulling: false, online: null });
});

test('a patch changes only its own fields and makes a new snapshot', () => {
  const before = getSyncActivity();
  reportSyncActivity({ pulling: true });
  const after = getSyncActivity();
  expect(after).not.toBe(before);
  expect(after).toEqual({ pushing: false, pulling: true, online: null });
  expect(before).toEqual({ pushing: false, pulling: false, online: null });
});

test('a patch that changes nothing keeps the same snapshot and tells no one', () => {
  reportSyncActivity({ online: true });
  const listener = jest.fn();
  subscribeSyncActivity(listener);
  const before = getSyncActivity();

  reportSyncActivity({ online: true });
  reportSyncActivity({});
  reportSyncActivity({ pushing: false, pulling: false });

  expect(getSyncActivity()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
});

test('online false and null are different', () => {
  reportSyncActivity({ online: false });
  const listener = jest.fn();
  subscribeSyncActivity(listener);
  reportSyncActivity({ online: null });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(getSyncActivity().online).toBeNull();
});

test('every listener hears each change once, and an unsubscribed one stops hearing', () => {
  const a = jest.fn();
  const b = jest.fn();
  const stopA = subscribeSyncActivity(a);
  subscribeSyncActivity(b);

  reportSyncActivity({ pushing: true });
  stopA();
  stopA();
  reportSyncActivity({ pushing: false });

  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(2);
});

test('a listener that unsubscribes another while being told does not stop that one hearing this change', () => {
  const heard: string[] = [];
  let stopB = () => {};
  subscribeSyncActivity(() => {
    heard.push('a');
    stopB();
  });
  stopB = subscribeSyncActivity(() => heard.push('b'));

  reportSyncActivity({ pulling: true });
  reportSyncActivity({ pulling: false });

  expect(heard).toEqual(['a', 'b', 'a']);
});

test('a listener reads the new snapshot', () => {
  const seen: boolean[] = [];
  subscribeSyncActivity(() => seen.push(getSyncActivity().pushing));
  reportSyncActivity({ pushing: true });
  reportSyncActivity({ pushing: false });
  expect(seen).toEqual([true, false]);
});

test('resetSyncActivity goes back to idle without telling listeners', () => {
  reportSyncActivity({ pushing: true, pulling: true, online: true });
  const listener = jest.fn();
  subscribeSyncActivity(listener);
  resetSyncActivity();
  expect(getSyncActivity()).toEqual({ pushing: false, pulling: false, online: null });
  expect(listener).not.toHaveBeenCalled();
});
