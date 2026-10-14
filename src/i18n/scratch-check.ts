// Typecheck-only proof (spec 4.15) that a language's strings must have exactly en.ts's keys:
// `yarn tsc` fails if either line below stops being an error.
import { en, type Strings } from './en';

// @ts-expect-error an extra key
export const withExtraKey = { signIn: { ...en.signIn, extra: '' } } satisfies Strings;

// @ts-expect-error a missing key
export const withMissingKey = { signIn: { appName: '' } } satisfies Strings;
