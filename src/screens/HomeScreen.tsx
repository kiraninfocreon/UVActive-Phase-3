import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { useFocusEffect, useNavigation, type CompositeNavigationProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { ChevronRight, CalendarClock, AlertCircle, Play, Plus } from 'lucide-react-native';
import { colors, fonts, spacing } from '../theme/tokens';
import { useAuth } from '../hooks/useAuth';
import { gymApi, type BranchDashboard, type RemoteSession } from '../services/sessionsApi';
import { getResumableSessions, type LocalSessionRow } from '../db/database';
import { sessionEngine } from '../services/sessionEngine';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { MainTabsParamList } from '../navigation/MainTabs';
import { Screen } from '../components/Screen';
import { Glass } from '../components/uv/Glass';
import { RadialRing } from '../components/uv/RadialRing';
import { Greeting, MetricCard, SectionTitle, PillButton, MetricLabel } from '../components/uv/Ui';

type HomeNav = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabsParamList, 'Home'>,
  StackNavigationProp<RootStackParamList>
>;

function timeLabel(session: RemoteSession): string {
  if (!session.scheduledAt) return session.status === 'in_progress' ? 'In progress' : 'Unscheduled';
  return new Date(session.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function HomeScreen() {
  const { staff } = useAuth();
  const navigation = useNavigation<HomeNav>();
  const [dashboard, setDashboard] = useState<BranchDashboard | null>(null);
  const [dashboardError, setDashboardError] = useState(false);
  const [resumable, setResumable] = useState<LocalSessionRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [dash, resumableSessions] = await Promise.all([
      gymApi.dashboard().then((d) => { setDashboardError(false); return d; }).catch(() => { setDashboardError(true); return null; }),
      getResumableSessions(),
    ]);
    if (dash) setDashboard(dash);
    setResumable(resumableSessions);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const today = useMemo(() => dashboard?.sessionsToday ?? [], [dashboard]);
  const done = today.filter((s) => s.status === 'completed').length;
  const live = today.filter((s) => s.status === 'in_progress').length;
  const progress = today.length ? done / today.length : 0;
  const activeSession = sessionEngine.isActive ? sessionEngine.getSessionMeta() : null;

  return (
    <Screen edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <Greeting
          name={staff?.gymName}
          title={<>Hi {staff?.name?.split(' ')[0] ?? 'Coach'},{'\n'}ready to train?</>}
          detail={today.length ? `${today.length} session${today.length === 1 ? '' : 's'} today · ${done} done` : 'Nothing scheduled yet today.'}
        />

        {/* Today ring */}
        <View style={{ alignItems: 'center', marginVertical: spacing.xl }}>
          <RadialRing size={210} thickness={12} segments={[{ value: progress, color: colors.primary }, { value: live ? 0.04 : 0, color: colors.recovery }]}>
            <Text style={styles.ringValue}>{done}<Text style={styles.ringTotal}>/{today.length}</Text></Text>
            <MetricLabel style={{ marginTop: 6 }}>Sessions today</MetricLabel>
          </RadialRing>
        </View>

        <View style={styles.row}>
          <MetricCard value={dashboard?.memberCount ?? '—'} label="Members" accent="primary" />
          <MetricCard value={dashboard?.sensorCount ?? '—'} label="Sensors" accent="recovery" />
          <MetricCard value={live} label="Live now" />
        </View>

        {dashboardError && (
          <View style={styles.error}>
            <AlertCircle size={14} color={colors.warning} />
            <Text style={styles.errorText}>Couldn't refresh stats — showing the last known values.</Text>
          </View>
        )}

        {activeSession ? (
          <TouchableOpacity activeOpacity={0.85} onPress={() => navigation.navigate('LiveSession', { sessionId: activeSession.sessionId })}>
            <Glass style={styles.banner}>
              <View style={[styles.dot, { backgroundColor: colors.primary }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.bannerTitle} numberOfLines={1}>Live · {activeSession.sessionName}</Text>
                <Text style={styles.bannerNote}>Tap to return to the live monitor.</Text>
              </View>
              <Play size={18} color={colors.primary} />
            </Glass>
          </TouchableOpacity>
        ) : resumable.length > 0 ? (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => navigation.navigate('SessionSetup', { mode: 'start-scheduled', sessionId: resumable[0].session_id, sessionName: resumable[0].session_name })}
          >
            <Glass style={styles.banner}>
              <View style={[styles.dot, { backgroundColor: colors.warning }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.bannerTitle} numberOfLines={1}>Resume "{resumable[0].session_name}"</Text>
                <Text style={styles.bannerNote}>Still in progress on this device — reconnect sensors to continue.</Text>
              </View>
              <Play size={18} color={colors.warning} />
            </Glass>
          </TouchableOpacity>
        ) : null}

        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl }}>
          <PillButton label="Start a session" onPress={() => navigation.navigate('Sessions')} style={{ flex: 1 }} />
          <PillButton variant="glass" label="Schedule" icon={<Plus size={14} color={colors.foreground} />} onPress={() => navigation.navigate('SessionSetup', { mode: 'schedule' })} />
        </View>

        <SectionTitle
          style={{ marginTop: spacing.xxl }}
          right={
            <TouchableOpacity style={styles.seeAll} onPress={() => navigation.navigate('Sessions')}>
              <Text style={styles.seeAllText}>See all</Text>
              <ChevronRight size={14} color={colors.primary} />
            </TouchableOpacity>
          }
        >
          Today's sessions
        </SectionTitle>

        {today.length === 0 ? (
          <TouchableOpacity onPress={() => navigation.navigate('SessionSetup', { mode: 'schedule' })}>
            <Glass tone="soft" style={styles.empty}>
              <CalendarClock size={20} color={colors.mutedForeground} />
              <Text style={styles.emptyText}>Nothing scheduled — tap to schedule one.</Text>
            </Glass>
          </TouchableOpacity>
        ) : (
          <View style={{ gap: spacing.sm }}>
            {today.slice(0, 6).map((s) => (
              <TouchableOpacity key={s.id} activeOpacity={0.85} onPress={() => navigation.navigate('SessionDetails', { sessionId: s.id })}>
                <Glass style={styles.sessionRow}>
                  <View style={styles.timeBox}>
                    <Text style={styles.timeText}>{timeLabel(s)}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.sessionName} numberOfLines={1}>{s.name}</Text>
                    <Text style={styles.sessionMeta} numberOfLines={1}>{s._count?.members ?? 0}/{s.capacity} members</Text>
                  </View>
                  <View style={[styles.status, s.status === 'in_progress' && { backgroundColor: 'rgba(251,80,97,0.16)' }]}>
                    <Text style={[styles.statusText, s.status === 'in_progress' && { color: colors.primary }]}>
                      {s.status === 'in_progress' ? 'LIVE' : s.status === 'scheduled' ? 'UPCOMING' : s.status.toUpperCase()}
                    </Text>
                  </View>
                </Glass>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: 130 },
  ringValue: { fontFamily: fonts.metricBold, fontSize: 52, color: colors.foreground },
  ringTotal: { fontSize: 22, color: colors.mutedForeground },
  row: { flexDirection: 'row', gap: spacing.sm },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing.md },
  errorText: { fontFamily: fonts.body, fontSize: 12, color: colors.warning, flex: 1 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, marginTop: spacing.lg },
  dot: { width: 8, height: 8, borderRadius: 4 },
  bannerTitle: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.foreground },
  bannerNote: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 2 },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  seeAllText: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.primary },
  empty: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  emptyText: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground, flex: 1 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
  timeBox: { backgroundColor: colors.glassStrong, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8, minWidth: 68, alignItems: 'center' },
  timeText: { fontFamily: fonts.metric, fontSize: 12, color: colors.foreground },
  sessionName: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.foreground },
  sessionMeta: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 2 },
  status: { backgroundColor: colors.glassStrong, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  statusText: { fontFamily: fonts.bodySemiBold, fontSize: 9, letterSpacing: 1, color: colors.mutedForeground },
});
