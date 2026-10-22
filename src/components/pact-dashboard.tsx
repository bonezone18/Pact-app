import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { Link, router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useStore } from 'zustand';

import { Avatar, Body, Button, Screen, Stack } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { pendingCheckIn } from '@/lib/check-in-queue';
import { checkInQueue } from '@/lib/check-in-sync';
import { keys, usePactRealtime, usePactToday, useSignedUrls } from '@/lib/queries';
import { toRpcError } from '@/lib/rpc-errors';
import { supabase } from '@/lib/supabase';
import {
  countdownTarget,
  formatTimeLeft,
  isLocked,
  primaryAction,
  REACTIONS,
  reactionEmoji,
  type ReactionKind,
  type TodayMember,
  withOptimisticCheckIn,
} from '@/lib/today';

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function PactDashboard({ pactId }: { pactId: string }) {
  const queryClient = useQueryClient();
  const query = usePactToday(pactId);
  usePactRealtime(pactId);
  const now = useNow(30_000);

  const date = query.data?.date ?? '';
  const queued = useStore(checkInQueue.store, (s) => pendingCheckIn(s, pactId, date));
  // Select the stored array (stable) and filter outside: a selector returning a
  // fresh array would re-render forever.
  const notices = useStore(checkInQueue.store, (s) => s.notices).filter((n) => n.pactId === pactId);

  const today = query.data ? withOptimisticCheckIn(query.data, queued) : undefined;
  const locked = today ? isLocked(today) : false;

  const paths = (today?.members ?? []).flatMap((m) => (m.check_in?.image_path ? [m.check_in.image_path] : []));
  const signed = useSignedUrls(paths);

  const [reactingTo, setReactingTo] = useState<TodayMember | null>(null);
  const [viewing, setViewing] = useState<{ uri: string; member: TodayMember } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // A short flame when the last member completes while you're watching.
  const [flame] = useState(() => new Animated.Value(0));
  const wasLocked = useRef<boolean | null>(null);
  useEffect(() => {
    if (!today) return;
    if (wasLocked.current === false && locked) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      Animated.sequence([
        Animated.timing(flame, { toValue: 1, duration: 250, useNativeDriver: true }),
        Animated.timing(flame, { toValue: 0, duration: 900, delay: 600, useNativeDriver: true }),
      ]).start();
    }
    wasLocked.current = locked;
  }, [today, locked, flame]);

  if (query.isPending) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <ActivityIndicator color={colors.text} />
      </Screen>
    );
  }
  if (!today) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <Body muted>Couldn&apos;t load today. Pull up the app again when you&apos;re online.</Body>
        <Button label="Retry" variant="secondary" onPress={() => query.refetch()} />
      </Screen>
    );
  }

  const streak = today.pact.current_streak;
  const live = streak > 0;
  const action = primaryAction(today);
  const countdown = countdownTarget(today);

  const nudge = (member: TodayMember) => {
    if (today.nudges_left <= 0) {
      setMessage("You've used both nudges for today.");
      return;
    }
    Alert.alert(`Nudge ${member.display_name}?`, `${today.nudges_left} left today.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Nudge',
        onPress: async () => {
          const { error } = await supabase.rpc('nudge', { pact_id: pactId, user_id: member.user_id });
          const copy: Record<string, string> = {
            rate_limited: "You've used both nudges for today.",
            already_checked_in: `${member.display_name} just checked in.`,
          };
          setMessage(error ? (copy[error.message] ?? toRpcError(error).message) : `Nudged ${member.display_name}.`);
          queryClient.invalidateQueries({ queryKey: keys.today(pactId) });
        },
      },
    ]);
  };

  const react = async (kind: ReactionKind) => {
    const target = reactingTo;
    setReactingTo(null);
    if (!target?.check_in) return;
    const { error } = await supabase.rpc('react', { check_in_id: target.check_in.id, kind });
    if (error) setMessage("Couldn't send the reaction.");
    queryClient.invalidateQueries({ queryKey: keys.today(pactId) });
  };

  const onMemberPress = (m: TodayMember) => {
    if (m.is_me) return;
    if (m.state === 'pending' && m.required) nudge(m);
    else if (m.state === 'done' && m.check_in) setReactingTo(m);
  };

  return (
    <Screen>
      {/* Hero */}
      <View accessibilityLabel={`${streak} day streak`}>
        <Animated.Text
          style={[styles.flame, { opacity: flame, transform: [{ scale: Animated.add(0.6, Animated.multiply(flame, 0.6)) }] }]}>
          🔥
        </Animated.Text>
        <Text testID="streak" style={[styles.hero, { color: live ? colors.accent : colors.broken }]}>
          {streak}
        </Text>
        <Text style={[styles.heroLabel, { color: live ? colors.accent : colors.broken }]}>
          {live ? 'DAYS' : 'DAYS — Day 1 starts now'}
        </Text>
        <Body muted>{today.pact.title}</Body>
      </View>

      {notices.map((n) => (
        <Pressable
          key={n.id}
          accessibilityRole="button"
          accessibilityHint="Dismiss"
          onPress={() => checkInQueue.dismissNotice(n.id)}
          style={styles.notice}>
          <Body>{n.message}</Body>
        </Pressable>
      ))}
      {message && (
        <Pressable onPress={() => setMessage(null)} style={styles.notice}>
          <Body>{message}</Body>
        </Pressable>
      )}

      {/* Members */}
      <Stack gap={space.sm}>
        {today.members.map((m) => (
          <MemberRow
            key={m.user_id}
            member={m}
            imageUri={m.localImageUri ?? (m.check_in?.image_path ? signed.data?.[m.check_in.image_path] : undefined)}
            onPress={() => onMemberPress(m)}
            onOpenProof={(uri) => setViewing({ uri, member: m })}
          />
        ))}
      </Stack>

      <View style={{ flex: 1 }} />

      {countdown && (
        <Body testID="countdown" muted style={{ textAlign: 'center' }}>
          {countdown.who.is_me ? '' : `${countdown.who.display_name}: `}
          {formatTimeLeft(countdown.endsAt - now)}
        </Body>
      )}
      <Button
        label={action.label}
        disabled={action.kind !== 'check_in'}
        onPress={() => router.push(`/check-in/${pactId}`)}
      />
      <Link href={`/pact/${pactId}`} asChild>
        <Pressable accessibilityRole="button">
          <Body muted style={{ textAlign: 'center' }}>
            History · longest {today.pact.longest_streak}
          </Body>
        </Pressable>
      </Link>

      <ReactionPicker member={reactingTo} myId={today.me} onPick={react} onClose={() => setReactingTo(null)} />
      <Modal visible={!!viewing} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <Pressable style={styles.viewer} onPress={() => setViewing(null)} accessibilityLabel="Close proof">
          {viewing && (
            <>
              <Image source={{ uri: viewing.uri }} style={{ width: '100%', aspectRatio: 3 / 4 }} contentFit="contain" />
              <Body style={{ textAlign: 'center' }}>{viewing.member.display_name}</Body>
              {viewing.member.check_in?.note && <Body muted style={{ textAlign: 'center' }}>{viewing.member.check_in.note}</Body>}
            </>
          )}
        </Pressable>
      </Modal>
    </Screen>
  );
}

function MemberRow({
  member: m,
  imageUri,
  onPress,
  onOpenProof,
}: {
  member: TodayMember;
  imageUri?: string;
  onPress: () => void;
  onOpenProof: (uri: string) => void;
}) {
  const badge =
    m.state === 'done'
      ? { text: m.syncing ? 'DONE · syncing' : 'DONE', color: colors.done }
      : m.state === 'pending'
        ? { text: 'PENDING', color: colors.accent }
        : m.state === 'missed'
          ? { text: 'MISSED', color: colors.broken }
          : { text: 'STARTS TOMORROW', color: colors.broken };
  const reactions = m.check_in?.reactions ?? [];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${m.is_me ? 'You' : m.display_name}, ${badge.text}`}
      onPress={onPress}
      style={styles.row}>
      <Avatar name={m.display_name} size={44} />
      <View style={{ flex: 1 }}>
        <Body>{m.is_me ? `${m.display_name} (you)` : m.display_name}</Body>
        {reactions.length > 0 && <Body muted>{reactions.map((r) => reactionEmoji(r.kind)).join(' ')}</Body>}
      </View>
      {imageUri && (
        <Pressable accessibilityRole="imagebutton" accessibilityLabel="Open proof" onPress={() => onOpenProof(imageUri)}>
          <Image source={{ uri: imageUri }} style={styles.thumb} contentFit="cover" />
        </Pressable>
      )}
      <Text style={[styles.badge, { color: badge.color, borderColor: badge.color }]}>{badge.text}</Text>
    </Pressable>
  );
}

function ReactionPicker({
  member,
  myId,
  onPick,
  onClose,
}: {
  member: TodayMember | null;
  myId: string;
  onPick: (kind: ReactionKind) => void;
  onClose: () => void;
}) {
  const mine = member?.check_in?.reactions.find((r) => r.user_id === myId)?.kind;
  return (
    <Modal visible={!!member} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityLabel="Close reactions" />
      <View style={styles.sheet}>
        <Body muted>React to {member?.display_name}&apos;s check-in</Body>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          {REACTIONS.map((r) => (
            <Pressable
              key={r.kind}
              accessibilityRole="button"
              accessibilityLabel={`React ${r.kind}`}
              accessibilityState={{ selected: mine === r.kind }}
              onPress={() => onPick(r.kind)}
              style={[styles.reaction, mine === r.kind && { borderColor: colors.accent }]}>
              <Text style={{ fontSize: 32 }}>{r.emoji}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flame: { position: 'absolute', right: 0, top: 8, fontSize: 64 },
  hero: { fontSize: 96, fontWeight: '800', fontVariant: ['tabular-nums'], lineHeight: 104 },
  heroLabel: { fontSize: 17, fontWeight: '700', letterSpacing: 1 },
  notice: { backgroundColor: colors.surfaceRaised, borderRadius: radius.md, padding: space.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.md,
  },
  thumb: { width: 44, height: 44, borderRadius: 8 },
  badge: {
    fontSize: 12,
    fontWeight: '700',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', gap: space.md, padding: space.md },
  sheetBackdrop: { flex: 1 },
  sheet: { backgroundColor: colors.surface, padding: space.lg, gap: space.md, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  reaction: { padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent' },
});
