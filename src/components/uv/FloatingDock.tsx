import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, radius } from '../../theme/tokens';

/**
 * Lovable `BottomNav` — a floating glass dock with a coral selection
 * pill, replacing the stock opaque tab bar. Works as `tabBar` for any
 * @react-navigation/bottom-tabs navigator (trainer + member apps).
 */
export function FloatingDock({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <LinearGradient colors={['rgba(9,9,11,0)', colors.background]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <View style={styles.dock}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const label = (options.tabBarLabel as string) ?? options.title ?? route.name;
          const active = state.index === index;
          const color = active ? colors.primary : colors.mutedForeground;
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!active && !event.defaultPrevented) navigation.navigate(route.name as never);
          };
          return (
            <TouchableOpacity key={route.key} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} activeOpacity={0.8} style={styles.item}>
              {active ? <View style={styles.pill} /> : null}
              <View style={{ opacity: active ? 1 : 0.8 }}>{options.tabBarIcon?.({ focused: active, color, size: 20 })}</View>
              <Text style={[styles.label, { color, opacity: active ? 1 : 0.7 }]}>{label}</Text>
              {options.tabBarBadge ? (
                <View style={styles.badge}><Text style={styles.badgeText}>{String(options.tabBarBadge)}</Text></View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 18, paddingTop: 26 },
  dock: {
    flexDirection: 'row', backgroundColor: 'rgba(24,24,30,0.92)', borderRadius: 26, padding: 8,
    borderWidth: 1, borderColor: colors.glassBorder,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 14,
  },
  item: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 8, borderRadius: radius.lg },
  pill: {
    ...StyleSheet.absoluteFillObject, borderRadius: 18, backgroundColor: 'rgba(251,80,97,0.13)',
    borderWidth: 1, borderColor: 'rgba(251,80,97,0.2)',
  },
  label: { fontFamily: fonts.bodyMedium, fontSize: 8.5, letterSpacing: 1.2, textTransform: 'uppercase' },
  badge: { position: 'absolute', top: 4, right: '28%', minWidth: 16, height: 16, borderRadius: 8, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { fontFamily: fonts.metricBold, fontSize: 9, color: '#fff' },
});
