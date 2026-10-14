import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { signInColors } from '@/components/appearance';
import { Button, SurfaceButton } from '@/components/button';
import { TextField } from '@/components/text-field';
import { Toast } from '@/components/toast';
import { ThemedText } from '@/components/themed-text';
import {
  devPasswordSignIn,
  isDevPasswordEmail,
  sendEmailCode,
  signInWithGoogle,
  useAccountState,
  verifyEmailCode,
} from '@/features/auth/account';
import { ACCOUNT_DELETED_TOAST, takeAccountDeletedNotice } from '@/features/auth/delete-account';
import { signInHeroSize, signInOverflows } from '@/features/auth/sign-in-layout';
import { useKeyboardVisible } from '@/hooks/use-keyboard-visible';
import { isGoogleConfigured } from '@/lib/google-sign-in';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * Sign-in (board 09): the app's name at the top, Google sign-in at the bottom, and the gold cloche
 * in a warm glow in the space between, on the header green the launch screen also uses (spec 4.8). Dev builds also get
 * the email + 6-digit code stub; local Supabase delivers the code to Inbucket
 * (http://127.0.0.1:55324).
 */
export default function SignInScreen() {
  const t = useT();
  const account = useAccountState();
  const { colors, spacing } = useTheme();
  const look = signInColors(colors);
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Arriving here from Delete account (spec 4.8): say it worked, once.
  const [deletedNotice, setDeletedNotice] = useState(takeAccountDeletedNotice);
  const dismissNotice = useCallback(() => setDeletedNotice(false), []);

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
    // height), and the keyboard shrinks the screen instead of adding a scroll inset. So the cloche
    // give way first, and it scrolls only when the title, field and buttons alone don't fit.
    <KeyboardAvoidingView behavior="padding" style={[styles.fill, { backgroundColor: look.ground }]}>
      {/* The header green is dark in both schemes. */}
      <StatusBar style="light" />
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
          <ThemedText variant="hero" accessibilityRole="header" accessibilityLabel={t('signIn.appName')} style={{ color: look.text }}>
            {t('signIn.appNameStart')}
            <ThemedText variant="hero" style={{ color: look.accent }}>
              {t('signIn.appNameAccent')}
            </ThemedText>
            {t('signIn.appNameEnd')}
          </ThemedText>
          <ThemedText variant="lead" style={{ color: look.text }}>
            {account.status === 'unconfigured'
              ? t('signIn.unconfigured')
              : step === 'email'
                ? t('signIn.tagline')
                : t('signIn.codeSent', { email: email.trim() })}
          </ThemedText>
        </View>

        <Hero />

        {account.status === 'unconfigured' ? null : (
          <View style={{ gap: spacing.md }}>
            {step === 'email' && isGoogleConfigured ? (
              <SurfaceButton label={busy ? t('signIn.signingIn') : t('signIn.continueWithGoogle')} onPress={onGoogle} disabled={busy} />
            ) : null}

            {!__DEV__ ? null : step === 'email' ? (
              <TextField
                value={email}
                onChangeText={setEmail}
                placeholder={t('signIn.email')}
                accessibilityLabel={t('signIn.email')}
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
                placeholder={t('signIn.codePlaceholder')}
                accessibilityLabel={t('signIn.code')}
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
                label={busy ? t('signIn.sending') : t('signIn.sendCode')}
                icon="envelope"
                onPress={onSendCode}
                disabled={busy || !email.includes('@')}
              />
            ) : (
              <>
                <SurfaceButton label={busy ? t('signIn.signingIn') : t('signIn.signIn')} onPress={onVerify} disabled={busy || code.trim().length < 6} />
                <Button
                  label={t('signIn.differentEmail')}
                  variant="plain"
                  color="onHeader"
                  onPress={() => setStep('email')}
                  disabled={busy}
                />
              </>
            )}
            <ThemedText variant="footnote" style={[styles.center, { color: look.text }]}>
              {t('signIn.newHere')}
            </ThemedText>
          </View>
        )}
      </ScrollView>
      {deletedNotice ? (
        <View style={[styles.notice, { top: insets.top + spacing.sm }]}>
          <Toast message={ACCOUNT_DELETED_TOAST} actions={[]} onDismiss={dismissNotice} />
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

/**
 * The gold cloche, centred in the space the title and the field leave. It shrinks to fit, and goes
 * once it'd be under half size. Its image carries a soft warm glow and shadow that spread
 * `HERO_GLOW` times past the cloche, faintly over the text around it. Decorative.
 */
function Hero() {
  const { sizes } = useTheme();
  const [space, setSpace] = useState(0);
  const size = signInHeroSize(space, { max: sizes.signInHero, min: sizes.signInHero / 2 });
  return (
    // The cloche is on an absolute layer so it never adds to the content's height: the space between
    // the title and the field sizes it, not the other way round.
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={styles.fill}
      pointerEvents="none"
      onLayout={(e) => setSpace(e.nativeEvent.layout.height)}>
      {size > 0 ? (
        <View style={[StyleSheet.absoluteFill, styles.centre]}>
          <Image
            source={CLOCHE}
            style={{ width: size * HERO_GLOW, height: size * HERO_GLOW }}
            contentFit="contain"
            accessible={false}
          />
        </View>
      ) : null}
    </View>
  );
}

const CLOCHE = require('../../assets/images/sign-in-cloche.png');
/** sign-in-cloche.png is the 1024 pt cloche artwork drawn at 810 px on a 1296 px canvas. */
const HERO_GLOW = 1296 / 810;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flexGrow: 1 },
  centre: { alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
  notice: { position: 'absolute', left: 0, right: 0 },
});
