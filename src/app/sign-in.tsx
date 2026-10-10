import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, PrimaryButton } from '@/components/button';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { sendEmailCode, useAccountState, verifyEmailCode } from '@/features/auth/account';
import { useTheme } from '@/hooks/use-theme';

/**
 * Dev sign-in: email + 6-digit code. Local Supabase delivers the code to Inbucket
 * (http://127.0.0.1:55324). Google sign-in replaces this in M9 (spec 4.8).
 */
export default function SignInScreen() {
  const account = useAccountState();
  const { spacing } = useTheme();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSendCode = () =>
    run(async () => {
      await sendEmailCode(email.trim());
      setStep('code');
    });
  const onVerify = () => run(() => verifyEmailCode(email.trim(), code.trim()));

  if (account.status === 'unconfigured') {
    return (
      <Screen scroll contentContainerStyle={[styles.center, { padding: spacing.xl, gap: spacing.md }]}>
        <ThemedText variant="title" accessibilityRole="header">
          Backend not configured
        </ThemedText>
        <ThemedText variant="body" color="inkSecondary">
          Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local, then restart the dev server.
        </ThemedText>
      </Screen>
    );
  }

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.center, { padding: spacing.xl, gap: spacing.lg }]}>
      <View style={{ gap: spacing.xs }}>
        <ThemedText variant="largeTitle" accessibilityRole="header">
          The Perfect Bite
        </ThemedText>
        <ThemedText variant="body" color="inkSecondary">
          {step === 'email' ? 'Sign in to share lists with your household.' : `Enter the 6-digit code sent to ${email.trim()}.`}
        </ThemedText>
      </View>

      {step === 'email' ? (
        <TextField
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          accessibilityLabel="Email"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="send"
          onSubmitEditing={onSendCode}
          autoFocus
        />
      ) : (
        <TextField
          value={code}
          onChangeText={setCode}
          placeholder="123456"
          accessibilityLabel="Sign-in code"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={6}
          returnKeyType="done"
          onSubmitEditing={onVerify}
          autoFocus
        />
      )}

      {error ? (
        <ThemedText variant="footnote" color="danger" accessibilityLiveRegion="polite">
          {error}
        </ThemedText>
      ) : null}

      {step === 'email' ? (
        <PrimaryButton label={busy ? 'Sending…' : 'Send code'} onPress={onSendCode} disabled={busy || !email.includes('@')} />
      ) : (
        <View style={{ gap: spacing.sm }}>
          <PrimaryButton label={busy ? 'Signing in…' : 'Sign in'} onPress={onVerify} disabled={busy || code.trim().length < 6} />
          <Button label="Use a different email" variant="plain" onPress={() => setStep('email')} disabled={busy} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flexGrow: 1, justifyContent: 'center' },
});
