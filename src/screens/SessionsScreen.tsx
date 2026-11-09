import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, useWindowDimensions, Alert } from 'react-native';
import { useEffect } from 'react';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { Dumbbell, Plus, ChevronRight, Radio, Play, History as HistoryIcon, CalendarClock } from 'lucide-react-native';
import { colors, fonts, radius, spacing, type } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { sessionsApi, type RemoteSession } from '../services/sessionsApi';
import { ApiError } from '../services/api';
import { listRecentSessions, type LocalSessionRow } from '../db/database';
import { sessionEngine } from '../services/sessionEngine';
import { useResponsiveLayout } from '../lib/responsive';
import { EmptyState } from '../components/EmptyState';
import { Screen } from '../components/Screen';
import { Glass } from '../components/uv/Glass';
import { UnderlineTabs, PillButton } from '../components/uv/Ui';

export type SessionDisplay = {
  id: string;
  name: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  capacity: number;
  memberCount: number;
  synced: boolean;
  remote?: RemoteSession;
  local?: LocalSessionRow;
};

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_COLOR: Record<string, string> = {
  scheduled: colors.info,
  in_progress: colors.primary,
  completed: colors.success,
  cancelled: colors.mutedForeground,
};

/** Merge remote (cloud) + local (SQLite) sessions into one display list. */
function mergeSessions(remote: RemoteSession[], local: LocalSessionRow[]): SessionDisplay[] {
  const map = new Map<string, SessionDisplay>();
  for (const r of remote) {
    map.set(r.id, {
      id: r.id,
      name: r.name,
      status: r.status,
      scheduledAt: r.scheduledAt ?? null,
      startedAt: r.startedAt ?? null,
      endedAt: r.endedAt ?? null,
      durationSeconds: null,
      capacity: r.capacity,
      memberCount: r._count?.members ?? r.members?.length ?? 0,
      synced: true,
      remote: r,
    });
  }
  for (const l of local) {
    const existing = map.get(l.session_id);
    if (existing) {
      existing.local = l;
      // Local knows more (e.g. a live session that hasn't synced yet).
      if (l.status === 'in_progress' && existing.status !== 'in_progress') existing.status = 'in_progress';
      if (l.status === 'completed' && existing.status !== 'completed' && existing.status !== 'in_progress') existing.status = 'completed';
      existing.durationSeconds = existing.durationSeconds ?? l.duration_seconds ?? null;
      existing.synced = existing.synced && l.synced === 1;
    } else {
      map.set(l.session_id, {
        id: l.session_id,
        name: l.session_name,
        status: (l.status as SessionDisplay['status']) ?? 'scheduled',
        scheduledAt: l.scheduled_at ? new Date(l.scheduled_at).toISOString() : null,
        startedAt: l.started_at ? new Date(l.started_at).toISOString() : null,
        endedAt: l.ended_at ? new Date(l.ended_at).toISOString() : null,
        durationSeconds: l.duration_seconds ?? null,
        capacity: 0,
        memberCount: 0,
        synced: l.synced === 1,
        local: l,
      });
    }
  }
  return Array.from(map.values());
}

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function sortKey(s: SessionDisplay): number {
  // In-progress first, then today's scheduled, then upcoming, then past.
  if (s.status === 'in_progress') return 0;
  if (s.status === 'scheduled') {
    const t = s.scheduledAt ? new Date(s.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER;
    return t < Date.now() ? 1 : 2;
  }
  return 3 + (s.endedAt ? new Date(s.endedAt).getTime() : s.startedAt ? new Date(s.startedAt).getTime() : 0) / 1e15;
}

type InnerTab = 'scheduled' | 'history';

/** A scheduled session can be started once its time has arrived (unscheduled ones any time). */
function canStart(s: SessionDisplay, now: number): boolean {
  if (!s.scheduledAt) return true;
  return new Date(s.scheduledAt).getTime() <= now;
}

function startsIn(s: SessionDisplay, now: number): string {
  if (!s.scheduledAt) return 'now';
  const mins = Math.ceil((new Date(s.scheduledAt).getTime() - now) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `in ${Math.floor(mins / 1440)}d`;
}

export function SessionsScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const { width } = useWindowDimensions();
  const responsive = useResponsiveLayout();

  const [remote, setRemote] = useState<RemoteSession[]>([]);
  const [local, setLocal] = useState<LocalSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Two sub-tabs inside the Sessions tab: "Scheduled" (in-progress + today
  // + upcoming, with the Schedule Session action) and "History" (past —
  // completed/cancelled). This restores the standalone History screen the
  // old app had, as its own tab within Sessions rather than a separate
  // bottom-tab, plus gives Scheduled a clearly-labelled place to start a
  // new booking.
  const [innerTab, setInnerTab] = useState<InnerTab>('scheduled');
  // Re-render every 20s so "Starts in 12 min" counts down and the Start
  // button unlocks the moment a scheduled session's time arrives.
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 20000); return () => clearInterval(t); }, []);

  const load = useCallback(async () => {
    setError(null);
    const [r, l] = await Promise.all([
      sessionsApi
        .listMine()
        .then((list) => { setRemote(list ?? []); return list ?? []; })
        .catch((e: unknown) => {
          setError(e instanceof ApiError ? e.message : 'Could not load sessions — check your connection.');
          return [] as RemoteSession[];
        }),
      listRecentSessions(200).catch(() => [] as LocalSessionRow[]),
    ]);
    setLocal(l);
    setLoading(false);
    // keep remote even if a later fetch fails
    if (Array.isArray(r)) setRemote(r);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const all = useMemo(() => mergeSessions(remote, local).sort((a, b) => sortKey(a) - sortKey(b)), [remote, local]);

  const sections = useMemo(() => {
    const inProgress = all.filter((s) => s.status === 'in_progress');
    // Every session scheduled for TODAY shows here, even if its start time
    // has already passed but it was never started — an overdue scheduled
    // session must stay visible and tappable (tap = start it), not vanish
    // from the list (which is what a strict "start time not reached yet"
    // filter would do to it).
    const today = all.filter((s) => s.status === 'scheduled' && isToday(s.scheduledAt));
    const upcoming = all.filter((s) => s.status === 'scheduled' && !isToday(s.scheduledAt) && new Date(s.scheduledAt!).getTime() >= Date.now());
    // History lives here now (the standalone History tab was removed) —
    // newest first, matching what the old History screen showed.
    const past = all
      .filter((s) => s.status !== 'scheduled' && s.status !== 'in_progress')
      .sort((a, b) => {
        const ta = a.endedAt ? new Date(a.endedAt).getTime() : a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const tb = b.endedAt ? new Date(b.endedAt).getTime() : b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return tb - ta;
      });
    return { inProgress, today, upcoming, past };
  }, [all]);

  const columns = width >= 900 ? 2 : 1;
  const rowWidth = columns === 2 ? (Math.min(responsive.contentMaxWidth, width) - spacing.lg * 2 - spacing.md) / 2 : undefined;

  // What tapping a session row does depends on where it is in its life:
  //   scheduled  → straight to the start flow (preloaded with its roster,
  //                assign sensors, go live) — the "sessions about to
  //                start, tap to start" behaviour.
  //   in_progress→ resume the live screen if the engine still has it,
  //                otherwise the resume/setup flow rehydrates it from
  //                SQLite.
  //   past       → full details/leaderboard view.
  const handleRowPress = (s: SessionDisplay) => {
    if (s.status === 'scheduled') {
      if (!canStart(s, now)) {
        Alert.alert('Not time yet', `"${s.name}" can be started when its scheduled time arrives (${startsIn(s, now)}).`);
        return;
      }
      navigation.navigate('SessionSetup', { mode: 'start-scheduled', sessionId: s.id, sessionName: s.name });
    } else if (s.status === 'in_progress') {
      if (sessionEngine.isActive && sessionEngine.currentSessionId === s.id) {
        navigation.navigate('LiveSession', { sessionId: s.id });
      } else {
        navigation.navigate('SessionSetup', { mode: 'start-scheduled', sessionId: s.id, sessionName: s.name });
      }
    } else {
      navigation.navigate('SessionDetails', { sessionId: s.id });
    }
  };

  const renderSection = (title: string, items: SessionDisplay[]) => {
    if (items.length === 0) return null;
    return (
      <View style={styles.section} key={title}>
        <Text style={styles.sectionTitle}>{title} · {items.length}</Text>
        <View style={[styles.grid, columns === 2 && styles.grid2]}>
          {items.map((s) => (
            <SessionRow key={s.id} session={s} now={now} width={rowWidth} onPress={() => handleRowPress(s)} />
          ))}
        </View>
      </View>
    );
  };

  const scheduledCount = sections.inProgress.length + sections.today.length + sections.upcoming.length;
  const historyCount = sections.past.length;

  return (
    <Screen edges={['top']}>
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.heading}>Sessions</Text>
          <Text style={styles.subheading}>Schedule, start and review training sessions</Text>
        </View>
      </View>

      <View style={styles.tabRow}>
        <UnderlineTabs
          value={innerTab}
          onChange={setInnerTab}
          tabs={[
            { key: 'scheduled', label: 'Scheduled', badge: scheduledCount || undefined },
            { key: 'history', label: 'History', badge: historyCount || undefined },
          ]}
        />
      </View>

      {/* Schedule-a-session action lives on the Scheduled tab — that's
          the tab this action actually populates, so the button and the
          list it fills stay together instead of a global header button
          that's equally reachable (and equally confusing) from History. */}
      {innerTab === 'scheduled' && (
        <PillButton label="Schedule session" icon={<Plus size={15} color={colors.primaryForeground} />} onPress={() => navigation.navigate('SessionSetup', { mode: 'schedule' })} style={{ marginHorizontal: spacing.xl, marginBottom: spacing.lg }} />
      )}

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error} Showing on-device sessions.</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <Text style={styles.loadingText}>Loading sessions…</Text>
        </View>
      ) : innerTab === 'scheduled' ? (
        scheduledCount === 0 ? (
          <EmptyState
            icon={Dumbbell}
            title="No sessions yet"
            subtitle="Schedule a session and it will show up here ready to start."
            actionLabel="Schedule Session"
            onAction={() => navigation.navigate('SessionSetup', { mode: 'schedule' })}
          />
        ) : (
          <FlatList
            data={[0]}
            keyExtractor={() => 'x'}
            renderItem={() => (
              <View>
                {renderSection('In Progress', sections.inProgress)}
                {renderSection('Today', sections.today)}
                {renderSection('Upcoming', sections.upcoming)}
                <View style={{ height: spacing.xxl }} />
              </View>
            )}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          />
        )
      ) : historyCount === 0 ? (
        <EmptyState
          icon={HistoryIcon}
          title="No past sessions"
          subtitle="Completed and cancelled sessions will show up here once you've run some."
        />
      ) : (
        <FlatList
          data={[0]}
          keyExtractor={() => 'x'}
          renderItem={() => (
            <View>
              {renderSection('Past', sections.past)}
              <View style={{ height: spacing.xxl }} />
            </View>
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
    </Screen>
  );
}

function formatWhen(s: SessionDisplay): string {
  const iso = s.status === 'scheduled' ? s.scheduledAt : s.startedAt ?? s.scheduledAt ?? s.endedAt;
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

function SessionRow({ session, now, width, onPress }: { session: SessionDisplay; now: number; width?: number; onPress: () => void }) {
  const color = STATUS_COLOR[session.status] ?? colors.mutedForeground;
  const isInProgress = session.status === 'in_progress';
  const isScheduled = session.status === 'scheduled';
  return (
    <TouchableOpacity
      style={[styles.row, width ? { width } : undefined]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={[styles.statusStripe, { backgroundColor: color }]} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>{session.name}</Text>
          {!session.synced && <Text style={styles.pendingPill}>pending sync</Text>}
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {isInProgress ? <Text style={[styles.liveLabel, { color: colors.primary }]}>● LIVE </Text> : null}
          {formatWhen(session)}
        </Text>
        <View style={styles.rowBottom}>
          <View style={[styles.statusPill, { backgroundColor: color + '22', borderColor: color + '55' }]}>
            {isInProgress && <Radio size={10} color={color} />}
            <Text style={[styles.statusText, { color }]}>{STATUS_LABEL[session.status] ?? session.status}</Text>
          </View>
          {!isScheduled && session.durationSeconds ? <Text style={styles.rowDuration}>{Math.round(session.durationSeconds / 60)} min</Text> : null}
          <Text style={styles.rowMembers}>{session.memberCount}/{session.capacity || '∞'} members</Text>
          {isScheduled ? (
            canStart(session, now) ? (
              <View style={styles.startPill}>
                <Play size={11} color={colors.primaryForeground} />
                <Text style={styles.startPillText}>Start</Text>
              </View>
            ) : (
              <View style={styles.lockedPill}>
                <Text style={styles.lockedPillText}>Starts {startsIn(session, now)}</Text>
              </View>
            )
          ) : isInProgress ? (
            <View style={styles.resumePill}>
              <Play size={11} color={colors.primary} />
              <Text style={styles.resumePillText}>Resume</Text>
            </View>
          ) : (
            <ChevronRight size={16} color={colors.mutedForeground} style={styles.rowChevron} />
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.md,
  },
  heading: { fontFamily: fonts.heading, fontSize: 30, letterSpacing: -0.5, color: colors.foreground },
  subheading: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 2 },
  newButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    marginHorizontal: spacing.lg, marginBottom: spacing.md,
  },
  newButtonText: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.primaryForeground },
  tabRow: { paddingHorizontal: spacing.xl, marginTop: spacing.sm },
  tabBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: 8,
    borderRadius: radius.full, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
  },
  tabBtnActive: { backgroundColor: colors.primary + '18', borderColor: colors.primary + '55' },
  tabBtnText: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.mutedForeground },
  tabBtnTextActive: { color: colors.primary, fontFamily: fonts.bodySemiBold },
  tabBadge: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  tabBadgeActive: { backgroundColor: colors.primary + '33' },
  tabBadgeText: { fontFamily: fonts.bodySemiBold, fontSize: 10, color: colors.mutedForeground },
  tabBadgeTextActive: { color: colors.primary },
  errorBanner: {
    marginHorizontal: spacing.lg, marginBottom: spacing.sm,
    backgroundColor: colors.warning + '1A', borderRadius: radius.md, padding: spacing.sm,
  },
  errorText: { fontFamily: fonts.body, fontSize: 12, color: colors.warning },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: spacing.xxl },
  loadingText: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground },
  listContent: { paddingHorizontal: spacing.xl, paddingBottom: 130 },
  section: { marginTop: spacing.lg },
  sectionTitle: { ...type.sectionTitle, marginBottom: spacing.sm },
  grid: { gap: spacing.sm },
  grid2: { flexDirection: 'row', flexWrap: 'wrap' },
  row: {
    flexDirection: 'row', backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder,
    borderRadius: radius.xl, overflow: 'hidden', marginBottom: spacing.sm,
  },
  statusStripe: { width: 4 },
  rowBody: { flex: 1, padding: spacing.md, minWidth: 0 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowName: { flex: 1, fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.foreground },
  pendingPill: { fontFamily: fonts.bodyMedium, fontSize: 10, color: colors.warning, backgroundColor: colors.warning + '22', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  rowMeta: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 3 },
  liveLabel: { fontFamily: fonts.bodySemiBold },
  rowBottom: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: spacing.sm },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 2 },
  statusText: { fontFamily: fonts.bodySemiBold, fontSize: 10 },
  rowDuration: { fontFamily: fonts.bodyMedium, fontSize: 11, color: colors.mutedForeground },
  rowMembers: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, flex: 1 },
  rowChevron: {},
  startPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  lockedPill: { backgroundColor: colors.glassStrong, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  lockedPillText: { fontFamily: fonts.metric, fontSize: 10, color: colors.mutedForeground },
  startPillText: { fontFamily: fonts.bodySemiBold, fontSize: 10, color: colors.primaryForeground },
  resumePill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.primary + '22', borderWidth: 1, borderColor: colors.primary + '55', borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 3 },
  resumePillText: { fontFamily: fonts.bodySemiBold, fontSize: 10, color: colors.primary },
  noUpcoming: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground, textAlign: 'center', marginTop: spacing.xl },
});
