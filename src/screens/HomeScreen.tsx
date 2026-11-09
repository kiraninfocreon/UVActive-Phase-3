import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { ChevronRight, Flame, Zap } from 'lucide-react-native';
import { colors, fonts, spacing } from '../theme/tokens';
import { Screen } from '../components/Screen';
import { Glass } from '../components/uv/Glass';
import { RadialRing } from '../components/uv/RadialRing';
import { Greeting, MetricCard, SectionTitle, MetricLabel, PillButton } from '../components/uv/Ui';
import { useAuth } from '../hooks/useAuth';
import { memberApi, type Workout, type AvailableSession } from '../services/memberApi';
import { isDone, pts, when, fmtDate } from '../lib/format';
import type { RootStackParamList } from '../navigation/RootNavigator';

export function HomeScreen() {
  const { member } = useAuth();
  const nav = useNavigation<StackNavigationProp<RootStackParamList>>();
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [booked, setBooked] = useState<AvailableSession[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, a] = await Promise.all([memberApi.workouts(), memberApi.available().catch(() => [] as AvailableSession[])]);
      setWorkouts(w ?? []);
      setBooked((a ?? []).filter((s) => s.isBooked).sort((x, y) => +new Date(x.scheduledAt) - +new Date(y.scheduledAt)));
      setError(false);
    } catch { setError(true); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const done = useMemo(() => workouts.filter(isDone).sort((a, b) => +new Date(when(b) ?? 0) - +new Date(when(a) ?? 0)), [workouts]);
  const weekAgo = Date.now() - 7 * 86400000;
  const week = done.filter((w) => +new Date(when(w) ?? 0) >= weekAgo);
  const activeDays = new Set(week.map((w) => new Date(when(w)!).toDateString())).size;
  const totalPts = done.reduce((s, w) => s + pts(w), 0);
  const kcal = week.reduce((s, w) => s + (w.calories ?? 0), 0);
  const avgHr = done.length ? Math.round(done.reduce((s, w) => s + (w.avgHr ?? 0), 0) / done.filter((w) => w.avgHr).length || 0) : 0;
  const last = done[0];
  const next = booked[0];

  return (
    <Screen edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      >
        <Greeting
          name={member?.name?.split(' ')[0]}
          title={<>{week.length ? 'Keep it going.' : 'Ready when you are.'}</>}
          detail={week.length ? `${week.length} workout${week.length === 1 ? '' : 's'} in the last 7 days.` : 'Book a session and your results will show up here.'}
        />

        <View style={{ alignItems: 'center', marginVertical: spacing.xl }}>
          <RadialRing size={210} thickness={12} segments={[{ value: activeDays / 7, color: colors.primary }]}>
            <Text style={styles.ringValue}>{activeDays}<Text style={styles.ringTotal}>/7</Text></Text>
            <MetricLabel style={{ marginTop: 6 }}>Active days this week</MetricLabel>
          </RadialRing>
        </View>

        <View style={styles.row}>
          <MetricCard value={totalPts} label="UV points" accent="primary" />
          <MetricCard value={Math.round(kcal)} label="Kcal · 7d" accent="recovery" />
          <MetricCard value={avgHr || '—'} label="Avg BPM" />
        </View>

        {error && <Text style={styles.error}>Couldn't refresh — pull down to retry.</Text>}

        <SectionTitle style={{ marginTop: spacing.xxl }}>Next session</SectionTitle>
        {next ? (
          <Glass style={styles.card}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{next.name}</Text>
              <Text style={styles.cardMeta}>{fmtDate(next.scheduledAt)}{next.trainer?.name ? ` · ${next.trainer.name}` : ''}</Text>
            </View>
            <View style={styles.booked}><Text style={styles.bookedText}>BOOKED</Text></View>
          </Glass>
        ) : (
          <Glass tone="soft" style={styles.card}>
            <Text style={[styles.cardMeta, { flex: 1 }]}>No session booked yet.</Text>
            <PillButton label="Book one" onPress={() => nav.navigate('Main', { screen: 'Workout' } as never)} />
          </Glass>
        )}

        <SectionTitle style={{ marginTop: spacing.xxl }}>Latest workout</SectionTitle>
        {last ? (
          <TouchableOpacity activeOpacity={0.85} onPress={() => nav.navigate('WorkoutDetail', { sessionId: last.sessionId })}>
            <Glass style={[styles.card, { flexDirection: 'column', alignItems: 'stretch', gap: spacing.md }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{last.session.name}</Text>
                  <Text style={styles.cardMeta}>{fmtDate(when(last))}</Text>
                </View>
                <ChevronRight size={18} color={colors.mutedForeground} />
              </View>
              <View style={{ flexDirection: 'row', gap: spacing.xl }}>
                <Stat icon={<Zap size={13} color={colors.primary} />} value={pts(last)} label="pts" />
                <Stat icon={<Flame size={13} color={colors.recovery} />} value={Math.round(last.calories ?? 0)} label="kcal" />
                <Stat value={last.avgHr ? Math.round(last.avgHr) : '—'} label="avg bpm" />
                {last.finalRank ? <Stat value={`#${last.finalRank}`} label="rank" /> : null}
              </View>
            </Glass>
          </TouchableOpacity>
        ) : (
          <Glass tone="soft" style={styles.card}><Text style={styles.cardMeta}>Your first completed workout will appear here.</Text></Glass>
        )}
      </ScrollView>
    </Screen>
  );
}

function Stat({ icon, value, label }: { icon?: React.ReactNode; value: number | string; label: string }) {
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>{icon}<Text style={styles.statVal}>{value}</Text></View>
      <MetricLabel style={{ marginTop: 3 }}>{label}</MetricLabel>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: 130 },
  ringValue: { fontFamily: fonts.metricBold, fontSize: 52, color: colors.foreground },
  ringTotal: { fontSize: 22, color: colors.mutedForeground },
  row: { flexDirection: 'row', gap: spacing.sm },
  error: { fontFamily: fonts.body, fontSize: 12, color: colors.warning, marginTop: spacing.md },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  cardTitle: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.foreground },
  cardMeta: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 3 },
  booked: { backgroundColor: 'rgba(102,214,192,0.14)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  bookedText: { fontFamily: fonts.bodySemiBold, fontSize: 9, letterSpacing: 1, color: colors.recovery },
  statVal: { fontFamily: fonts.metricBold, fontSize: 18, color: colors.foreground },
});
