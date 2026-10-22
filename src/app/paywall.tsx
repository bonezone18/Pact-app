import { router } from 'expo-router';

import { Body, Button, Screen, Stack, Title } from '@/components/ui';

// Shown on pro_required. Purchases (RevenueCat) arrive in Phase 7.
export default function Paywall() {
  return (
    <Screen style={{ justifyContent: 'center' }}>
      <Stack gap={8}>
        <Title>Lockstep Pro</Title>
        <Body muted>
          Free covers one streak at a time. Pro unlocks more streaks, pods of up to 4, full history and custom reminder
          times.
        </Body>
        <Body muted>$1.99/month or $15/year. Upgrades are coming soon.</Body>
      </Stack>
      <Button label="Not now" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
