import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';

interface Props {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}

/**
 * Shared empty/error state used across every list screen so loading-empty
 * and loading-error visuals stay consistent app-wide.
 */
export function EmptyState({ icon: Icon, title, subtitle, actionLabel, onAction, compact = false }: Props) {
  return (
    <View style={[styles.wrap, compact && styles.compact]}>
      <View style={styles.iconWrap}>
        <Icon size={compact ? 20 : 28} color={colors.mutedForeground} />
      </View>
      <Text style={[styles.title, compact && styles.compactTitle]}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {actionLabel && onAction ? (
        <TouchableOpacity style={styles.button} onPress={onAction}>
          <Text style={styles.buttonText}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingTop: spacing.xxl, paddingHorizontal: spacing.xl, gap: spacing.sm },
  compact: { paddingTop: spacing.xl },
  iconWrap: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.muted + '55', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs,
  },
  title: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.foreground, textAlign: 'center' },
  compactTitle: { fontSize: 13 },
  subtitle: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, textAlign: 'center', lineHeight: 18 },
  button: {
    marginTop: spacing.md, backgroundColor: colors.primary, borderRadius: radius.md,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
  },
  buttonText: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.primaryForeground },
});
