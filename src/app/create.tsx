import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Share, TextInput, View } from 'react-native';

import { Body, Button, Chip, Screen, Stack, styles, Title } from '@/components/ui';
import { colors } from '@/constants/theme';
import { inviteShareMessage } from '@/lib/invite-code';
import { keys, type ProofMode, useIsPro } from '@/lib/queries';
import { toRpcError } from '@/lib/rpc-errors';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';
import { useOnboarding } from '@/stores/onboarding';

const TEMPLATES = ['Walk 1 mile', 'Read 10 pages', 'Gym', 'Meditate 10 min', 'No sugar'];

export default function CreatePact() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const setIntent = useOnboarding((s) => s.setIntent);
  const { data: isPro } = useIsPro(!!session);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<ProofMode>('photo');
  const [size, setSize] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!session) return <Redirect href="/welcome" />;

  const create = async () => {
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('create_pact', {
      title: title.trim(),
      proof_mode: mode,
      max_members: size,
    });
    setBusy(false);
    if (rpcError) {
      const e = toRpcError(rpcError);
      if (e.code === 'pro_required') router.push('/paywall');
      else setError(e.message);
      return;
    }
    const { pact_id, code } = data as { pact_id: string; code: string };
    setIntent(null);
    queryClient.invalidateQueries({ queryKey: keys.pacts });
    // Straight to the waiting room with the share sheet on top: no screen in between.
    router.replace(`/invite/${pact_id}`);
    await Share.share({ message: inviteShareMessage(code, title.trim()) }).catch(() => undefined);
  };

  return (
    <Screen>
      <Title>Start a pact</Title>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {TEMPLATES.map((t) => (
          <Chip key={t} label={t} selected={title === t} onPress={() => setTitle(t)} />
        ))}
      </View>
      <TextInput
        accessibilityLabel="Pact title"
        value={title}
        onChangeText={setTitle}
        maxLength={40}
        placeholder="Or type your own"
        placeholderTextColor={colors.textSecondary}
        style={styles.input}
      />
      <Stack gap={8}>
        <Body muted>Proof</Body>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Chip label="Photo" selected={mode === 'photo'} onPress={() => setMode('photo')} />
          <Chip label="Tap" selected={mode === 'tap'} onPress={() => setMode('tap')} />
        </View>
      </Stack>
      {isPro && (
        <Stack gap={8}>
          <Body muted>Members</Body>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[2, 3, 4].map((n) => (
              <Chip key={n} label={String(n)} selected={size === n} onPress={() => setSize(n)} />
            ))}
          </View>
        </Stack>
      )}
      <View style={{ flex: 1 }} />
      {error && <Body muted>{error}</Body>}
      <Button label="Create and invite" onPress={create} loading={busy} disabled={!title.trim()} />
    </Screen>
  );
}
