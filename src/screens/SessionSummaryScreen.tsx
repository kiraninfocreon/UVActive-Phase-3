import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, useWindowDimensions } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { Trophy, Home, ChevronRight } from 'lucide-react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { getSession, getSessionMembers, type LocalSessionRow } from '../db/database';
import { ZoneDistributionBar, ZoneTimeBreakdown, zoneSecondsToBuckets } from '../components/ZoneDistribution';
import { ZONE_COLOURS, ZONE_NAMES } from '../lib/formula-engine';
import { useResponsiveLayout } from '../lib/responsive';
import { Screen } from '../components/Screen';

interface SummaryRow {
  member_id: string;
  member_name: string;
  avg_hr: number | null;
  peak_hr: number | null;
  calories: number | null;
  uv_score: number | null;
  zone_seconds_json?: string | null;
}

function parseZoneSeconds(json: string | null | undefined): number[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function topZone(zoneSeconds: number[] | null): number {
  if (!zoneSeconds) return 0;
  let best = 0, bestSecs = -1;
  for (let z = 0; z < zoneSeconds.length; z++) {
    if (zoneSeconds[z] > bestSecs) { bestSecs = zoneSeconds[z]; best = z; }
  }
  return best;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function SessionSummaryScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'SessionSummary'>>();
  const responsive = useResponsiveLayout();
  const { width } = useWindowDimensions();

  const [session, setSession] = useState<LocalSessionRow | null>(null);
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getSession(route.params.sessionId), getSessionMembers(route.params.sessionId)])
      .then(([s, m]) => {
        setSession(s);
        setRows((m as unknown as SummaryRow[]).slice().sort((a, b) => (b.uv_score ?? -1) - (a.uv_score ?? -1)));
      })
      .catch((e) => console.warn('[SessionSummaryScreen] Failed to load session', e))
      .finally(() => setLoading(false));
  }, [route.params.sessionId]);

  if (loading) {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      </Screen>
    );
  }

  const totalScore = rows.reduce((sum, r) => sum + (r.uv_score ?? 0), 0);
  const avgPct = rows.length
    ? Math.round(rows.reduce((sum, r) => sum + (r.avg_hr ?? 0), 0) / rows.length)
    : 0;
  const totalCalories = rows.reduce((sum, r) => sum + (r.calories ?? 0), 0);
  const podium = rows.slice(0, 3);
  const twoCol = width >= 900;

  // Whole-session aggregate zone distribution — sum of every member's
  // zone-seconds for the class-level bar shown above the leaderboard.
  const aggZoneBuckets = React.useMemo(() => {
    const totals = [0, 0, 0, 0, 0, 0];
    let any = false;
    for (const r of rows) {
      const zs = parseZoneSeconds(r.zone_seconds_json);
      if (zs) {
        for (let z = 0; z < Math.min(zs.length, 6); z++) {
          totals[z] += zs[z];
          if (zs[z] > 0) any = true;
        }
      }
    }
    return any ? zoneSecondsToBuckets(totals) : null;
  }, [rows]);

  return (
    <Screen edges={['top', 'bottom']}>
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.trophyWrap}>
          <Trophy size={26} color={colors.primary} />
        </View>
        <Text style={styles.title}>{session?.session_name ?? 'Session'}</Text>
        <Text style={styles.subtitle}>
          {formatDuration(session?.duration_seconds ?? null)}
          {session?.ended_at ? ` · Ended ${new Date(session.ended_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
          {' '}· {rows.length} athletes
        </Text>
      </View>

      {/* Top-line stats */}
      <View style={styles.topStats}>
        <TopStat value={totalScore.toLocaleString()} label="Total UV Points" color={colors.primary} />
        <TopStat value={String(avgPct)} label="Avg HR (bpm)" color={colors.warning} />
        <TopStat value={totalCalories.toLocaleString()} label="Total Calories" color={colors.success} />
        <TopStat value={String(rows.length)} label="Athletes" color={colors.foreground} />
      </View>

      {/* Podium */}
      {podium.length >= 2 && (
        <View style={styles.podiumRow}>
          {podium.length === 3 ? (
            <>
              <PodiumBlock item={podium[1]} rank={2} medal="2" color="#6B7280" />
              <PodiumBlock item={podium[0]} rank={1} medal="1" color="#D97706" big />
              <PodiumBlock item={podium[2]} rank={3} medal="3" color="#92400E" />
            </>
          ) : (
            <>
              <PodiumBlock item={podium[0]} rank={1} medal="1" color="#D97706" big />
              {podium[1] && <PodiumBlock item={podium[1]} rank={2} medal="2" color="#6B7280" />}
            </>
          )}
        </View>
      )}

      {/* Whole-session zone distribution — aggregate of every member */}
      {aggZoneBuckets && (
        <View style={styles.zoneBlock}>
          <Text style={styles.zoneBlockTitle}>Zone Distribution — whole class, this session</Text>
          <ZoneDistributionBar buckets={aggZoneBuckets} height={14} />
          <ZoneTimeBreakdown buckets={aggZoneBuckets} />
        </View>
      )}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.member_id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          rows.length > 0 ? (
            <View style={[styles.zoneLegendRow, twoCol && styles.zoneLegendRow2]}>
              <Text style={styles.zoneLegendTitle}>Final Leaderboard — tap a member for their session stats</Text>
            </View>
          ) : null
        }
        renderItem={({ item, index }) => {
          const zs = parseZoneSeconds(item.zone_seconds_json);
          const tz = topZone(zs);
          const zoneColor = tz === 0 ? colors.muted : ZONE_COLOURS[tz as keyof typeof ZONE_COLOURS] ?? colors.muted;
          return (
            <TouchableOpacity
              style={[styles.row, index === 0 && styles.rowTop1, index === 1 && styles.rowTop2, index === 2 && styles.rowTop3]}
              onPress={() => navigation.navigate('SessionAthleteDetail', { memberId: item.member_id, sessionId: route.params.sessionId })}
              activeOpacity={0.85}
            >
              <View style={[styles.rankBadge, index === 0 && styles.rankGold, index === 1 && styles.rankSilver, index === 2 && styles.rankBronze]}>
                <Text style={styles.rankText}>{index + 1}</Text>
              </View>
              <View style={[styles.zoneBar, { backgroundColor: zoneColor }]} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={1}>{item.member_name}</Text>
                <Text style={styles.stats} numberOfLines={1}>
                  Avg {item.avg_hr ?? '—'} · Peak {item.peak_hr ?? '—'} bpm · {item.calories ?? '—'} kcal
                  {tz > 0 ? ` · ${ZONE_NAMES[tz as keyof typeof ZONE_NAMES]}` : ''}
                </Text>
                {zs && <ZoneDistributionBar buckets={zoneSecondsToBuckets(zs)} height={5} />}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.score}>{item.uv_score ?? '—'}</Text>
                <Text style={styles.scoreLabel}>score</Text>
              </View>
              <ChevronRight size={15} color={colors.mutedForeground} />
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>No results recorded for this session.</Text>
          </View>
        }
      />

      <TouchableOpacity style={styles.doneButton} onPress={() => navigation.navigate('Main')}>
        <Home size={18} color={colors.primaryForeground} />
        <Text style={styles.doneButtonText}>Back to Home</Text>
      </TouchableOpacity>
    </View>
    </Screen>
  );
}

function TopStat({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <View style={styles.topStat}>
      <Text style={[styles.topStatValue, { color }]} numberOfLines={1}>{value}</Text>
      <Text style={styles.topStatLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function PodiumBlock({ item, rank, medal, color, big = false }: { item: SummaryRow; rank: number; medal: string; color: string; big?: boolean }) {
  const initials = item.member_name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return (
    <View style={[styles.podiumBlock, big && styles.podiumBlockBig]}>
      <Text style={styles.podiumMedal}>{medal === '1' ? '🥇' : medal === '2' ? '🥈' : '🥉'}</Text>
      <Text style={styles.podiumRank}>#{rank}</Text>
      <View style={[styles.podiumAvatar, { backgroundColor: color, width: big ? 52 : 42, height: big ? 52 : 42, borderRadius: big ? 26 : 21 }]}>
        <Text style={styles.podiumAvatarText}>{initials}</Text>
      </View>
      <Text style={styles.podiumName} numberOfLines={1}>{item.member_name}</Text>
      <Text style={styles.podiumScore}>{item.uv_score ?? '—'} pts</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  header: { alignItems: 'center', paddingTop: spacing.xl, paddingHorizontal: spacing.lg, gap: 3 },
  trophyWrap: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.primary + '1A', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  title: { fontFamily: fonts.heading, fontSize: 22, color: colors.foreground, textAlign: 'center' },
  subtitle: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground, textAlign: 'center' },
  topStats: { flexDirection: 'row', backgroundColor: colors.card, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border, marginTop: spacing.lg, paddingVertical: spacing.sm },
  topStat: { flex: 1, alignItems: 'center', paddingHorizontal: 2 },
  topStatValue: { fontFamily: fonts.heading, fontSize: 17, color: colors.primary },
  topStatLabel: { fontFamily: fonts.body, fontSize: 9, color: colors.mutedForeground, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  podiumRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.lg, paddingHorizontal: spacing.md },
  podiumBlock: { flex: 1, maxWidth: 130, alignItems: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingVertical: spacing.md, paddingHorizontal: spacing.xs },
  podiumBlockBig: { borderColor: '#D97706' },
  podiumMedal: { fontSize: 18, marginBottom: 2 },
  podiumRank: { fontFamily: fonts.bodySemiBold, fontSize: 11, color: colors.mutedForeground, marginBottom: 4 },
  podiumAvatar: { alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  podiumAvatarText: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: '#fff' },
  podiumName: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.foreground, textAlign: 'center' },
  podiumScore: { fontFamily: fonts.heading, fontSize: 13, color: colors.primary, marginTop: 3 },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xl },
  zoneLegendRow: { marginBottom: spacing.sm },
  zoneLegendRow2: {},
  zoneLegendTitle: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.mutedForeground },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.card,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.sm,
  },
  rowTop1: { borderColor: '#D97706' },
  rowTop2: { borderColor: '#6B7280' },
  rowTop3: { borderColor: '#92400E' },
  rankBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  rankGold: { backgroundColor: '#D97706' },
  rankSilver: { backgroundColor: '#6B7280' },
  rankBronze: { backgroundColor: '#92400E' },
  rankText: { fontFamily: fonts.bodySemiBold, fontSize: 12, color: '#fff' },
  zoneBar: { width: 4, height: 34, borderRadius: 2 },
  name: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.foreground },
  stats: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, marginTop: 2 },
  score: { fontFamily: fonts.heading, fontSize: 17, color: colors.primary },
  scoreLabel: { fontFamily: fonts.body, fontSize: 9, color: colors.mutedForeground, textTransform: 'uppercase' },
  emptyWrap: { alignItems: 'center', paddingTop: spacing.xxl },
  emptyText: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground },
  zoneBlock: { marginHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.xs, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md },
  zoneBlockTitle: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.mutedForeground, marginBottom: spacing.sm },
  doneButton: {
    flexDirection: 'row', gap: spacing.sm, backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: spacing.md, alignItems: 'center', justifyContent: 'center', marginHorizontal: spacing.lg, marginBottom: spacing.xl,
  },
  doneButtonText: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.primaryForeground },
});
