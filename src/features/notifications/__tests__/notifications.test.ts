import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  clearNotifications,
  currentNotification,
  dismissNotification,
  notify,
  onNotificationsChange,
  type AppNotification,
} from '../notifications';

function notification(id: string, title = id): AppNotification {
  return { id, kind: 'recipeImport', icon: 'fork.knife', hue: 'green', tone: 'success', title };
}

afterEach(clearNotifications);

describe('the queue', () => {
  test('nothing posted shows nothing', () => {
    expect(currentNotification()).toBeNull();
  });

  test('notifications show one at a time, in the order posted', () => {
    notify(notification('a'));
    notify(notification('b'));
    expect(currentNotification()?.id).toBe('a');
    dismissNotification('a');
    expect(currentNotification()?.id).toBe('b');
    dismissNotification('b');
    expect(currentNotification()).toBeNull();
  });

  test('posting an id again replaces it in place', () => {
    notify(notification('a'));
    notify(notification('b'));
    notify(notification('a', 'Again'));
    expect(currentNotification()?.title).toBe('Again');
    dismissNotification('a');
    expect(currentNotification()?.id).toBe('b');
  });

  test('a waiting notification can be dismissed before it shows', () => {
    notify(notification('a'));
    notify(notification('b'));
    dismissNotification('b');
    dismissNotification('a');
    expect(currentNotification()).toBeNull();
  });

  test('clearing drops them all', () => {
    notify(notification('a'));
    notify(notification('b'));
    clearNotifications();
    expect(currentNotification()).toBeNull();
  });
});

describe('listeners', () => {
  test('hear posts, replacements and dismissals, and stop when unsubscribed', () => {
    const listener = jest.fn();
    const stop = onNotificationsChange(listener);
    notify(notification('a'));
    notify(notification('a', 'Again'));
    dismissNotification('a');
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    notify(notification('b'));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  test("aren't told about a dismissal or clear that changes nothing", () => {
    const listener = jest.fn();
    const stop = onNotificationsChange(listener);
    dismissNotification('missing');
    clearNotifications();
    expect(listener).not.toHaveBeenCalled();
    stop();
  });
});
