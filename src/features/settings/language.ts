import { deviceLanguage, initI18n, type Language, LANGUAGES } from '@/i18n';

import { clearDeviceSetting, getDeviceSetting, setDeviceSetting } from './device-settings';

/** Settings > Language (spec 4.15): a language picked on this device, or none to follow the phone. */
export const LANGUAGE_KEY = 'app.language';

/** The language picked in Settings, or `null` when the app follows the phone. */
export function getLanguageChoice(): Language | null {
  const value = getDeviceSetting<unknown>(LANGUAGE_KEY, null);
  return LANGUAGES.find((language) => language === value) ?? null;
}

/** Saves the choice (`null`: follow the phone) and switches the app's strings at once. */
export function setLanguageChoice(choice: Language | null): void {
  if (choice) setDeviceSetting(LANGUAGE_KEY, choice);
  else clearDeviceSetting(LANGUAGE_KEY);
  initI18n(choice ?? deviceLanguage());
}

/**
 * The language to start in: the one picked in Settings, else the phone's. The root layout reads it
 * before the database's migrations have run, so on a first launch (no settings table yet) it's the
 * phone's.
 */
export function startupLanguage(): Language {
  try {
    return getLanguageChoice() ?? deviceLanguage();
  } catch {
    return deviceLanguage();
  }
}
