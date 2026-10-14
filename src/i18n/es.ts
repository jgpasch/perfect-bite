import type { Strings } from './en';

/**
 * Mexican Spanish (spec 4.15: *tú*, Mexican food words). `satisfies Strings` makes a missing or
 * extra key fail the typecheck. A native speaker reviews these before Spanish is switched on.
 */
export const es = {
  signIn: {
    appName: 'The Perfect Bite',
    appNameStart: 'The ',
    appNameAccent: 'Perfect',
    appNameEnd: ' Bite',
    unconfigured:
      'El backend no está configurado. Define EXPO_PUBLIC_SUPABASE_URL y EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY en .env.local y reinicia el servidor de desarrollo.',
    tagline: 'La app de lista del súper que te ayuda a lograr el bocado perfecto.',
    codeSent: 'Escribe el código de 6 dígitos que enviamos a {{email}}.',
    continueWithGoogle: 'Continuar con Google',
    signingIn: 'Iniciando sesión…',
    email: 'Correo',
    code: 'Código de inicio de sesión',
    codePlaceholder: '123456',
    sendCode: 'Enviar código',
    sending: 'Enviando…',
    signIn: 'Iniciar sesión',
    differentEmail: 'Usar otro correo',
    newHere: '¿Eres nuevo? Vamos a crear tu hogar y una lista del súper.',
  },
} satisfies Strings;
