import { Link, Redirect, router } from 'expo-router';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Body, Button, Screen, Stack, Title } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { signOut } from '@/lib/auth';
import { type PactSummary, useMyPacts } from '@/lib/queries';
import { useAuth } from '@/providers/auth-provider';

// Phase 4 home: the pacts you're in and the way back to a waiting room.
// The full daily dashboard replaces this in Phase 5.
export default function Home() {
  const { session } = useAuth();
  const pacts = useMyPacts(!!session);

  if (!session) return <Redirect href="/welcome" />;

  return (
    <Screen>
      {pacts.isPending && <ActivityIndicator color={colors.text} />}
      {pacts.data?.length === 0 && (
        <Stack>
          <Title>No pact yet</Title>
          <Body muted>Start one and invite someone, or join with their code.</Body>
          <Button label="Start a pact" onPress={() => router.push('/create')} />
          <Button label="I have a code" variant="secondary" onPress={() => router.push('/welcome')} />
        </Stack>
      )}
      {pacts.data?.map((p) => <PactCard key={p.id} pact={p} />)}
      <View style={{ flex: 1 }} />
      <Pressable accessibilityRole="button" onPress={() => signOut()}>
        <Body muted style={{ textAlign: 'center' }}>
          Sign out
        </Body>
      </Pressable>
    </Screen>
  );
}

function PactCard({ pact }: { pact: PactSummary }) {
  const names = pact.pact_members
    .filter((m) => !m.left_at)
    .map((m) => m.profiles?.display_name ?? '?')
    .join(' · ');

  if (pact.status === 'pending') {
    return (
      <Link href={`/invite/${pact.id}`} asChild>
        <Pressable style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg }}>
          <Body>{pact.title}</Body>
          <Body muted>Waiting for your partner. Tap to share the invite again.</Body>
        </Pressable>
      </Link>
    );
  }

  const live = pact.current_streak > 0;
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm }}>
      <Text
        style={{
          color: live ? colors.accent : colors.broken,
          fontSize: 96,
          fontWeight: '800',
          fontVariant: ['tabular-nums'],
        }}>
        {pact.current_streak}
      </Text>
      <Body style={{ color: live ? colors.accent : colors.broken, fontWeight: '700' }}>
        {live ? 'DAYS' : 'DAYS — Day 1 starts now'}
      </Body>
      <Body>{pact.title}</Body>
      <Body muted>{names}</Body>
    </View>
  );
}
