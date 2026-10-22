import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  type TextProps,
  View,
  type ViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, space } from '@/constants/theme';

export function Screen({ children, style, ...rest }: ViewProps) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={[styles.screen, style]} {...rest}>
        {children}
      </View>
    </SafeAreaView>
  );
}

export function Title({ style, ...rest }: TextProps) {
  return <Text accessibilityRole="header" style={[styles.title, style]} {...rest} />;
}

export function Body({ style, muted, ...rest }: TextProps & { muted?: boolean }) {
  return <Text style={[styles.body, muted && styles.muted, style]} {...rest} />;
}

type ButtonProps = Omit<PressableProps, 'children'> & {
  label: string;
  variant?: 'primary' | 'secondary';
  loading?: boolean;
};

export function Button({ label, variant = 'primary', loading, disabled, style, ...rest }: ButtonProps) {
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      disabled={off}
      style={(state) => [
        styles.button,
        variant === 'primary' ? styles.primary : styles.secondary,
        off && styles.disabled,
        state.pressed && styles.pressed,
        typeof style === 'function' ? style(state) : style,
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <Text style={styles.buttonLabel}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={styles.chipLabel}>{label}</Text>
    </Pressable>
  );
}

export function Avatar({ name, size = 56 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{initials || '?'}</Text>
    </View>
  );
}

export function Stack({ children, gap = space.md }: { children: ReactNode; gap?: number }) {
  return <View style={{ gap }}>{children}</View>;
}

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  screen: { flex: 1, padding: space.lg, gap: space.lg },
  title: { color: colors.text, fontSize: 28, fontWeight: '700' },
  body: { color: colors.text, fontSize: 17, lineHeight: 24 },
  muted: { color: colors.textSecondary },
  button: {
    minHeight: 54,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.surfaceRaised },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
  buttonLabel: { color: colors.text, fontSize: 17, fontWeight: '600' },
  chip: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.surfaceRaised,
  },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  chipLabel: { color: colors.text, fontSize: 15 },
  avatar: { backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontWeight: '700' },
  input: {
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: 54,
    fontSize: 20,
  },
});
