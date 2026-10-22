import * as AppleAuthentication from 'expo-apple-authentication';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { Body, Button, Screen, Stack, Title } from '@/components/ui';
import { radius } from '@/constants/theme';
import { SignInCancelled, signInWithApple, signInWithGoogle } from '@/lib/auth';
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

  const run = async (signIn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
      router.replace(routeForIntent(intent));
    } catch (e) {
      if (!(e instanceof SignInCancelled)) setError("Couldn't sign you in. Please try again.");
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
    </Screen>
  );
}
