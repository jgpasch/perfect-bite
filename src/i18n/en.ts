/**
 * The app's English strings, the source every other language follows (spec 4.15). Grouped by
 * feature; `{{name}}` is filled in by `t`. `es.ts` must have exactly these keys.
 */
export const en = {
  signIn: {
    appName: 'The Perfect Bite',
    appNameStart: 'The ',
    appNameAccent: 'Perfect',
    appNameEnd: ' Bite',
    unconfigured:
      'Backend not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local, then restart the dev server.',
    tagline: 'The shopping list app that helps you get the perfect bite.',
    codeSent: 'Enter the 6-digit code sent to {{email}}.',
    continueWithGoogle: 'Continue with Google',
    signingIn: 'Signing in…',
    email: 'Email',
    code: 'Sign-in code',
    codePlaceholder: '123456',
    sendCode: 'Send code',
    sending: 'Sending…',
    signIn: 'Sign in',
    differentEmail: 'Use a different email',
    newHere: 'New here? We’ll set up your household and a Groceries list.',
  },
};

/** Every language's strings: `en`'s shape, with a string at each leaf. */
export type Strings = StringsOf<typeof en>;

type StringsOf<T> = { [K in keyof T]: T[K] extends string ? string : StringsOf<T[K]> };
