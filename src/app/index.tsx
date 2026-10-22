import { Link, Redirect, router } from 'expo-router';
import { ActivityIndicator, Pressable } from 'react-native';

import { PactDashboard } from '@/components/pact-dashboard';
import { Body, Button, Screen, Stack, Title } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { signOut } from '@/lib/auth';
import { useMyPacts } from '@/lib/queries';
import { useAuth } from '@/providers/auth-provider';

// Today. The pact switcher for Pro users with several pacts is Phase 7;
// until then the dashboard shows the most recent active pact.
export default function Home() {
  const { session } = useAuth();
  const pacts = useMyPacts(!!session);

  if (!session) return <Redirect href="/welcome" />;

  const active = pacts.data?.find((p) => p.status === 'active');
  if (active) return <PactDashboard pactId={active.id} />;

  const pending = pacts.data?.filter((p) => p.status === 'pending') ?? [];
  return (
    <Screen>
      {pacts.isPending && <ActivityIndicator color={colors.text} />}
      {pending.map((p) => (
        <Link key={p.id} href={`/invite/${p.id}`} asChild>
          <Pressable style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg }}>
            <Body>{p.title}</Body>
            <Body muted>Waiting for your partner. Tap to share the invite again.</Body>
          </Pressable>
        </Link>
      ))}
      {pacts.data?.length === 0 && (
        <Stack>
          <Title>No pact yet</Title>
          <Body muted>Start one and invite someone, or join with their code.</Body>
          <Button label="Start a pact" onPress={() => router.push('/create')} />
          <Button label="I have a code" variant="secondary" onPress={() => router.push('/welcome')} />
        </Stack>
      )}
      <Pressable accessibilityRole="button" onPress={() => signOut()} style={{ marginTop: 'auto' }}>
        <Body muted style={{ textAlign: 'center' }}>
          Sign out
        </Body>
      </Pressable>
    </Screen>
  );
}
