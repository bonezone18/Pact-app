import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Body, Screen, Title } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { buildMonth, monthLabel, shiftMonth } from '@/lib/calendar';
import { usePactHistory, useSignedUrls } from '@/lib/queries';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export default function History() {
  const { pactId } = useLocalSearchParams<{ pactId: string }>();
  const history = usePactHistory(pactId);
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });

  const photos = history.data?.checkIns.filter((c) => c.image_path) ?? [];
  const signed = useSignedUrls(photos.map((c) => c.image_path!));

  if (!history.data) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <ActivityIndicator color={colors.text} />
      </Screen>
    );
  }

  const { pact, events } = history.data;
  const weeks = buildMonth(cursor.year, cursor.month, events);

  return (
    <Screen>
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={12}>
        <Text style={{ color: colors.text, fontSize: 28 }}>‹</Text>
      </Pressable>
      <View>
        <Title>{pact.title}</Title>
        <Body muted>
          Current {pact.current_streak} · Longest {pact.longest_streak}
        </Body>
      </View>

      <View style={styles.monthHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => setCursor((c) => shiftMonth(c.year, c.month, -1))}>
          <Text style={styles.arrow}>‹</Text>
        </Pressable>
        <Body>{monthLabel(cursor.year, cursor.month)}</Body>
        <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => setCursor((c) => shiftMonth(c.year, c.month, 1))}>
          <Text style={styles.arrow}>›</Text>
        </Pressable>
      </View>
      <View>
        <View style={styles.week}>
          {WEEKDAYS.map((w, i) => (
            <Text key={i} style={[styles.cell, styles.weekday]}>
              {w}
            </Text>
          ))}
        </View>
        {weeks.map((week, i) => (
          <View key={i} style={styles.week}>
            {week.map((cell, j) => (
              <View
                key={j}
                accessibilityLabel={cell ? `${cell.date}${cell.outcome ? `, ${cell.outcome}` : ''}` : undefined}
                style={[
                  styles.cell,
                  cell?.outcome === 'extended' && { backgroundColor: colors.done },
                  cell?.outcome === 'missed' && { backgroundColor: colors.surfaceRaised },
                ]}>
                <Text style={{ color: cell?.outcome === 'missed' ? colors.textSecondary : colors.text }}>{cell?.day ?? ''}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>

      <FlatList
        data={photos}
        keyExtractor={(c) => c.id}
        numColumns={3}
        columnWrapperStyle={{ gap: space.xs }}
        contentContainerStyle={{ gap: space.xs }}
        ListEmptyComponent={<Body muted>Proof photos will show up here.</Body>}
        renderItem={({ item }) => (
          <View style={styles.photo} accessibilityLabel={`${item.profiles?.display_name ?? ''}, ${item.local_date}`}>
            {signed.data?.[item.image_path!] && (
              <Image source={{ uri: signed.data[item.image_path!] }} style={StyleSheet.absoluteFill} contentFit="cover" />
            )}
            <Text style={styles.photoLabel}>{item.local_date.slice(5)}</Text>
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  monthHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  arrow: { color: colors.text, fontSize: 28, paddingHorizontal: space.sm },
  week: { flexDirection: 'row', justifyContent: 'space-between' },
  cell: {
    width: 40,
    height: 40,
    margin: 2,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
  },
  weekday: { color: colors.textSecondary, lineHeight: 40 },
  photo: { flex: 1 / 3, aspectRatio: 1, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surface },
  photoLabel: { position: 'absolute', bottom: 4, left: 6, color: colors.text, fontSize: 12, fontWeight: '700' },
});
