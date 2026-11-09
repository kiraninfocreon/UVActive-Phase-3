import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { ChevronLeft } from 'lucide-react-native';
import { colors, fonts, spacing } from '../theme/tokens';
import { Screen } from '../components/Screen';
import { Glass } from '../components/uv/Glass';
import { RadialRing } from '../components/uv/RadialRing';
import { MetricCard, SectionTitle, MetricLabel } from '../components/uv/Ui';
import { BpmLineGraph, type GraphPoint } from '../components/BpmLineGraph';
import { ZoneDistributionBar, ZoneTimeBreakdown, zoneSecondsToBuckets } from '../components/ZoneDistribution';
import { memberApi, type Workout } from '../services/memberApi';
import { fmtDate, pts, when } from '../lib/format';
import type { RootStackParamList } from '../navigation/RootNavigator';

export function WorkoutDetailScreen() {
  const nav = useNavigation();
  const { sessionId } = useRoute<RouteProp<RootStackParamList, 'WorkoutDetail'>>().params;
  const [w, setW] = useState<Workout | null>(null);
  const [points, setPoints] = useState<GraphPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let off = false;
    Promise.all([memberApi.workout(sessionId), memberApi.ticks(sessionId).catch(() => ({ ticks: [] }))])
      .then(([wo, t]) => {
        if (off) return;
        setW(wo);
        setPoints((t.ticks ?? []).map((x) => ({ value: x.bpm, zone: x.zone })));
      })
      .catch(() => !off && setError(true))
      .finally(() => !off && setLoading(false));
    return () => { off = true; };
  }, [sessionId]);

  // zoneMinutes is minutes per zone; the shared bar wants seconds.
  const buckets = zoneSecondsToBuckets(
    w?.zoneMinutes ? Object.fromEntries(Object.entries(w.zoneMinutes).map(([z, m]) => [z, (Number(m) || 0) * 60])) : null,
  );

  return (
    <Screen edges={['top']}>
      <View style={styles.top}>
        <TouchableOpacity onPress={() => nav.goBack()} hitSlop={12} style={styles.back}><ChevronLeft size={20} color={colors.foreground} /></TouchableOpacity>
        <Text style={styles.topTitle} numberOfLines={1}>{w?.session.name ?? 'Workout'}</Text>
      </View>
      {loading ? <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} /> : error || !w ? (
        <Text style={styles.err}>Couldn't load this workout.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text style={styles.when}>{fmtDate(when(w))}{w.session.trainer?.name ? ` · ${w.session.trainer.name}` : ''}</Text>

          <View style={{ alignItems: 'center', marginVertical: spacing.xl }}>
            <RadialRing size={190} thickness={11} value={Math.min(1, (w.avgPctMhr ?? 0) / 100)}>
              <Text style={styles.big}>{pts(w)}</Text>
              <MetricLabel style={{ marginTop: 4 }}>UV points</MetricLabel>
            </RadialRing>
            {w.finalRank ? <Text style={styles.rank}>Rank #{w.finalRank}{w.participantCount ? ` of ${w.participantCount}` : ''}</Text> : null}
          </View>

          <View style={styles.row}>
            <MetricCard value={Math.round(w.calories ?? 0)} label="Calories" unit="kcal" accent="primary" />
            <MetricCard value={w.avgHr ? Math.round(w.avgHr) : '—'} label="Avg BPM" />
            <MetricCard value={w.maxHr ? Math.round(w.maxHr) : '—'} label="Peak BPM" />
          </View>
          <View style={[styles.row, { marginTop: spacing.sm }]}>
            <MetricCard value={w.avgPctMhr ? Math.round(w.avgPctMhr) : '—'} unit="%" label="Avg %MHR" />
            <MetricCard value={w.epocCalories ? Math.round(w.epocCalories) : '—'} unit="kcal" label="Afterburn" accent="recovery" />
            <MetricCard value={w.recoveryGrade ?? '—'} label="Recovery" />
          </View>

          <SectionTitle style={{ marginTop: spacing.xxl }}>Heart rate</SectionTitle>
          <Glass style={{ padding: spacing.md }}>
            <BpmLineGraph points={points} height={170} emptyLabel="No heart-rate data for this workout." />
          </Glass>

          {buckets.some((b) => b.seconds > 0) && (
            <>
              <SectionTitle style={{ marginTop: spacing.xxl }}>Time in zones</SectionTitle>
              <Glass style={{ padding: spacing.lg, gap: spacing.md }}>
                <ZoneDistributionBar buckets={buckets} height={14} />
                <ZoneTimeBreakdown buckets={buckets} />
              </Glass>
            </>
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.glassStrong, alignItems: 'center', justifyContent: 'center' },
  topTitle: { flex: 1, fontFamily: fonts.heading, fontSize: 20, color: colors.foreground },
  content: { paddingHorizontal: spacing.xl, paddingBottom: 60 },
  when: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground },
  big: { fontFamily: fonts.metricBold, fontSize: 46, color: colors.foreground },
  rank: { fontFamily: fonts.metric, fontSize: 12, color: colors.primary, marginTop: spacing.md },
  row: { flexDirection: 'row', gap: spacing.sm },
  err: { fontFamily: fonts.body, color: colors.destructive, textAlign: 'center', marginTop: spacing.xl },
});
