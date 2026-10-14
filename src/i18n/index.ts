import { getLocales } from 'expo-localization';
import { createInstance } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';

import { en } from './en';
import { es } from './es';
import { type Language, resolveLanguage, SUPPORTED_LANGUAGES } from './languages';

export { type Language, LANGUAGES, resolveLanguage, SUPPORTED_LANGUAGES } from './languages';

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
  }
}

/** The app's i18next instance; components use `useT()`, other code `i18n.t`. */
export const i18n = createInstance();

/** The phone's choice (spec 4.15), or `EXPO_PUBLIC_FORCE_LANGUAGE` in development. */
export function deviceLanguage(): Language {
  return resolveLanguage(getLocales(), SUPPORTED_LANGUAGES, process.env.EXPO_PUBLIC_FORCE_LANGUAGE);
}

/**
 * Loads the strings in `language`. The root layout calls it once, before the first render; the
 * Jest setup calls it with English. Calling it again only changes the language.
 */
export function initI18n(language: Language): void {
  if (i18n.isInitialized) {
    i18n.changeLanguage(language);
    return;
  }
  i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, es: { translation: withManyPlurals(es) } },
    lng: language,
    fallbackLng: 'en',
    // The resources are bundled, so this finishes before it returns.
    initAsync: false,
    // React escapes what it renders.
    interpolation: { escapeValue: false },
  });
  if (__DEV__) warnMissingIntl();
}

type StringTree = { [key: string]: string | StringTree };

/**
 * The strings with a `_many` copy of each `_other` plural that has none. Spanish plural rules put a
 * million (1000000) in a `many` category, which `en.ts`'s keys can't have; without the copy i18next
 * would fall back to English for it.
 */
export function withManyPlurals<T extends StringTree>(strings: T): T {
  const out: StringTree = {};
  for (const [key, value] of Object.entries(strings)) {
    out[key] = typeof value === 'string' ? value : withManyPlurals(value);
    const many = key.endsWith('_other') ? `${key.slice(0, -'_other'.length)}_many` : null;
    if (many && typeof value === 'string' && !(many in strings)) out[many] = value;
  }
  return out as T;
}

/** The app's language, once `initI18n` has run. */
export function currentLanguage(): Language {
  return (i18n.language as Language | undefined) ?? 'en';
}

/** `t` for the app's strings: `t('signIn.sendCode')`, `t('signIn.codeSent', { email })`. */
export function useT() {
  return useTranslation().t;
}

/**
 * Keeps a module-level string in the app's language: runs `update` now (once `initI18n` has run) and
 * whenever the language changes, since a module can load before the root layout initializes.
 */
export function onLanguageChanged(update: () => void): void {
  if (i18n.isInitialized) update();
  i18n.on('languageChanged', update);
}

/** A date in the app's language, e.g. `formatDate(d, { weekday: 'long' })` → "Tuesday". */
export function formatDate(date: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(currentLanguage(), options).format(date);
}

/** A number in the app's language, e.g. `formatNumber(1234.5)` → "1,234.5". */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLanguage(), options).format(value);
}

/** Plurals, dates and relative times need these; say so in development if the engine lacks one. */
function warnMissingIntl() {
  const missing = (['PluralRules', 'DateTimeFormat', 'NumberFormat', 'RelativeTimeFormat'] as const).filter(
    (api) => typeof Intl === 'undefined' || typeof Intl[api] !== 'function',
  );
  if (missing.length > 0) console.warn(`i18n: this engine has no Intl.${missing.join(', Intl.')}`);
}
