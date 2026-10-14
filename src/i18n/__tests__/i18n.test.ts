// Spec 4.15: which language the app picks, the strings in each, and the Intl helpers.
import { afterEach, describe, expect, it } from '@jest/globals';

import { en } from '@/i18n/en';
import { es } from '@/i18n/es';
import { currentLanguage, deviceLanguage, formatDate, formatNumber, i18n, initI18n } from '@/i18n';
import { resolveLanguage, SUPPORTED_LANGUAGES } from '@/i18n/languages';

const locale = (languageCode: string | null) => ({ languageCode });

describe('resolveLanguage', () => {
  it('uses the forced language, even one not yet supported', () => {
    expect(resolveLanguage([locale('en')], ['en'], 'es')).toBe('es');
    expect(resolveLanguage([locale('es')], ['en', 'es'], 'en')).toBe('en');
  });

  it('reads the forced value case- and space-insensitively', () => {
    expect(resolveLanguage([locale('en')], ['en'], ' ES ')).toBe('es');
  });

  it('ignores a forced value that is empty or a language the app has no strings for', () => {
    expect(resolveLanguage([locale('es')], ['en', 'es'], '')).toBe('es');
    expect(resolveLanguage([locale('es')], ['en', 'es'], 'fr')).toBe('es');
    expect(resolveLanguage([locale('es')], ['en', 'es'], null)).toBe('es');
    expect(resolveLanguage([locale('es')], ['en', 'es'])).toBe('es');
  });

  it('gives es-MX and es-US Spanish once Spanish is supported', () => {
    // expo-localization's languageCode for es-MX and es-US is "es".
    expect(resolveLanguage([locale('es')], ['en', 'es'])).toBe('es');
    expect(resolveLanguage([{ languageCode: 'es', languageTag: 'es-US' } as { languageCode: string }], ['en', 'es'])).toBe('es');
  });

  it('keeps Spanish phones in English while Spanish is not supported', () => {
    expect(resolveLanguage([locale('es')], SUPPORTED_LANGUAGES)).toBe('en');
  });

  it('takes the first supported language in the phone’s order', () => {
    expect(resolveLanguage([locale('fr'), locale('es')], ['en', 'es'])).toBe('es');
    expect(resolveLanguage([locale('fr'), locale('en'), locale('es')], ['en', 'es'])).toBe('en');
  });

  it('falls back to English when nothing is supported', () => {
    expect(resolveLanguage([locale('fr'), locale('de')], ['en', 'es'])).toBe('en');
    expect(resolveLanguage([locale(null)], ['es'])).toBe('en');
    expect(resolveLanguage([], ['en', 'es'])).toBe('en');
  });

  it('ships with English only', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['en']);
  });
});

describe('deviceLanguage', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_FORCE_LANGUAGE;
  });

  it('is English for the test phone (en-US)', () => {
    expect(deviceLanguage()).toBe('en');
  });

  it('honours EXPO_PUBLIC_FORCE_LANGUAGE', () => {
    process.env.EXPO_PUBLIC_FORCE_LANGUAGE = 'es';
    expect(deviceLanguage()).toBe('es');
  });
});

/** Every key path in a strings object. */
function keys(strings: object, prefix = ''): string[] {
  return Object.entries(strings).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`),
  );
}

describe('strings', () => {
  afterEach(() => initI18n('en'));

  it('tests run in English', () => {
    expect(currentLanguage()).toBe('en');
    expect(i18n.t('signIn.sendCode')).toBe('Send code');
  });

  it('Spanish has exactly English’s keys, none empty', () => {
    expect(keys(es)).toEqual(keys(en));
    expect(keys(es).filter((key) => !i18n.t(key as 'signIn.email', { lng: 'es' }).trim())).toEqual([]);
  });

  it('fills in values without escaping them', () => {
    expect(i18n.t('signIn.codeSent', { email: 'a&b@x.com' })).toBe('Enter the 6-digit code sent to a&b@x.com.');
  });

  it('switches language when initialized again', () => {
    initI18n('es');
    expect(currentLanguage()).toBe('es');
    expect(i18n.t('signIn.sendCode')).toBe('Enviar código');
    expect(i18n.t('signIn.codeSent', { email: 'ana@x.mx' })).toBe('Escribe el código de 6 dígitos que enviamos a ana@x.mx.');
  });
});

describe('formatDate and formatNumber', () => {
  afterEach(() => initI18n('en'));
  const tuesday = new Date(2026, 9, 13, 12);

  it('use English by default', () => {
    expect(formatDate(tuesday, { weekday: 'long' })).toBe('Tuesday');
    expect(formatDate(tuesday, { month: 'long', day: 'numeric' })).toBe('October 13');
    expect(formatNumber(1234.5)).toBe('1,234.5');
  });

  it('follow the app’s language', () => {
    initI18n('es');
    expect(formatDate(tuesday, { weekday: 'long' })).toBe('martes');
    expect(formatDate(tuesday, { month: 'long', day: 'numeric' })).toBe('13 de octubre');
    expect(formatNumber(0.5)).toBe('0,5');
  });
});
