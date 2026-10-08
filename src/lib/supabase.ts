// Supabase client (docs.expo.dev/guides/using-supabase). The session lives in expo-sqlite's
// localStorage. TODO(spec 4.9): move the session to the shared Keychain group so the Siri intent
// can upload directly; depends on the token-refresh spike (docs/spikes.md).
import 'expo-sqlite/localStorage/install';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** False until EXPO_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY are set (see README "Local backend"). */
export const isSupabaseConfigured = !!url && !!publishableKey;

export const supabase: SupabaseClient = createClient(url ?? 'http://supabase.invalid', publishableKey ?? 'missing', {
  auth: {
    storage: localStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
