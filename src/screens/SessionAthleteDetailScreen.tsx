/**
 * Session → Member stat screen — the "well-detailed model" drill-down
 * reached from History → tap a past session → leaderboard → tap a
 * member. Mirrors the Admin Panel / Branch Portal's
 * SessionAthleteDetail page 1:1 (Rank, UV/Sweat/Recovery Points,
 * Calories, EPOC, Avg/Peak BPM, Max %HR) plus this app's own
 * zone-coloured / single-colour BPM curve toggle and a horizontally
 * scrollable "slider" graph for the full session, not squeezed to fit.
 *
 * Distinct from AthleteDetailScreen (which also has a session-drilldown
 * mode) — this is the dedicated, fuller screen the leaderboard links to;
 * AthleteDetailScreen stays as the Members-tab profile browser.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, useWindowDimensions,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { ChevronLeft, ChevronRight, HeartPulse, Palette } from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import { sessionsApi, membersApi, type RemoteSession, type HrTick } from '../services/sessionsApi';
import { getSession, getSessionMembers, getTicksForMember, type LocalSessionRow } from '../db/database';
import { ZoneDistributionBar, ZoneTimeBreakdown, zoneSecondsToBuckets } from '../components/ZoneDistribution';
import { BpmLineGraph, type GraphPoint } from '../components/BpmLineGraph';
import { Screen } from '../components/Screen';
import { computeMhr, computeZoneFromHr } from '../lib/formula-engine';

interface LocalMemberRow {
  member_id: string;
  member_name: string;
  avg_hr: number | null;
  peak_hr: number | null;
  calories: number | null;
  uv_score: number | null;
  zone_seconds_json: string | null;
  summary_json: string | null;
}

/** Everything the stat grid needs, reconciled from whichever source has it. */
interface AthleteSessionStats {
  memberName: string;
  memberCode: string | null;
  rank: number | null;
  uvScore: number | null;
  sweatPoints: number | null;
  recoveryPoints: number | null;
  recoveryGrade: string | null;
  calories: number | null;
  epocCalories: number | null;
  avgHr: number | null;
  peakHr: number | null;
  avgPctMhr: number | null;
  maxPctMhr: number | null;
  zoneSeconds: number[] | Record<string, number> | null;
}

export function SessionAthleteDetailScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'SessionAthleteDetail'>>();
  const { width } = useWindowDimensions();
  const wide = width >= 700;

  const { sessionId, memberId } = route.params;

  const [remote, setRemote] = useState<RemoteSession | null>(null);
  const [local, setLocal] = useState<LocalSessionRow | null>(null);
  const [localMember, setLocalMember] = useState<LocalMemberRow | null>(null);
  const [ticks, setTicks] = useState<HrTick[]>([]);
  const [ticksSource, setTicksSource] = useState<'local' | 'remote' | 'none'>('none');
  const [ageYears, setAgeYears] = useState<number | null>(null);
  const [sex, setSex] = useState<'male' | 'female' | 'other' | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Two independent view toggles on the curve, both available at once —
  // "zone color based graph" and "single color graph" from the spec:
  // zoneColors true = coloured per-zone segments, false = flat single colour.
  const [zoneColors, setZoneColors] = useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [r, l, membersLocal] = await Promise.all([
      sessionsApi.get(sessionId).catch((e) => {
        setLoadError(e?.message ?? 'Could not load session details.');
        return null;
      }),
      getSession(sessionId).catch(() => null),
      getSessionMembers(sessionId).catch(() => []),
    ]);
    setRemote(r);
    setLocal(l);
    const lm = (membersLocal as unknown as LocalMemberRow[]).find((m) => m.member_id === memberId) ?? null;
    setLocalMember(lm);

    // Ticks: prefer local SQLite (this device ran the session — richest,
    // zero network), then fall back to the cloud API's zone-tagged ticks
    // (session synced from elsewhere / a different trainer's device).
    const localTicks = await getTicksForMember(sessionId, memberId).catch(() => []);
    if (localTicks.length > 0) {
      setTicks(localTicks.map((t) => ({ ts: t.ts, bpm: t.bpm })));
      setTicksSource('local');
    } else {
      const remoteTicks = await sessionsApi.athleteTicks(sessionId, memberId).catch(() => null);
      if (remoteTicks?.ticks?.length) {
        setTicks(remoteTicks.ticks);
        setTicksSource('remote');
      } else {
        setTicks([]);
        setTicksSource('none');
      }
    }

    // Member bio (for computing %MHR client-side on raw local ticks that
    // don't already carry it) — best-effort, a failed profile fetch
    // shouldn't block the rest of the screen; it just means locally-run
    // sessions fall back to a flat (unzoned) curve.
    membersApi.profile(memberId).then((p) => {
      setAgeYears(p.member?.ageYears ?? null);
      setSex((p.member?.sex as 'male' | 'female' | 'other' | null) ?? null);
    }).catch(() => {});

    setLoading(false);
  }, [sessionId, memberId]);

  useEffect(() => { load(); }, [load]);

  const remoteMember = remote?.members?.find((m) => m.memberId === memberId);

  const stats: AthleteSessionStats = useMemo(() => {
    let zoneSeconds: number[] | Record<string, number> | null = null;
    if (localMember?.zone_seconds_json) {
      try { zoneSeconds = JSON.parse(localMember.zone_seconds_json); } catch { zoneSeconds = null; }
    }
    // Fallback: if local DB doesn't have zone data (synced session,
    // or saveSessionMemberSummary wasn't called), try the remote
    // member's zoneMinutes — converted to seconds for the distribution
    // bar + breakdown.
    if (!zoneSeconds && remoteMember?.zoneMinutes) {
      const zm = remoteMember.zoneMinutes;
      zoneSeconds = [0, 0, 0, 0, 0, 0];
      for (const [z, mins] of Object.entries(zm)) {
        const idx = Number(z);
        if (idx >= 0 && idx <= 5) zoneSeconds[idx] = Math.round(mins * 60);
      }
    }
    // Full FinalSessionSummary (sweatPoints/recoveryPoints/epoc/etc.) is
    // persisted whole in summary_json on this device — parse it for the
    // fields the session_members columns don't have their own column for.
    let localSummary: Record<string, unknown> | null = null;
    if (localMember?.summary_json) {
      try { localSummary = JSON.parse(localMember.summary_json); } catch { localSummary = null; }
    }

    const rank =
      remoteMember?.finalRank ??
      (typeof localSummary?.finalRank === 'number' ? (localSummary.finalRank as number) : null) ??
      (remote?.members
        ? remote.members.slice().sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)).findIndex((m) => m.memberId === memberId) + 1
        : null);

    return {
      memberName: remoteMember?.member?.name ?? localMember?.member_name ?? 'Member',
      memberCode: remoteMember?.member?.memberCode ?? null,
      rank: rank && rank > 0 ? rank : null,
      uvScore: remoteMember?.score ?? localMember?.uv_score ?? null,
      sweatPoints: remoteMember?.sweatPoints ?? (localSummary?.sweatPoints as number | undefined) ?? null,
      recoveryPoints: remoteMember?.recoveryPoints ?? (localSummary?.recoveryPoints as number | undefined) ?? null,
      recoveryGrade: remoteMember?.recoveryGrade ?? (localSummary?.recoveryGrade as string | undefined) ?? null,
      calories: remoteMember?.calories ?? localMember?.calories ?? null,
      epocCalories: remoteMember?.epocCalories ?? (localSummary?.epocCalories as number | undefined) ?? null,
      avgHr: remoteMember?.avgHr ?? localMember?.avg_hr ?? null,
      peakHr: remoteMember?.maxHr ?? localMember?.peak_hr ?? null,
      avgPctMhr: remoteMember?.avgPctMhr ?? (localSummary?.avgPctMhr as number | undefined) ?? null,
      maxPctMhr: remoteMember?.maxPctMhr ?? null,
      zoneSeconds,
    };
  }, [remote, remoteMember, localMember, memberId]);

  // %MHR-tagged ticks — if the tick source already carries pctMhr/zone
  // (remote, from the cloud API's zoneForBpm), use it directly; for
  // local ticks (raw bpm only) compute it client-side from the member's
  // stored MHR when we have age/sex, same approach as AthleteDetailScreen.
  const mhr = ageYears != null && sex && sex !== 'other' ? computeMhr(ageYears, sex) : null;
  const zonedTicks = useMemo(() => {
    if (ticksSource === 'remote') return ticks;
    if (!mhr || mhr <= 0) return ticks;
    return ticks.map((t) => ({ ...t, ...computeZoneFromHr(t.bpm, mhr) }));
  }, [ticks, ticksSource, mhr]);

  const maxPctMhr = useMemo(() => {
    if (stats.maxPctMhr != null) return stats.maxPctMhr;
    const withPct = zonedTicks.filter((t) => t.pctMhr != null);
    if (withPct.length === 0) return null;
    return Math.round(Math.max(...withPct.map((t) => t.pctMhr as number)) * 10) / 10;
  }, [stats.maxPctMhr, zonedTicks]);

  const graphPoints: GraphPoint[] = useMemo(
    () => zonedTicks.map((t) => ({ value: t.bpm, zone: zoneColors ? (t.zone ?? undefined) : undefined })),
    [zonedTicks, zoneColors],
  );

  // Zone-second fallback: when the local DB doesn't have zone_seconds_json
  // (synced session, or saveSessionMemberSummary wasn't called), derive
  // zone buckets directly from the zone-tagged ticks so the zone
  // distribution bar + breakdown still render.
  const effectiveZoneSeconds = useMemo(() => {
    if (stats.zoneSeconds) return stats.zoneSeconds;
    if (zonedTicks.length === 0) return null;
    const counts: Record<number, number> = {};
    for (const t of zonedTicks) {
      if (t.zone != null) {
        counts[t.zone] = (counts[t.zone] || 0) + 1;
      }
    }
    if (Object.keys(counts).length === 0) return null;
    const result: number[] = [0, 0, 0, 0, 0, 0];
    for (const [zone, secs] of Object.entries(counts)) {
      result[Number(zone)] = secs;
    }
    return result;
  }, [stats.zoneSeconds, zonedTicks]);

  const buckets = zoneSecondsToBuckets(effectiveZoneSeconds);
  const sessionName = remote?.name ?? local?.session_name ?? 'Session';

  if (loading) {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      </Screen>
    );
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} style={styles.backBtn}>
          <ChevronLeft size={22} color={colors.foreground} />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.headerTitle} numberOfLines={1}>{stats.memberName}</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>{sessionName}</Text>
        </View>
      </View>

      {loadError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{loadError}</Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={[styles.identity, wide && styles.identityWrap]}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(stats.memberName)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.name}>{stats.memberName}</Text>
            {stats.memberCode ? <Text style={styles.code}>{stats.memberCode}</Text> : null}
          </View>
        </View>

        {/* Full 9-box stat grid — Rank, UV/Sweat/Recovery Points, */}
        {/* Calories, EPOC, Avg/Peak BPM, Max %HR — same set as the */}
        {/* Admin Panel / Branch Portal drill-down. */}
        <View style={[styles.statsGrid, wide && styles.statsGridWide]}>
          <Stat label="Rank" value={stats.rank != null ? `#${stats.rank}` : '—'} highlight />
          <Stat label="UV Points" value={fmt1(stats.uvScore)} highlight />
          <Stat label="Sweat Points" value={fmt1(stats.sweatPoints)} />
          <Stat label="Recovery Points" value={fmt1(stats.recoveryPoints)} sub={stats.recoveryGrade ?? undefined} />
          <Stat label="Calories" value={stats.calories != null ? `${Math.round(stats.calories)} kcal` : '—'} />
          <Stat label="EPOC (kcal)" value={stats.epocCalories != null ? `${Math.round(stats.epocCalories)}` : '—'} />
          <Stat label="Avg BPM" value={stats.avgHr != null ? `${Math.round(stats.avgHr)}` : '—'} />
          <Stat label="Peak BPM" value={stats.peakHr != null ? `${Math.round(stats.peakHr)}` : '—'} />
          <Stat label="Max %HR" value={maxPctMhr != null ? `${Math.round(maxPctMhr)}%` : '—'} />
        </View>

        {/* Heart rate curve — zone-colour toggle + horizontally */}
        {/* scrollable "slider" for the full session. */}
        <View style={styles.statBlock}>
          <View style={styles.hrHeaderRow}>
            <Text style={styles.blockTitle}>Heart Rate Curve — full session</Text>
            <TouchableOpacity style={styles.hrTick} onPress={() => setZoneColors((v) => !v)} activeOpacity={0.8}>
              <View style={[styles.hrTickBox, zoneColors && styles.hrTickBoxOn]}>
                {zoneColors ? <HeartPulse size={11} color={colors.primaryForeground} /> : <Palette size={11} color={colors.mutedForeground} />}
              </View>
              <Text style={[styles.hrTickLabel, zoneColors && styles.hrTickLabelOn]}>
                {zoneColors ? 'Zone colours' : 'Single colour'}
              </Text>
            </TouchableOpacity>
          </View>
          <BpmLineGraph
            points={graphPoints}
            height={160}
            scrollable
            pxPerPoint={4}
            emptyLabel={
              ticksSource === 'none'
                ? 'No second-by-second BPM data available for this session yet.'
                : 'No readings recorded.'
            }
          />
        </View>

        {/* Zone distribution — colour-coded bar + per-zone time breakdown. */}
        <View style={styles.statBlock}>
          <Text style={styles.blockTitle}>Zone Distribution — this session</Text>
          <ZoneDistributionBar buckets={buckets} height={14} />
          <ZoneTimeBreakdown buckets={buckets} />
        </View>

        <TouchableOpacity style={styles.sessionLink} onPress={() => navigation.navigate('SessionDetails', { sessionId })}>
          <Text style={styles.sessionLinkText}>Open full session leaderboard</Text>
          <ChevronRight size={16} color={colors.primary} />
        </TouchableOpacity>

        <View style={{ height: spacing.xxl }} />
      </ScrollView>
    </Screen>
  );
}

function initials(name: string): string {
  return name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function fmt1(v: number | null | undefined): string {
  if (v == null) return '—';
  return String(Math.round(v * 10) / 10);
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <View style={[styles.statCard, highlight && styles.statCardHighlight]}>
      <Text style={[styles.statValue, highlight && styles.statValueHighlight]} numberOfLines={1}>{value}</Text>
      <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
      {sub ? <Text style={styles.statSub} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  headerTitle: { fontFamily: fonts.heading, fontSize: 18, color: colors.foreground },
  headerSubtitle: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 1 },
  errorBanner: { marginHorizontal: spacing.lg, marginBottom: spacing.sm, backgroundColor: colors.warning + '1A', borderRadius: radius.md, padding: spacing.sm },
  errorText: { fontFamily: fonts.body, fontSize: 12, color: colors.warning },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  identityWrap: { maxWidth: 640, alignSelf: 'center', width: '100%' },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.heading, fontSize: 18, color: colors.foreground },
  name: { fontFamily: fonts.heading, fontSize: 19, color: colors.foreground },
  code: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 1 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, width: '100%', marginBottom: spacing.md },
  statsGridWide: { maxWidth: 640, alignSelf: 'center' },
  statCard: { width: '31%', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, alignItems: 'center' },
  statCardHighlight: { borderColor: colors.primary + '55', backgroundColor: colors.primary + '12' },
  statValue: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.foreground, maxWidth: '100%' },
  statValueHighlight: { color: colors.primary },
  statLabel: { fontFamily: fonts.body, fontSize: 10, color: colors.mutedForeground, marginTop: 2, textAlign: 'center' },
  statSub: { fontFamily: fonts.bodyMedium, fontSize: 9, color: colors.primary, marginTop: 1, textAlign: 'center' },
  statBlock: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm, marginBottom: spacing.md, maxWidth: 640, alignSelf: 'center', width: '100%' },
  blockTitle: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.mutedForeground },
  hrHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hrTick: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hrTickBox: { width: 18, height: 18, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  hrTickBoxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  hrTickLabel: { fontFamily: fonts.bodyMedium, fontSize: 11, color: colors.mutedForeground },
  hrTickLabelOn: { color: colors.primary },
  sessionLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  sessionLinkText: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.primary },
});
