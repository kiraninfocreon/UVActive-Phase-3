import React from 'react';
import { Text, View, TouchableOpacity, StyleSheet, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { colors, fonts, radius, spacing, type } from '../../theme/tokens';
import { Glass } from './Glass';

/** Lovable `.section-title` — tiny, tracked, uppercase. */
export function SectionTitle({ children, right, style }: { children: React.ReactNode; right?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md }, style]}>
      <Text style={type.sectionTitle}>{children}</Text>
      {right}
    </View>
  );
}

/** Lovable `.metric-label`. */
export function MetricLabel({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.metricLabel, style]}>{children}</Text>;
}

/** Number first, label second — Lovable `MetricCard`. */
export function MetricCard({ value, label, unit, sub, accent = 'none', style }: {
  value: number | string; label: string; unit?: string; sub?: string; accent?: 'primary' | 'recovery' | 'none'; style?: StyleProp<ViewStyle>;
}) {
  const color = accent === 'primary' ? colors.primary : accent === 'recovery' ? colors.recovery : colors.foreground;
  return (
    <Glass style={[{ padding: spacing.lg, flex: 1 }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5 }}>
        <Text style={{ fontFamily: fonts.metric, fontSize: 30, lineHeight: 34, color }}>{value}</Text>
        {unit ? <Text style={{ fontFamily: fonts.metric, fontSize: 11, color: colors.mutedForeground }}>{unit}</Text> : null}
      </View>
      <MetricLabel style={{ marginTop: 10 }}>{label}</MetricLabel>
      {sub ? <Text style={{ fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, opacity: 0.75, marginTop: 4 }}>{sub}</Text> : null}
    </Glass>
  );
}

/** Lovable `.btn-cerise` (filled) / `.btn-cerise-outline` (glass). */
export function PillButton({ label, onPress, variant = 'solid', icon, disabled, style }: {
  label: string; onPress?: () => void; variant?: 'solid' | 'glass' | 'danger'; icon?: React.ReactNode; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
  const bg = variant === 'solid' ? colors.primary : variant === 'danger' ? 'rgba(224,75,82,0.14)' : colors.glassStrong;
  const fg = variant === 'solid' ? colors.primaryForeground : variant === 'danger' ? colors.destructive : colors.foreground;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
      style={[
        {
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
          backgroundColor: bg, borderRadius: radius.full, paddingHorizontal: 22, paddingVertical: 13,
          opacity: disabled ? 0.4 : 1,
        },
        variant === 'solid' && !disabled ? { shadowColor: colors.primary, shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 6 } : null,
        style,
      ]}
    >
      {icon}
      <Text style={{ fontFamily: fonts.bodySemiBold, fontSize: 13, color: fg }}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Underline tabs — Lovable Activity page's `Journal / Stats / Feed` switcher. */
export function UnderlineTabs<T extends string>({ tabs, value, onChange }: {
  tabs: { key: T; label: string; badge?: number }[]; value: T; onChange: (k: T) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 28, marginBottom: spacing.lg }}>
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <TouchableOpacity key={t.key} onPress={() => onChange(t.key)} activeOpacity={0.8} style={{ paddingBottom: 8, borderBottomWidth: 1.5, borderBottomColor: active ? colors.primary : 'transparent', flexDirection: 'row', gap: 6, alignItems: 'center' }}>
            <Text style={{ fontFamily: fonts.bodySemiBold, fontSize: 12, letterSpacing: 1.8, textTransform: 'uppercase', color: active ? colors.foreground : colors.mutedForeground }}>{t.label}</Text>
            {t.badge ? (
              <View style={{ minWidth: 18, height: 18, borderRadius: 9, backgroundColor: active ? colors.primary + '33' : colors.glass, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}>
                <Text style={{ fontFamily: fonts.metric, fontSize: 10, color: active ? colors.primary : colors.mutedForeground }}>{t.badge}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** Time-aware greeting header (Lovable `StateHeader`). */
export function Greeting({ name, title, detail }: { name?: string; title?: React.ReactNode; detail?: string }) {
  const h = new Date().getHours();
  const label = h < 5 ? 'Late night' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 21 ? 'Evening' : 'Tonight';
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary }} />
        <Text style={type.metricLabel}>{label}{name ? ` · ${name}` : ''}</Text>
      </View>
      {title ? <Text style={{ fontFamily: fonts.heading, fontSize: 30, lineHeight: 34, color: colors.foreground, letterSpacing: -0.5, marginTop: 12 }}>{title}</Text> : null}
      {detail ? <Text style={{ fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: colors.mutedForeground, marginTop: 8, maxWidth: 320 }}>{detail}</Text> : null}
    </View>
  );
}

export const uiStyles = StyleSheet.create({
  page: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg },
});
