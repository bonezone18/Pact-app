import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { Avatar, Body, Button, Screen, Stack, Title } from '@/components/ui';
import { colors } from '@/constants/theme';
import { formatInviteCode, normalizeInviteCode } from '@/lib/invite-code';
import { registerForPush } from '@/lib/push';
import { keys, useInvitePreview } from '@/lib/queries';
import { toRpcError } from '@/lib/rpc-errors';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { useOnboarding } from '@/stores/onboarding';

const UNAVAILABLE: Record<string, string> = {
  invalid: "This invite doesn't exist or was replaced. Ask for a fresh link.",
  expired: 'This invite expired. Ask your partner to send a new one.',
  full: 'This streak is already full.',
};

export default function JoinPact() {
  const { code: raw } = useLocalSearchParams<{ code: string }>();
  const code = normalizeInviteCode(raw ?? '');
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const setIntent = useOnboarding((s) => s.setIntent);
  const preview = useInvitePreview(code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    if (!session) {
      setIntent({ kind: 'join', code });
      router.push('/sign-in');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('join_pact', { code });
    setBusy(false);
    if (rpcError) {
      const e = toRpcError(rpcError);
      if (e.code === 'pro_required') return router.push('/paywall');
      if (e.code !== 'already_member') return setError(e.message);
    }
    setIntent(null);
    queryClient.invalidateQueries({ queryKey: keys.pacts });
    router.replace('/');
    registerForPush({ prompt: true }).catch(() => undefined);
  };

  const p = preview.data;
  return (
    <Screen style={{ justifyContent: 'center' }}>
      {preview.isPending && <ActivityIndicator color={colors.text} />}
      {preview.isError && <Body muted>Couldn&apos;t load this invite. Check your connection.</Body>}
      {p && p.status !== 'valid' && (
        <Stack>
          <Title>Invite {formatInviteCode(code)}</Title>
          <Body muted>{UNAVAILABLE[p.status]}</Body>
          <Button label="Back" variant="secondary" onPress={() => router.replace('/welcome')} />
        </Stack>
      )}
      {p && p.status === 'valid' && (
        <Stack gap={24}>
          <Avatar name={p.inviter_name ?? '?'} size={72} />
          <Stack gap={8}>
            <Body muted>Join {p.inviter_name ?? 'your partner'}&apos;s streak</Body>
            <Title>{p.title}</Title>
            <Body muted>
              {p.proof_mode === 'photo' ? 'Prove it daily with a photo.' : 'Prove it daily with a tap.'} Miss a day
              and the streak resets for everyone.
            </Body>
          </Stack>
          {error && <Body muted>{error}</Body>}
          <Button label={session ? 'Join streak' : 'Sign in to join'} onPress={join} loading={busy} />
        </Stack>
      )}
    </Screen>
  );
}
