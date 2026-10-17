// Jest's stand-in for expo-notifications, used by every test that doesn't mock it itself. The real
// module warns about Expo Go on import and needs its native module. Tests that care about push
// (src/features/push/__tests__) pass their own factory to jest.mock.
import { jest } from '@jest/globals';

export const DEFAULT_ACTION_IDENTIFIER = 'expo.modules.notifications.actions.DEFAULT';
export const AndroidImportance = { DEFAULT: 3 };

export const getPermissionsAsync = jest.fn(async () => ({ status: 'undetermined' }));
export const requestPermissionsAsync = jest.fn(async () => ({ status: 'undetermined' }));
export const getExpoPushTokenAsync = jest.fn(async () => ({ type: 'expo', data: '' }));
export const setNotificationChannelAsync = jest.fn(async () => null);
export const addPushTokenListener = jest.fn(() => ({ remove: () => {} }));
export const setNotificationHandler = jest.fn();
export const useLastNotificationResponse = jest.fn(() => null);
export const getPresentedNotificationsAsync = jest.fn(async () => []);
export const dismissNotificationAsync = jest.fn(async () => {});
