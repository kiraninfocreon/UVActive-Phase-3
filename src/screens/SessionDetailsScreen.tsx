import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, useWindowDimensions,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { ChevronLeft, Play, Radio, Users, Trophy, CalendarClock, Ban, CheckCircle2 } from 'lucide-react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useAuth } from '../hooks/useAuth';
import { sessionsApi, type RemoteSession } from '../services/sessionsApi';
import { ApiError } from '../services/api';
import { getSession, getSessionMembers, type LocalSessionRow } from '../db/database';
import { ZoneDistributionBar, ZoneTimeBreakdown, zoneSecondsToBuckets, type ZoneBucket } from '../components/ZoneDistribution';
import { Screen } from '../components/Screen';


/** Raw snake_case row shape from getSessionMembers(). */
interface MemberResultRow {
  session_id: string;
  member_id: string;
  member_name: string;
  sensor_device_id: string | null;
  avg_hr: number | null;
  peak_hr: number | null;
  calories: number | null;
  uv_score: number | null;
  zone_seconds_json: string | null;
  summary_json: string | null;
  synced: number;
}

interface MemberResult {
  memberId: string;
  memberName: string;
  avgHr: number | null;
  peakHr: number | null;
  calories: number | null;
  score: number | null;
  zoneSeconds: number[] | Record<string, number> | null;
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function SessionDetailsScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'SessionDetails'>>();
  const { staff } = useAuth();
  const { width } = useWindowDimensions();

  const [remote, setRemote] = useState<RemoteSession | null>(null);
  const [local, setLocal] = useState<LocalSessionRow | null>(null);
  const [results, setResults] = useState<MemberResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const sessionId = route.params.sessionId;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [r, l, members] = await Promise.all([
      sessionsApi.get(sessionId).catch((e: unknown) => {
        setLoadError(e instanceof ApiError ? e.message : 'Could not load session details.');
        return null;
      }),
      getSession(sessionId).catch(() => null),
      getSessionMembers(sessionId).catch(() => []),
    ]);
    setRemote(r);
    setLocal(l);
    setResults(
      (members as unknown as MemberResultRow[]).map((m) => {
        let zoneSeconds: number[] | Record<string, number> | null = null;
        try {
          zoneSeconds = m.zone_seconds_json ? JSON.parse(m.zone_seconds_json) : null;
        } catch { zoneSeconds = null; }
        return {
          memberId: m.member_id,
          memberName: m.member_name,
          avgHr: m.avg_hr,
          peakHr: m.peak_hr,
          calories: m.calories,
          score: m.uv_score,
          zoneSeconds,
        };
      }),
    );
    setLoading(false);
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  // If we have no local results (e.g. session was created/synced from
  // another device), fall back to the remote session's per-member results.
  const leaderboard = useMemo(() => {
    let rows = results;
    if (rows.length === 0 && remote?.members?.length) {
      rows = remote.members.map((m) => ({
        memberId: m.memberId,
        memberName: m.member?.name ?? 'Member',
        avgHr: m.avgHr ?? null,
        peakHr: m.maxHr ?? null,
        calories: m.calories ?? null,
        score: m.score ?? null,
        // Use zoneMinutes from the cloud API response (converted to
        // zoneSeconds for the zone distribution bar). Previously this
        // was hardcoded to null, which meant the zone distribution was
        // always empty for sessions synced from another device.
        zoneSeconds: m.zoneMinutes
          ? Object.fromEntries(Object.entries(m.zoneMinutes).map(([z, mins]) => [z, Math.round(mins * 60)]))
          : null,
      }));
    }
    return rows.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }, [results, remote]);

  // Session-level zone distribution — sum of every member's zone-seconds,
  // the same aggregate the Admin Panel / Branch Portal leaderboard shows
  // ("how did the whole class train"), not just a legend.
  const sessionZoneBuckets = useMemo<ZoneBucket[]>(() => {
    const totals = [0, 0, 0, 0, 0, 0];
    for (const m of leaderboard) {
      const buckets = zoneSecondsToBuckets(m.zoneSeconds);
      buckets.forEach((b) => { totals[b.zone] += b.seconds; });
    }
    return totals.map((seconds, zone) => ({ zone, seconds }));
  }, [leaderboard]);

  const status = (remote?.status ?? local?.status ?? 'scheduled') as keyof typeof STATUS_LABEL;
  const isCompleted = status === 'completed';
  const isInProgress = status === 'in_progress';
  const isScheduled = status === 'scheduled';

  const startedAt = remote?.startedAt ?? (local?.started_at ? new Date(local.started_at).toISOString() : null);
  const scheduledAt = remote?.scheduledAt ?? (local?.scheduled_at ? new Date(local.scheduled_at).toISOString() : null);

  // A session can't be started before its scheduled time — the trainer
  // can start it any time AFTER that point, there's no upper bound.
  const [now, setNow] = useState(Date.now());
  const scheduledMs = scheduledAt ? new Date(scheduledAt).getTime() : null;
  const notYetStartable = isScheduled && !!scheduledMs && now < scheduledMs;
  useEffect(() => {
    if (!notYetStartable) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [notYetStartable]);

  const onStart = () => {
    if (!staff || notYetStartable) return;
    navigation.navigate('SessionSetup', { mode: 'start-scheduled', sessionId, sessionName: remote?.name ?? local?.session_name });
  };

  const onResume = () => {
    navigation.navigate('LiveSession', { sessionId });
  };

  const onCancel = () => {
    Alert.alert('Cancel Session', `Cancel "${remote?.name ?? local?.session_name}"? This can't be undone.`, [
      { text: 'Keep Session', style: 'cancel' },
      {
        text: 'Cancel Session', style: 'destructive',
        onPress: async () => {
          setActing(true);
          try {
            await sessionsApi.cancel(sessionId, 'Cancelled by trainer');
            await load();
            Alert.alert('Cancelled', 'The session was cancelled.');
          } catch (e) {
            Alert.alert('Could not cancel', e instanceof ApiError ? e.message : 'Try again.');
          } finally {
            setActing(false);
          }
        },
      },
    ]);
  };

  const roster = remote?.members?.length
    ? remote.members.map((m) => ({ id: m.memberId, name: m.member?.name ?? 'Member', code: m.member?.memberCode ?? '' }))
    : results.map((r) => ({ id: r.memberId, name: r.memberName, code: '' }));

  if (loading) {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      </Screen>
    );
  }

  const name = remote?.name ?? local?.session_name ?? 'Session';
  const twoCol = width >= 900;

  return (
    <Screen edges={['top', 'bottom']}>
    <View style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10} style={styles.backBtn}>
          <ChevronLeft size={22} color={colors.foreground} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle} numberOfLines={1}>{name}</Text>
          <View style={styles.headerMetaRow}>
            <View style={[styles.statusPill, { backgroundColor: statusColor(status) + '22', borderColor: statusColor(status) + '55' }]}>
              <Text style={[styles.statusText, { color: statusColor(status) }]}>{STATUS_LABEL[status]}</Text>
            </View>
            <Text style={styles.headerMeta}>
              {isCompleted && local?.ended_at ? `Ended ${new Date(local.ended_at).toLocaleString()}` : isScheduled && scheduledAt ? `Scheduled ${new Date(scheduledAt).toLocaleString()}` : isInProgress && startedAt ? `Started ${new Date(startedAt).toLocaleString()}` : ''}
            </Text>
          </View>
        </View>
      </View>

      {loadError ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{loadError}</Text>
          <TouchableOpacity onPress={load}><Text style={styles.retryText}>Retry</Text></TouchableOpacity>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Summary stats */}
        <View style={[styles.statsRow, twoCol && styles.statsRowWide]}>
          <StatCard icon={<Users size={16} color={colors.primary} />} value={String(roster.length)} label="Members" />
          <StatCard
            icon={<Trophy size={16} color={colors.primary} />}
            value={isCompleted ? leaderboard[0]?.memberName?.split(' ')[0] ?? '—' : isInProgress ? 'Live' : '—'}
            label={isCompleted ? 'Winner' : isInProgress ? 'Status' : '—'}
          />
          <StatCard
            icon={<CalendarClock size={16} color={colors.primary} />}
            value={local?.duration_seconds ? `${Math.round(local.duration_seconds / 60)} min` : '—'}
            label="Duration"
          />
          <StatCard
            icon={<CheckCircle2 size={16} color={colors.primary} />}
            value={String(leaderboard.length)}
            label="With Results"
          />
        </View>

        {/* Roster */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Roster ({roster.length})</Text>
          {roster.length === 0 ? (
            <Text style={styles.emptyText}>No members assigned to this session yet.</Text>
          ) : (
            <View style={[styles.rosterGrid, twoCol && styles.rosterGrid2]}>
              {roster.map((m) => (
                <View key={m.id} style={styles.rosterRow}>
                  <View style={styles.avatar}><Text style={styles.avatarText}>{initials(m.name)}</Text></View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.rosterName} numberOfLines={1}>{m.name}</Text>
                    {m.code ? <Text style={styles.rosterCode}>{m.code}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Leaderboard (completed) */}
        {isCompleted && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Leaderboard</Text>
            {leaderboard.length === 0 ? (
              <Text style={styles.emptyText}>No results were recorded for this session.</Text>
            ) : (
              leaderboard.map((m, i) => (
                <TouchableOpacity
                  key={m.memberId}
                  style={styles.leaderRow}
                  onPress={() => navigation.navigate('SessionAthleteDetail', { memberId: m.memberId, sessionId })}
                  activeOpacity={0.85}
                >
                  <View style={[styles.rankBadge, i === 0 && styles.rankGold, i === 1 && styles.rankSilver, i === 2 && styles.rankBronze]}>
                    <Text style={styles.rankText}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.leaderName} numberOfLines={1}>{m.memberName}</Text>
                    <Text style={styles.leaderMeta}>
                      Avg {m.avgHr ?? '—'} bpm · Peak {m.peakHr ?? '—'} bpm · {m.calories ?? '—'} kcal
                    </Text>
                    <ZoneDistributionBar buckets={zoneSecondsToBuckets(m.zoneSeconds)} height={5} />
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.score}>{m.score ?? '—'}</Text>
                    <Text style={styles.scoreLabel}>score</Text>
                  </View>
                </TouchableOpacity>
              ))
            )}

            {leaderboard.length > 0 && (
              <View style={styles.zoneBlock}>
                <Text style={styles.zoneBlockTitle}>Zone Distribution — whole class, this session</Text>
                <ZoneDistributionBar buckets={sessionZoneBuckets} height={14} />
                <ZoneTimeBreakdown buckets={sessionZoneBuckets} />
              </View>
            )}
          </View>
        )}

        {/* Actions */}
        <View style={styles.actions}>
          {isScheduled && (
            <>
              <TouchableOpacity style={[styles.actionPrimary, (acting || notYetStartable) && styles.actionDisabled]} onPress={onStart} disabled={acting || notYetStartable}>
                <Play size={18} color={colors.primaryForeground} />
                <Text style={styles.actionPrimaryText}>
                  {notYetStartable ? `Starts at ${new Date(scheduledMs!).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'Start Session'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionDanger} onPress={onCancel} disabled={acting}>
                <Ban size={18} color={colors.destructive} />
                <Text style={styles.actionDangerText}>Cancel Session</Text>
              </TouchableOpacity>
            </>
          )}
          {isInProgress && (
            <TouchableOpacity style={styles.actionPrimary} onPress={onResume}>
              <Radio size={18} color={colors.primaryForeground} />
              <Text style={styles.actionPrimaryText}>Resume Live Session</Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </View>
    </Screen>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case 'scheduled': return colors.info;
    case 'in_progress': return colors.primary;
    case 'completed': return colors.success;
    default: return colors.mutedForeground;
  }
}

function initials(name: string): string {
  return name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function StatCard({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <View style={styles.statCard}>
      {icon}
      <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md,
  },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  headerTitleWrap: { flex: 1, minWidth: 0 },
  headerTitle: { fontFamily: fonts.heading, fontSize: 20, color: colors.foreground },
  headerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 4 },
  statusPill: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontFamily: fonts.bodySemiBold, fontSize: 10 },
  headerMeta: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, flex: 1 },
  errorBanner: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginHorizontal: spacing.lg, backgroundColor: colors.warning + '1A', borderRadius: radius.md, padding: spacing.sm,
  },
  errorText: { fontFamily: fonts.body, fontSize: 12, color: colors.warning, flex: 1 },
  retryText: { fontFamily: fonts.bodySemiBold, fontSize: 12, color: colors.primary, marginLeft: spacing.sm },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  statsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  statsRowWide: { flexWrap: 'wrap' },
  statCard: {
    flex: 1, minWidth: 0, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: spacing.md, alignItems: 'center', gap: 2,
  },
  statValue: { fontFamily: fonts.heading, fontSize: 16, color: colors.foreground, maxWidth: '100%' },
  statLabel: { fontFamily: fonts.body, fontSize: 10, color: colors.mutedForeground, textTransform: 'uppercase', letterSpacing: 0.5 },
  section: { marginTop: spacing.xl },
  sectionTitle: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.foreground, marginBottom: spacing.sm },
  emptyText: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground },
  rosterGrid: { gap: spacing.sm },
  rosterGrid2: { flexDirection: 'row', flexWrap: 'wrap' },
  rosterRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.card,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm,
  },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bodySemiBold, fontSize: 11, color: colors.foreground },
  rosterName: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.foreground },
  rosterCode: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, marginTop: 1 },
  leaderRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.card,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm,
  },
  rankBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  rankGold: { backgroundColor: '#D97706' },
  rankSilver: { backgroundColor: '#6B7280' },
  rankBronze: { backgroundColor: '#92400E' },
  rankText: { fontFamily: fonts.bodySemiBold, fontSize: 12, color: '#fff' },
  leaderName: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.foreground },
  leaderMeta: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, marginTop: 2 },
  score: { fontFamily: fonts.heading, fontSize: 18, color: colors.primary },
  scoreLabel: { fontFamily: fonts.body, fontSize: 9, color: colors.mutedForeground, textTransform: 'uppercase' },
  zoneBlock: { marginTop: spacing.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md },
  zoneBlockTitle: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.mutedForeground, marginBottom: spacing.sm },
  actions: { marginTop: spacing.xl, gap: spacing.sm },
  actionPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: spacing.md,
  },
  actionPrimaryText: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.primaryForeground },
  actionDanger: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    borderWidth: 1, borderColor: colors.destructive, borderRadius: radius.md, paddingVertical: spacing.md,
  },
  actionDangerText: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.destructive },
  actionDisabled: { opacity: 0.6 },
});
