// The outbox's "something new to push" signal, from `mutate.ts` to the push.
import { afterEach, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households } from '@/db';
import { resetDb } from '@/test/db';

import { insertRow, updateRows } from '../mutate';
import { notifyOutboxWrite, onOutboxWrite } from '../outbox-signal';

jest.mock('@/db/client', () => require('@/test/db'));

let cleanups: (() => void)[] = [];
const listen = (listener: () => void) => {
  const stop = onOutboxWrite(listener);
  cleanups.push(stop);
  return stop;
};

afterEach(() => {
  for (const stop of cleanups) stop();
  cleanups = [];
});

test('with no listener, a notify does nothing', () => {
  expect(() => notifyOutboxWrite()).not.toThrow();
});

test('the listener hears every notify', () => {
  const listener = jest.fn();
  listen(listener);
  notifyOutboxWrite();
  notifyOutboxWrite();
  expect(listener).toHaveBeenCalledTimes(2);
});

test('there is one listener: a new one replaces the old', () => {
  const first = jest.fn();
  const second = jest.fn();
  listen(first);
  listen(second);
  notifyOutboxWrite();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

test("the cleanup removes its own listener, but not one that replaced it", () => {
  const first = jest.fn();
  const second = jest.fn();
  const stopFirst = listen(first);
  const stopSecond = listen(second);

  stopFirst();
  notifyOutboxWrite();
  expect(second).toHaveBeenCalledTimes(1);

  stopSecond();
  notifyOutboxWrite();
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});

test('each enqueued mutation notifies once', () => {
  resetDb();
  const listener = jest.fn();
  listen(listener);
  insertRow(db, households, { id: 'h1', name: 'Home' });
  expect(listener).toHaveBeenCalledTimes(1);
  updateRows(db, households, eq(households.id, 'h1'), { name: 'Cabin' });
  expect(listener).toHaveBeenCalledTimes(2);
  // Nothing matched, nothing enqueued.
  updateRows(db, households, eq(households.id, 'nope'), { name: 'X' });
  expect(listener).toHaveBeenCalledTimes(2);
});
