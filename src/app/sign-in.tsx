import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { signInColors } from '@/components/appearance';
import { Button, SurfaceButton } from '@/components/button';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { sendEmailCode, useAccountState, verifyEmailCode } from '@/features/auth/account';
import { useTheme } from '@/hooks/use-theme';

/**
 * Sign-in (board 09): the app's name over a grid of coloured shapes on the primary green, with the
 * dev sign-in (email + 6-digit code) at the bottom. Local Supabase delivers the code to Inbucket
 * (http://127.0.0.1:55324). Google sign-in replaces this in M9 (spec 4.8).
 */
export default function SignInScreen() {
  const account = useAccountState();
  const { colors, aisles, spacing, scheme } = useTheme();
  const look = signInColors(colors, aisles);
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

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      style={{ backgroundColor: look.ground }}
      contentContainerStyle={[styles.fill, { padding: spacing.xl, paddingTop: spacing.xxxl, gap: spacing.xxl }]}>
      {/* Light status bar text on the light scheme's dark green, dark text on the dark scheme's light green. */}
      <StatusBar style={scheme === 'dark' ? 'dark' : 'light'} />
      <Shapes colors={look.shapes} />

      <View style={{ gap: spacing.md }}>
        <ThemedText variant="hero" accessibilityRole="header" style={{ color: look.text }}>
          The Perfect Bite
        </ThemedText>
        <ThemedText variant="lead" style={{ color: look.text }}>
          {account.status === 'unconfigured'
            ? 'Backend not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local, then restart the dev server.'
            : step === 'email'
              ? 'Your household’s shopping list, sorted by aisle and shared in real time.'
              : `Enter the 6-digit code sent to ${email.trim()}.`}
        </ThemedText>
      </View>

      {account.status === 'unconfigured' ? null : (
        <View style={[styles.bottom, { gap: spacing.md }]}>
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
            <ThemedText variant="headline" accessibilityLiveRegion="polite" style={{ color: look.text }}>
              {error}
            </ThemedText>
          ) : null}

          {step === 'email' ? (
            <SurfaceButton
              label={busy ? 'Sending…' : 'Send code'}
              icon="envelope"
              onPress={onSendCode}
              disabled={busy || !email.includes('@')}
            />
          ) : (
            <>
              <SurfaceButton label={busy ? 'Signing in…' : 'Sign in'} onPress={onVerify} disabled={busy || code.trim().length < 6} />
              <Button
                label="Use a different email"
                variant="plain"
                color="onPrimary"
                onPress={() => setStep('email')}
                disabled={busy}
              />
            </>
          )}
          <ThemedText variant="footnote" style={[styles.center, { color: look.text }]}>
            New here? We’ll set up your household and a Groceries list.
          </ThemedText>
        </View>
      )}
    </Screen>
  );
}

/** Board 09's 3 × 2 grid of rounded shapes. Decorative. */
function Shapes({ colors }: { colors: string[] }) {
  const { spacing, sizes, rounded } = useTheme();
  const square = rounded.card;
  const round = sizes.signInShape / 2;
  // Corners per shape: top-left, top-right, bottom-right, bottom-left.
  const corners = [
    [square, square, square, square],
    [round, round, round, round],
    [square, square, round, square],
    [round, square, square, square],
    [square, square, square, square],
    [round, round, round, round],
  ];
  const gap = spacing.sm + spacing.xxs;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ gap }}>
      {[0, 3].map((start) => (
        <View key={start} style={[styles.row, { gap }]}>
          {colors.slice(start, start + 3).map((color, i) => {
            const [tl, tr, br, bl] = corners[start + i];
            return (
              <View
                key={i}
                style={[
                  styles.shape,
                  {
                    height: sizes.signInShape,
                    backgroundColor: color,
                    borderTopLeftRadius: tl,
                    borderTopRightRadius: tr,
                    borderBottomRightRadius: br,
                    borderBottomLeftRadius: bl,
                  },
                ]}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flexGrow: 1 },
  bottom: { marginTop: 'auto' },
  row: { flexDirection: 'row' },
  shape: { flex: 1, borderCurve: 'continuous' },
  center: { textAlign: 'center' },
});
