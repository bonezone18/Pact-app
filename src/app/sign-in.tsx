import * as AppleAuthentication from 'expo-apple-authentication';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, TextInput } from 'react-native';

import { Body, Button, Screen, Stack, styles, Title } from '@/components/ui';
import { colors, radius } from '@/constants/theme';
import { SignInCancelled, signInWithApple, signInWithGoogle } from '@/lib/auth';
import { devSignIn, devSignInEnabled } from '@/lib/dev-auth';
import { useAuth } from '@/providers/auth-provider';
import { routeForIntent, useOnboarding } from '@/stores/onboarding';

export default function SignIn() {
  const { session } = useAuth();
  const intent = useOnboarding((s) => s.intent);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS === 'ios') AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  if (session) return <Redirect href={routeForIntent(intent)} />;

  const run = async (signIn: () => Promise<void>, describe = false) => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
      router.replace(routeForIntent(intent));
    } catch (e) {
      if (!(e instanceof SignInCancelled)) {
        setError(describe && e instanceof Error ? e.message : "Couldn't sign you in. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen style={{ justifyContent: 'flex-end' }}>
      <Stack gap={8}>
        <Title>Sign in</Title>
        <Body muted>Your name and photo come from your account. Nothing else to fill in.</Body>
      </Stack>
      <Stack gap={12}>
        {appleAvailable && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={radius.md}
            style={{ height: 54 }}
            onPress={() => run(signInWithApple)}
          />
        )}
        <Button label="Continue with Google" variant="secondary" loading={busy} onPress={() => run(signInWithGoogle)} />
        {error && <Body muted>{error}</Body>}
      </Stack>
      {devSignInEnabled() && <DevSignIn busy={busy} onSubmit={(email, pw) => run(() => devSignIn(email, pw), true)} />}
    </Screen>
  );
}

function DevSignIn({ busy, onSubmit }: { busy: boolean; onSubmit: (email: string, password: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <Stack gap={8}>
      <Body muted>Developer sign-in (local testing only)</Body>
      <TextInput
        accessibilityLabel="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        placeholder="alice@test.dev"
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, { fontSize: 17 }]}
      />
      <TextInput
        accessibilityLabel="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholder="At least 6 characters"
        placeholderTextColor={colors.textSecondary}
        style={[styles.input, { fontSize: 17 }]}
      />
      <Button
        label="Sign in with email"
        variant="secondary"
        loading={busy}
        disabled={!email.includes('@') || password.length < 6}
        onPress={() => onSubmit(email.trim(), password)}
      />
    </Stack>
  );
}
