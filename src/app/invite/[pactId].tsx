import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Share, Text } from 'react-native';

import { Body, Button, Screen, Stack, Title } from '@/components/ui';
import { colors } from '@/constants/theme';
import { formatInviteCode, inviteShareMessage } from '@/lib/invite-code';
import { keys, useWaitingRoom } from '@/lib/queries';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

export default function WaitingRoom() {
  const { pactId } = useLocalSearchParams<{ pactId: string }>();
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const room = useWaitingRoom(pactId);
  const [regenerating, setRegenerating] = useState(false);

  // Switch to the dashboard the moment a partner joins.
  useEffect(() => {
    const channel = supabase
      .channel(`waiting-room:${pactId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'pacts', filter: `id=eq.${pactId}` },
        (payload) => {
          if ((payload.new as { status?: string }).status === 'active') {
            queryClient.invalidateQueries({ queryKey: keys.pacts });
            router.replace('/');
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [pactId, queryClient]);

  if (!session) return <Redirect href="/welcome" />;
  // Covers a join that happened while the socket was down (refetch on foreground).
  if (room.data?.pact.status === 'active') return <Redirect href="/" />;

  const invite = room.data?.invite;
  const expired = invite ? new Date(invite.expires_at) <= new Date() : false;

  const share = () => {
    if (invite && room.data) {
      Share.share({ message: inviteShareMessage(invite.code, room.data.pact.title) }).catch(() => undefined);
    }
  };

  const regenerate = async () => {
    setRegenerating(true);
    await supabase.rpc('regenerate_invite', { pact_id: pactId });
    await room.refetch();
    setRegenerating(false);
  };

  return (
    <Screen style={{ justifyContent: 'center' }}>
      <Stack gap={8}>
        <Title>Waiting for your partner</Title>
        {room.data && <Body muted>{room.data.pact.title}</Body>}
      </Stack>
      {invite && !expired ? (
        <Text
          testID="invite-code"
          accessibilityLabel={`Invite code ${invite.code.split('').join(' ')}`}
          style={{ color: colors.text, fontSize: 48, fontWeight: '700', letterSpacing: 6, textAlign: 'center' }}>
          {formatInviteCode(invite.code)}
        </Text>
      ) : (
        room.data && <Body muted>This invite has expired. Make a new code to keep inviting.</Body>
      )}
      <Stack gap={12}>
        {invite && !expired && <Button label="Share invite" onPress={share} />}
        <Button label="New code" variant="secondary" onPress={regenerate} loading={regenerating} />
      </Stack>
    </Screen>
  );
}
