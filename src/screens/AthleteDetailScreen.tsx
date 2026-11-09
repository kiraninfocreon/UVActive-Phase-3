import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity, useWindowDimensions,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { ChevronLeft, ChevronRight, HeartPulse } from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import { membersApi, type MemberProfileResponse } from '../services/sessionsApi';
import { getSession, getSessionMembers, getTicksForMember } from '../db/database';
import { sessionsApi } from '../services/sessionsApi';
import { ZoneDistributionBar, ZoneTimeBreakdown, zoneSecondsToBuckets } from '../components/ZoneDistribution';
import { BpmLineGraph, type GraphPoint } from '../components/BpmLineGraph';
import { Screen } from '../components/Screen';
import { computeMhr, computeZoneFromHr } from '../lib/formula-engine';


interface SessionMemberStat {
  member_id: string;
  member_name: string;
  avg_hr: number | null;
  peak_hr: number | null;
  calories: number | null;
  uv_score: number | null;
  zone_seconds_json: string | null;
}

export function AthleteDetailScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'AthleteDetail'>>();
  const { width } = useWindowDimensions();
  const wide = width >= 700;

  const memberId = route.params.memberId;
  const sessionId = route.params.sessionId; // drill-down mode: show stats for THIS session

  const [profile, setProfile] = useState<MemberProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionStat, setSessionStat] = useState<SessionMemberStat | null>(null);
  const [rank, setRank] = useState<number | null>(null);
  const [zoneSeconds, setZoneSeconds] = useState<number[] | Record<string, number> | null>(null);
  const [bpmPoints, setBpmPoints] = useState<GraphPoint[]>([]);
  const [sessionName, setSessionName] = useState<string | null>(null);
  // "HR tick" — toggles the HR curve between a flat line and one coloured
  // per-sample by which training zone that reading fell in (zone colours
  // shared with the rest of the app — see formula-engine/zones.ts).
  const [showZoneColors, setShowZoneColors] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const p = await membersApi.profile(memberId);
        if (!cancelled) {
          setProfile(p);
          // Profile mode (no sessionId): the API already returns
          // zone/%MHR-tagged hrTicks across this member's sessions —
          // feed those straight into the HR curve so the zone-colour
          // toggle has something to show without a session drill-down.
          if (!sessionId && p.hrTicks?.length) {
            setBpmPoints(p.hrTicks.slice().reverse().map((t) => ({ value: t.bpm })));
          }
        }
      } catch {
        // profile fetch is best-effort in drill-down mode; local data still shows
      }

      if (sessionId) {
        const [members, localTicks, sess] = await Promise.all([
          getSessionMembers(sessionId).catch(() => [] as unknown[]),
          getTicksForMember(sessionId, memberId).catch(() => []),
          getSession(sessionId).catch(() => null),
        ]);
        const row = (members as SessionMemberStat[]).find((m) => m.member_id === memberId);
        if (row && !cancelled) {
          setSessionStat(row);
          let zs: number[] | Record<string, number> | null = null;
          try { zs = row.zone_seconds_json ? JSON.parse(row.zone_seconds_json) : null; } catch { zs = null; }
          setZoneSeconds(zs);
          const sorted = (members as SessionMemberStat[]).slice().sort((a, b) => (b.uv_score ?? -1) - (a.uv_score ?? -1));
          setRank(sorted.findIndex((m) => m.member_id === memberId) + 1 || null);
        }
        if (sess && !cancelled) setSessionName(sess.session_name);
        // Prefer local ticks (rich, zero network), then fall back to the
        // cloud API's zone-tagged ticks for sessions synced from elsewhere.
        let ticks = localTicks;
        if (ticks.length === 0) {
          const remoteTicks = await sessionsApi.athleteTicks(sessionId, memberId).catch(() => null);
          if (remoteTicks?.ticks?.length) {
            ticks = remoteTicks.ticks;
          }
        }
        if (!cancelled) setBpmPoints(ticks.map((t) => ({ value: t.bpm })));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [memberId, sessionId]);

  // Zone-annotated HR curve for the "HR tick" toggle — each raw bpm
  // sample gets tagged with the training zone it falls in, computed from
  // this member's own MHR (age + sex, per formula-engine/mhr.ts), so
  // BpmLineGraph can colour the line/dot per zone instead of a flat
  // colour. Falls back to the plain curve when we don't have enough
  // profile data to compute a meaningful MHR.
  const member = profile?.member;
  const zonedBpmPoints = useMemo<GraphPoint[]>(() => {
    if (!showZoneColors || !member?.ageYears) return bpmPoints;
    const mhr = computeMhr(member.ageYears, member.sex === 'female' ? 'female' : 'male');
    if (!mhr || mhr <= 0) return bpmPoints;
    return bpmPoints.map((p) => ({ value: p.value, zone: computeZoneFromHr(p.value, mhr).zone }));
  }, [bpmPoints, showZoneColors, member?.ageYears, member?.sex]);

  // Aggregate zone distribution across ALL of this member's sessions
  // (profile mode) — sum each session's zoneMinutes (already returned
  // by /branch/members/:id/profile) into one seconds-per-zone tuple.
  const profileZoneSeconds = useMemo<number[] | null>(() => {
    if (sessionId || !profile?.sessions?.length) return null;
    const totals = [0, 0, 0, 0, 0, 0];
    let any = false;
    for (const s of profile.sessions) {
      if (!s.zoneMinutes) continue;
      for (const [zone, mins] of Object.entries(s.zoneMinutes)) {
        const idx = Number(zone);
        if (idx >= 0 && idx <= 5 && typeof mins === 'number') {
          totals[idx] += Math.round(mins * 60);
          any = true;
        }
      }
    }
    return any ? totals : null;
  }, [sessionId, profile?.sessions]);

  if (loading) {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      </Screen>
    );
  }

  const name = member?.name ?? sessionStat?.member_name ?? 'Member';
  const code = member?.memberCode;

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} style={styles.backBtn}>
          <ChevronLeft size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {sessionId && sessionName ? sessionName : name}
        </Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView style={styles.root} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={[styles.identity, wide && styles.identityWide]}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(name)}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.name}>{name}</Text>
            {code ? <Text style={styles.code}>{code}</Text> : null}
            {sessionId && rank != null && (
              <View style={styles.rankPill}>
                <Text style={styles.rankPillText}>Rank #{rank} this session</Text>
              </View>
            )}
          </View>
        </View>

        {sessionId && sessionStat ? (
          <SessionStats
            stat={sessionStat}
            zoneSeconds={zoneSeconds}
            bpmPoints={zonedBpmPoints}
            showZoneColors={showZoneColors}
            onToggleZoneColors={() => setShowZoneColors((v) => !v)}
            wide={wide}
            onOpenSession={() => navigation.navigate('SessionDetails', { sessionId })}
          />
        ) : member ? (
          <ProfileStats
            member={member}
            avgBpm={profile?.avgBpmOverall ?? null}
            wide={wide}
            zoneSeconds={profileZoneSeconds}
            bpmPoints={zonedBpmPoints}
            showZoneColors={showZoneColors}
            onToggleZoneColors={() => setShowZoneColors((v) => !v)}
          />
        ) : (
          <Text style={styles.emptyText}>No profile data available for this member.</Text>
        )}

        {/* Session history (profile mode only) */}
        {!sessionId && profile && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Session History</Text>
            {profile.sessions.length === 0 ? (
              <Text style={styles.emptyText}>No sessions yet.</Text>
            ) : (
              profile.sessions.map((s) => (
                <TouchableOpacity
                  key={s.sessionId}
                  style={styles.sessionRow}
                  // This member's OWN stats/graph/zone-distribution for
                  // that specific session — not the whole-class
                  // leaderboard. Previously this routed to SessionDetails
                  // (the class leaderboard), so tapping a session from a
                  // member's profile never actually showed that member's
                  // individual per-session stat/graph — you'd land on the
                  // leaderboard and have to find + tap yourself again.
                  onPress={() => navigation.navigate('SessionAthleteDetail', { memberId, sessionId: s.sessionId })}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.sessionName} numberOfLines={1}>{s.sessionName}</Text>
                    <Text style={styles.sessionMeta}>{s.startedAt ? new Date(s.startedAt).toLocaleString() : '—'}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', marginRight: spacing.xs }}>
                    <Text style={styles.sessionStat}>Avg {s.avgHr ?? '—'} · Peak {s.peakHr ?? '—'} bpm</Text>
                    <Text style={styles.sessionMeta}>{s.calories ?? '—'} kcal · Score {s.score ?? '—'}</Text>
                  </View>
                  <ChevronRight size={16} color={colors.mutedForeground} />
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        <View style={{ height: spacing.xxl }} />
      </ScrollView>
    </Screen>
  );
}

function initials(name: string): string {
  return name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function ProfileStats({
  member, avgBpm, wide, zoneSeconds, bpmPoints, showZoneColors, onToggleZoneColors,
}: {
  member: NonNullable<MemberProfileResponse['member']>;
  avgBpm: number | null;
  wide: boolean;
  zoneSeconds: number[] | null;
  bpmPoints: GraphPoint[];
  showZoneColors: boolean;
  onToggleZoneColors: () => void;
}) {
  const buckets = zoneSecondsToBuckets(zoneSeconds);
  return (
    <View style={{ gap: spacing.md }}>
      <View style={[styles.statsGrid, wide && styles.statsGridWide]}>
        <Stat label="Age" value={member.ageYears ? `${member.ageYears}` : '—'} />
        <Stat label="Sex" value={member.sex ? member.sex[0].toUpperCase() + member.sex.slice(1) : '—'} />
        <Stat label="Height" value={member.heightCm ? `${member.heightCm} cm` : '—'} />
        <Stat label="Weight" value={member.weightKg ? `${member.weightKg} kg` : '—'} />
        <Stat label="Resting HR" value={member.restingHr ? `${member.restingHr} bpm` : '—'} />
        <Stat label="Avg BPM (all)" value={avgBpm ? `${Math.round(avgBpm)}` : '—'} />
      </View>

      <View style={[styles.statBlock, wide && styles.statsGridWide]}>
        <Text style={styles.blockTitle}>Zone Distribution — all sessions</Text>
        <ZoneDistributionBar buckets={buckets} height={12} />
        <ZoneTimeBreakdown buckets={buckets} />
      </View>

      <View style={[styles.statBlock, wide && styles.statsGridWide]}>
        <View style={styles.hrHeaderRow}>
          <Text style={styles.blockTitle}>Heart Rate Curve — recent readings</Text>
          <TouchableOpacity style={styles.hrTick} onPress={onToggleZoneColors} activeOpacity={0.8}>
            <View style={[styles.hrTickBox, showZoneColors && styles.hrTickBoxOn]}>
              {showZoneColors && <HeartPulse size={11} color={colors.primaryForeground} />}
            </View>
            <Text style={[styles.hrTickLabel, showZoneColors && styles.hrTickLabelOn]}>HR zone colors</Text>
          </TouchableOpacity>
        </View>
        <BpmLineGraph points={bpmPoints} height={140} emptyLabel="No recent readings available." />
      </View>
    </View>
  );
}

function SessionStats({
  stat, zoneSeconds, bpmPoints, wide, onOpenSession, showZoneColors, onToggleZoneColors,
}: {
  stat: SessionMemberStat;
  zoneSeconds: number[] | Record<string, number> | null;
  bpmPoints: GraphPoint[];
  wide: boolean;
  onOpenSession: () => void;
  showZoneColors: boolean;
  onToggleZoneColors: () => void;
}) {
  const buckets = zoneSecondsToBuckets(zoneSeconds);
  return (
    <View style={styles.sessionStatsWrap}>
      <View style={[styles.statsGrid, wide && styles.statsGridWide]}>
        <Stat label="Avg HR" value={stat.avg_hr != null ? `${Math.round(stat.avg_hr)} bpm` : '—'} />
        <Stat label="Peak HR" value={stat.peak_hr != null ? `${Math.round(stat.peak_hr)} bpm` : '—'} />
        <Stat label="Calories" value={stat.calories != null ? `${Math.round(stat.calories)} kcal` : '—'} />
        <Stat label="UV Score" value={stat.uv_score != null ? String(Math.round(stat.uv_score * 10) / 10) : '—'} />
      </View>

      <View style={styles.statBlock}>
        <Text style={styles.blockTitle}>Zone Distribution — this session</Text>
        <ZoneDistributionBar buckets={buckets} height={12} />
        <ZoneTimeBreakdown buckets={buckets} />
      </View>

      <View style={styles.statBlock}>
        <View style={styles.hrHeaderRow}>
          <Text style={styles.blockTitle}>Heart Rate Curve</Text>
          {/* The "HR tick" — flip on to colour the curve by which zone
              each reading fell in, instead of a flat line. */}
          <TouchableOpacity style={styles.hrTick} onPress={onToggleZoneColors} activeOpacity={0.8}>
            <View style={[styles.hrTickBox, showZoneColors && styles.hrTickBoxOn]}>
              {showZoneColors && <HeartPulse size={11} color={colors.primaryForeground} />}
            </View>
            <Text style={[styles.hrTickLabel, showZoneColors && styles.hrTickLabelOn]}>HR zone colors</Text>
          </TouchableOpacity>
        </View>
        <BpmLineGraph points={bpmPoints} height={140} emptyLabel="No readings recorded locally." />
      </View>

      <TouchableOpacity style={styles.sessionLink} onPress={onOpenSession}>
        <Text style={styles.sessionLinkText}>Open full session details</Text>
        <ChevronRight size={16} color={colors.primary} />
      </TouchableOpacity>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  headerTitle: { fontFamily: fonts.heading, fontSize: 18, color: colors.foreground, flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  identityWide: { maxWidth: 640, alignSelf: 'center', width: '100%' },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.heading, fontSize: 18, color: colors.foreground },
  name: { fontFamily: fonts.heading, fontSize: 19, color: colors.foreground },
  code: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 1 },
  rankPill: { alignSelf: 'flex-start', backgroundColor: colors.primary + '22', borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 3, marginTop: spacing.xs },
  rankPillText: { fontFamily: fonts.bodySemiBold, fontSize: 11, color: colors.primary },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, width: '100%', marginBottom: spacing.sm },
  statsGridWide: { maxWidth: 640, alignSelf: 'center' },
  statCard: { width: '31%', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, alignItems: 'center' },
  statValue: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.foreground, maxWidth: '100%' },
  statLabel: { fontFamily: fonts.body, fontSize: 10, color: colors.mutedForeground, marginTop: 2, textAlign: 'center' },
  section: { marginTop: spacing.lg },
  sectionTitle: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.foreground, marginBottom: spacing.sm },
  emptyText: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground },
  sessionRow: {
    flexDirection: 'row', width: '100%', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, alignItems: 'center',
  },
  sessionName: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.foreground },
  sessionMeta: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, marginTop: 2 },
  sessionStat: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.foreground },
  sessionStatsWrap: { gap: spacing.md, maxWidth: 640, alignSelf: 'center', width: '100%' },
  statBlock: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm },
  blockTitle: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.mutedForeground },
  hrHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hrTick: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hrTickBox: { width: 18, height: 18, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  hrTickBoxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  hrTickLabel: { fontFamily: fonts.bodyMedium, fontSize: 11, color: colors.mutedForeground },
  hrTickLabelOn: { color: colors.primary },
  sessionLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  sessionLinkText: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.primary },
  deviceMeta: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, marginTop: 1 },
});
