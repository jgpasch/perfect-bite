/** Every language the app has strings for (spec 4.15). */
export const LANGUAGES = ['en', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Each language's name in itself, as a language picker shows it whatever the app's language. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', es: 'Español' };

/**
 * The languages users get from their phone's settings. Spanish is added when it's switched on;
 * until then it shows only when forced (`EXPO_PUBLIC_FORCE_LANGUAGE=es`).
 */
export const SUPPORTED_LANGUAGES: readonly Language[] = ['en'];

/** The part of expo-localization's `Locale` the choice reads. */
export type LocaleLike = { languageCode: string | null };

function asLanguage(code: string | null | undefined): Language | null {
  const lower = code?.trim().toLowerCase();
  return LANGUAGES.find((language) => language === lower) ?? null;
}

/**
 * The app's language: `forced` if it names a language the app has strings for (even one not yet
 * in `supported`, for development), else the first of the phone's `locales` whose language is
 * supported (any `es-*` is Spanish), else English.
 */
export function resolveLanguage(
  locales: readonly LocaleLike[],
  supported: readonly Language[],
  forced?: string | null,
): Language {
  const force = asLanguage(forced);
  if (force) return force;
  for (const locale of locales) {
    const language = asLanguage(locale.languageCode);
    if (language && supported.includes(language)) return language;
  }
  return 'en';
}
