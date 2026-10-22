import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useStore } from 'zustand';

import { Body, Button, Screen, styles as ui, Title } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { pendingCheckIn } from '@/lib/check-in-queue';
import { checkInQueue, persistProof } from '@/lib/check-in-sync';
import { prepareProof } from '@/lib/proof-image';
import { usePactToday } from '@/lib/queries';
import { me } from '@/lib/today';

// Opened from a deep link there is nothing to go back to.
function leave() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export default function CheckIn() {
  const { pactId } = useLocalSearchParams<{ pactId: string }>();
  const today = usePactToday(pactId);
  const queued = useStore(checkInQueue.store, (s) => pendingCheckIn(s, pactId, today.data?.date ?? ''));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const t = today.data;
  if (!t) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <ActivityIndicator color={colors.text} />
      </Screen>
    );
  }

  const alreadyDone = me(t)?.state === 'done' || !!queued;
  if (alreadyDone) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <Title>You&apos;re checked in for today</Title>
        <Button label="Back" variant="secondary" onPress={leave} />
      </Screen>
    );
  }

  const submit = async (photoUri: string | null, capturedAt: string) => {
    setBusy(true);
    const id = Crypto.randomUUID();
    checkInQueue.enqueue({
      id,
      pactId,
      userId: t.me,
      forDate: t.date,
      fileUri: photoUri ? persistProof(photoUri, id) : null,
      note: note.trim() || null,
      capturedAt,
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    leave();
  };

  const noteInput = (
    <TextInput
      accessibilityLabel="Note"
      value={note}
      onChangeText={setNote}
      maxLength={80}
      placeholder="Add a note (optional)"
      placeholderTextColor={colors.textSecondary}
      style={[ui.input, { fontSize: 17 }]}
    />
  );

  return t.pact.proof_mode === 'photo' ? (
    <PhotoCheckIn title={t.pact.title} noteInput={noteInput} busy={busy} onSubmit={submit} />
  ) : (
    <Screen>
      <CloseButton />
      <Title>{t.pact.title}</Title>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done"
          disabled={busy}
          onPress={() => submit(null, new Date().toISOString())}
          style={({ pressed }) => [styles.bigDone, pressed && { opacity: 0.8 }]}>
          <Text style={styles.bigDoneLabel}>Done</Text>
        </Pressable>
      </View>
      {noteInput}
    </Screen>
  );
}

function PhotoCheckIn({
  title,
  noteInput,
  busy,
  onSubmit,
}: {
  title: string;
  noteInput: ReactNode;
  busy: boolean;
  onSubmit: (uri: string, capturedAt: string) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [shot, setShot] = useState<{ uri: string; capturedAt: string } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const now = useClock();

  if (!permission) return <Screen />;
  if (!permission.granted) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <CloseButton />
        <Title>Camera access</Title>
        <Body muted>Lockstep proofs are taken in the app, at the moment you do the thing. Gallery photos aren&apos;t used.</Body>
        <Button label="Allow camera" onPress={requestPermission} />
      </Screen>
    );
  }

  const capture = async () => {
    if (!camera.current) return;
    setCapturing(true);
    try {
      const capturedAt = new Date().toISOString();
      const photo = await camera.current.takePictureAsync({ quality: 0.9 });
      setShot({ uri: await prepareProof(photo.uri), capturedAt });
    } finally {
      setCapturing(false);
    }
  };

  if (shot) {
    return (
      <Screen>
        <Image source={{ uri: shot.uri }} style={styles.preview} contentFit="cover" />
        {noteInput}
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button label="Retake" variant="secondary" style={{ flex: 1 }} onPress={() => setShot(null)} />
          <Button label="Check in" style={{ flex: 2 }} loading={busy} onPress={() => onSubmit(shot.uri, shot.capturedAt)} />
        </View>
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: 'black' }}>
      <CameraView ref={camera} style={StyleSheet.absoluteFill} facing={facing} />
      <Screen style={{ backgroundColor: 'transparent' }}>
        <CloseButton />
        {/* Live date and time over the viewfinder. */}
        <View style={styles.overlay}>
          <Text style={styles.overlayTitle}>{title}</Text>
          <Text testID="viewfinder-clock" style={styles.overlayClock}>
            {now.toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        <View style={styles.controls}>
          <Pressable accessibilityRole="button" accessibilityLabel="Flip camera" onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}>
            <Text style={{ fontSize: 28 }}>🔄</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            disabled={capturing}
            onPress={capture}
            style={styles.shutter}>
            {capturing && <ActivityIndicator color={colors.background} />}
          </Pressable>
          <View style={{ width: 28 }} />
        </View>
      </Screen>
    </View>
  );
}

function CloseButton() {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={leave} hitSlop={12}>
      <Text style={{ color: colors.text, fontSize: 28 }}>✕</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bigDone: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigDoneLabel: { color: colors.text, fontSize: 40, fontWeight: '800' },
  overlay: { backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: radius.md, padding: space.md, alignSelf: 'flex-start' },
  overlayTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  overlayClock: { color: colors.text, fontSize: 15, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.text,
    borderWidth: 4,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  preview: { width: '100%', flex: 1, borderRadius: radius.lg },
});
