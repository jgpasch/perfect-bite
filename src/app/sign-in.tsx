import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { signInColors } from '@/components/appearance';
import { Button, SurfaceButton } from '@/components/button';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import {
  devPasswordSignIn,
  isDevPasswordEmail,
  sendEmailCode,
  signInWithGoogle,
  useAccountState,
  verifyEmailCode,
} from '@/features/auth/account';
import { signInOverflows, signInShapeHeight } from '@/features/auth/sign-in-layout';
import { useKeyboardVisible } from '@/hooks/use-keyboard-visible';
import { isGoogleConfigured } from '@/lib/google-sign-in';
import { useTheme } from '@/hooks/use-theme';

/**
 * Sign-in (board 09): the app's name at the top, Google sign-in at the bottom, and a grid of
 * coloured shapes filling the space between, on the primary green (spec 4.8). Dev builds also get
 * the email + 6-digit code stub; local Supabase delivers the code to Inbucket
 * (http://127.0.0.1:55324).
 */
export default function SignInScreen() {
  const account = useAccountState();
  const { colors, aisles, spacing, scheme } = useTheme();
  const look = signInColors(colors, aisles);
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const [frameHeight, setFrameHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const overflows = signInOverflows(contentHeight, frameHeight);

  // When it can't all fit above the keyboard (a small phone, a large text size), keep the field
  // and its button in view rather than the title.
  useEffect(() => {
    if (keyboardVisible && overflows) scrollRef.current?.scrollToEnd({ animated: false });
  }, [keyboardVisible, overflows, frameHeight, contentHeight, step]);

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
      if (isDevPasswordEmail(email)) return devPasswordSignIn(email);
      await sendEmailCode(email.trim());
      setStep('code');
    });
  const onVerify = () => run(() => verifyEmailCode(email.trim(), code.trim()));
  const onGoogle = () => run(signInWithGoogle);

  return (
    // The screen is exactly the device's height. The safe-area insets are padding inside it, not the
    // scroll view's automatic content insets (which made the flexGrow: 1 content overflow by their
    // height), and the keyboard shrinks the screen instead of adding a scroll inset. So the shapes
    // give way first, and it scrolls only when the title, field and buttons alone don't fit.
    <KeyboardAvoidingView behavior="padding" style={[styles.fill, { backgroundColor: look.ground }]}>
      {/* Light status bar text on the light scheme's dark green, dark text on the dark scheme's light green. */}
      <StatusBar style={scheme === 'dark' ? 'dark' : 'light'} />
      <ScrollView
        ref={scrollRef}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        scrollEnabled={overflows}
        alwaysBounceVertical={false}
        onLayout={(e) => setFrameHeight(e.nativeEvent.layout.height)}
        onContentSizeChange={(_, height) => setContentHeight(height)}
        contentContainerStyle={[
          styles.grow,
          {
            paddingHorizontal: spacing.xl,
            paddingTop: insets.top + spacing.xxl,
            // The keyboard covers the home indicator, so the bottom inset only counts while it's down.
            paddingBottom: (keyboardVisible ? 0 : insets.bottom) + spacing.xl,
            gap: spacing.xxl,
          },
        ]}>
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

        <Shapes colors={look.shapes} />

        {account.status === 'unconfigured' ? null : (
          <View style={{ gap: spacing.md }}>
            {step === 'email' && isGoogleConfigured ? (
              <SurfaceButton label={busy ? 'Signing in…' : 'Continue with Google'} onPress={onGoogle} disabled={busy} />
            ) : null}

            {!__DEV__ ? null : step === 'email' ? (
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

            {!__DEV__ ? null : step === 'email' ? (
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
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * Board 09's 3 × 2 grid of rounded shapes, centred in the space the title and the field leave.
 * They shrink to fit, and go once they'd be too small to read as shapes. Decorative.
 */
function Shapes({ colors }: { colors: string[] }) {
  const { spacing, sizes, rounded } = useTheme();
  const [space, setSpace] = useState(0);
  const gap = spacing.sm + spacing.xxs;
  const height = signInShapeHeight(space, { max: sizes.signInShape, min: sizes.signInShape / 2, gap });
  const round = height / 2;
  const square = Math.min(rounded.card, round);
  // Corners per shape: top-left, top-right, bottom-right, bottom-left.
  const corners = [
    [square, square, square, square],
    [round, round, round, round],
    [square, square, round, square],
    [round, square, square, square],
    [square, square, square, square],
    [round, round, round, round],
  ];
  return (
    // The grid is on an absolute layer so it never adds to the content's height: the space between
    // the title and the field sizes the shapes, not the other way round.
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={styles.fill}
      onLayout={(e) => setSpace(e.nativeEvent.layout.height)}>
      {height > 0 ? (
        <View style={[StyleSheet.absoluteFill, styles.centre, { gap }]}>
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
                        height,
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
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flexGrow: 1 },
  centre: { justifyContent: 'center' },
  row: { flexDirection: 'row' },
  shape: { flex: 1, borderCurve: 'continuous' },
  center: { textAlign: 'center' },
});
