import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { TextInput } from 'react-native';

import { Body, Button, Screen, Stack, styles, Title } from '@/components/ui';
import { colors } from '@/constants/theme';
import { extractInviteCode, formatInviteCode, isInviteCode, normalizeInviteCode } from '@/lib/invite-code';
import { useAuth } from '@/providers/auth-provider';
import { useOnboarding } from '@/stores/onboarding';

export default function Welcome() {
  const { session } = useAuth();
  const setIntent = useOnboarding((s) => s.setIntent);
  const [code, setCode] = useState('');

  // The landing page copied the code; offer it before anything else.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!(await Clipboard.hasStringAsync())) return;
      const found = extractInviteCode(await Clipboard.getStringAsync());
      if (found && !cancelled) setCode((current) => current || formatInviteCode(found));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const join = () => {
    const c = normalizeInviteCode(code);
    setIntent({ kind: 'join', code: c });
    router.push(session ? `/join/${c}` : '/sign-in');
  };

  const start = () => {
    setIntent({ kind: 'create' });
    router.push(session ? '/create' : '/sign-in');
  };

  return (
    <Screen style={{ justifyContent: 'center' }}>
      <Stack gap={8}>
        <Title>Lockstep</Title>
        <Body muted>One daily challenge. One shared streak. Miss a day and it resets for both of you.</Body>
      </Stack>
      <Stack gap={12}>
        <Body>Got an invite code?</Body>
        <TextInput
          accessibilityLabel="Invite code"
          value={code}
          onChangeText={(t) => setCode(formatInviteCode(t).slice(0, 7))}
          placeholder="K7M-Q2X"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="characters"
          autoCorrect={false}
          style={[styles.input, { letterSpacing: 4, textAlign: 'center' }]}
        />
        <Button label="Join with code" onPress={join} disabled={!isInviteCode(code)} />
      </Stack>
      <Button label="Start a streak" variant="secondary" onPress={start} />
    </Screen>
  );
}
