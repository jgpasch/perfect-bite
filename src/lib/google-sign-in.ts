// Native Google Sign-In (spec 4.8): the SDK shows the account picker and returns a Google ID token,
// which Supabase exchanges for a session with signInWithIdToken. Needs a development build; the
// iOS URL scheme is set on the config plugin in app.json.
import {
  GoogleSignin,
  isCancelledResponse,
  isErrorWithCode,
  statusCodes,
} from '@react-native-google-signin/google-signin';

import { i18n } from '@/i18n';

const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;

/** False until EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID / _IOS_CLIENT_ID are set (see .env.example). */
export const isGoogleConfigured = !!webClientId && !!iosClientId;

let configured = false;

/**
 * Shows Google's account picker and returns the ID token, or null if the user cancelled.
 * The web client ID is what makes Google include an ID token; Supabase accepts both client IDs.
 */
export async function getGoogleIdToken(): Promise<string | null> {
  if (!isGoogleConfigured) throw new Error(i18n.t('errors.googleNotConfigured'));
  if (!configured) {
    GoogleSignin.configure({ webClientId, iosClientId });
    configured = true;
  }
  try {
    const response = await GoogleSignin.signIn();
    if (isCancelledResponse(response)) return null;
    if (!response.data.idToken) throw new Error(i18n.t('errors.googleNoToken'));
    return response.data.idToken;
  } catch (err) {
    if (isErrorWithCode(err) && err.code === statusCodes.IN_PROGRESS) return null;
    throw err;
  }
}

/** Forgets the Google account so the next sign-in shows the picker again. */
export async function signOutOfGoogle(): Promise<void> {
  if (!configured) return;
  await GoogleSignin.signOut();
}
