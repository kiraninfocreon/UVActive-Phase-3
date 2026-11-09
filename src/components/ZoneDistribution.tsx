import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts, radius } from '../theme/tokens';
import { ZONE_COLOURS, ZONE_NAMES } from '../lib/formula-engine';

export interface ZoneBucket {
  zone: number; // 0-5
  seconds: number;
}

/**
 * Horizontal stacked zone-time bar — the shared visual for "how much of the
 * session did this member spend in each zone", used identically on the
 * session summary, member-in-session stats and member profile. Zones are
 * colour-coded from the centralized ZONE_COLOURS (never redefined locally).
 */
export function ZoneDistributionBar({ buckets, height = 10 }: { buckets: ZoneBucket[]; height?: number }) {
  const total = buckets.reduce((sum, b) => sum + b.seconds, 0);
  if (total <= 0) {
    return (
      <View style={[styles.bar, { height }]}>
        <View style={[styles.segment, { flex: 1, backgroundColor: colors.muted }]} />
      </View>
    );
  }

  // Normalize; zone 0 (below zone 1 / standby) shown as muted so real
  // training time stands out.
  const segments = buckets
    .filter((b) => b.seconds > 0)
    .sort((a, b) => a.zone - b.zone)
    .map((b) => {
      const isStandby = b.zone === 0;
      return {
        zone: b.zone,
        seconds: b.seconds,
        flex: b.seconds / total,
        color: isStandby ? colors.muted : ZONE_COLOURS[b.zone as keyof typeof ZONE_COLOURS] ?? colors.muted,
      };
    });

  return (
    <View style={styles.row}>
      <View style={[styles.bar, { height }]}>
        {segments.map((s, i) => (
          <View key={i} style={[styles.segment, { flex: s.flex, backgroundColor: s.color }]} />
        ))}
      </View>
    </View>
  );
}

/** Legend row — zone colour swatch + name (5 training zones). */
export function ZoneLegend({ showStandby = false }: { showStandby?: boolean }) {
  const zones = showStandby ? ([0, 1, 2, 3, 4, 5] as const) : ([1, 2, 3, 4, 5] as const);
  return (
    <View style={styles.legendWrap}>
      {zones.map((z) => (
        <View key={z} style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: z === 0 ? colors.muted : ZONE_COLOURS[z] }]} />
          <Text style={styles.legendText}>{ZONE_NAMES[z]}</Text>
        </View>
      ))}
    </View>
  );
}

/** Converts a zone-seconds array/tuple into buckets for the bar. */
export function zoneSecondsToBuckets(zoneSeconds: ArrayLike<number> | Record<string, number> | undefined | null): ZoneBucket[] {
  if (!zoneSeconds) return [];
  const buckets: ZoneBucket[] = [];
  for (let zone = 0; zone <= 5; zone++) {
    const secs = Array.isArray(zoneSeconds) || ArrayBuffer.isView(zoneSeconds)
      ? Number((zoneSeconds as ArrayLike<number>)[zone] ?? 0)
      : Number((zoneSeconds as Record<string, number>)[String(zone)] ?? 0);
    buckets.push({ zone, seconds: secs });
  }
  return buckets;
}

function formatMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return `${Math.round(seconds)}s`;
  return `${m}m`;
}

/** Compact per-zone time breakdown with percentages. */
export function ZoneTimeBreakdown({ buckets }: { buckets: ZoneBucket[] }) {
  const total = buckets.reduce((s, b) => s + b.seconds, 0);
  const rows = buckets.filter((b) => b.seconds > 0).sort((a, b) => b.seconds - a.seconds);
  if (rows.length === 0) return <Text style={styles.emptyText}>No zone time recorded.</Text>;
  return (
    <View style={styles.breakdown}>
      {rows.map((b) => {
        const pct = total > 0 ? Math.round((b.seconds / total) * 100) : 0;
        const color = b.zone === 0 ? colors.muted : ZONE_COLOURS[b.zone as keyof typeof ZONE_COLOURS] ?? colors.muted;
        return (
          <View key={b.zone} style={styles.breakdownRow}>
            <View style={[styles.breakdownDot, { backgroundColor: color }]} />
            <Text style={styles.breakdownZone} numberOfLines={1}>{ZONE_NAMES[b.zone as keyof typeof ZONE_NAMES]}</Text>
            <Text style={styles.breakdownTime}>{formatMinutes(b.seconds)}</Text>
            <Text style={styles.breakdownPct}>{pct}%</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { width: '100%' },
  bar: { width: '100%', borderRadius: radius.full, overflow: 'hidden', flexDirection: 'row' },
  segment: { height: '100%' },
  legendWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground },
  breakdown: { gap: 6, width: '100%' },
  breakdownRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  breakdownDot: { width: 10, height: 10, borderRadius: 5 },
  breakdownZone: { flex: 1, fontFamily: fonts.body, fontSize: 12, color: colors.foreground },
  breakdownTime: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.foreground },
  breakdownPct: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.mutedForeground, width: 38, textAlign: 'right' },
  emptyText: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground },
});
