import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { ChevronLeft, ChevronRight, CalendarPlus } from 'lucide-react-native';
import { colors, fonts, spacing } from '../theme/tokens';
import { Screen } from '../components/Screen';
import { Glass } from '../components/uv/Glass';
import { PillButton, UnderlineTabs, MetricLabel } from '../components/uv/Ui';
import { EmptyState } from '../components/EmptyState';
import { memberApi, type Workout, type AvailableSession } from '../services/memberApi';
import { dayKey, fmtDate, isDone, pts, when } from '../lib/format';
import { ApiError } from '../services/api';
import type { RootStackParamList } from '../navigation/RootNavigator';

type Tab = 'calendar' | 'book';
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function WorkoutScreen() {
  const nav = useNavigation<StackNavigationProp<RootStackParamList>>();
  const [tab, setTab] = useState<Tab>('calendar');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [available, setAvailable] = useState<AvailableSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [selected, setSelected] = useState(() => dayKey(new Date()));

  const load = useCallback(async () => {
    const [w, a] = await Promise.all([memberApi.workouts().catch(() => null), memberApi.available().catch(() => null)]);
    if (w) setWorkouts(w);
    if (a) setAvailable(a);
    setLoading(false);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Everything that belongs on the calendar: finished workouts + booked upcoming sessions.
  const byDay = useMemo(() => {
    const m = new Map<string, { workouts: Workout[]; booked: AvailableSession[] }>();
    const slot = (k: string) => { if (!m.has(k)) m.set(k, { workouts: [], booked: [] }); return m.get(k)!; };
    for (const w of workouts) { const t = when(w); if (t && isDone(w)) slot(dayKey(new Date(t))).workouts.push(w); }
    for (const s of available) if (s.isBooked) slot(dayKey(new Date(s.scheduledAt))).booked.push(s);
    return m;
  }, [workouts, available]);

  const cells = useMemo(() => {
    const first = cursor.getDay();
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    return [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => new Date(cursor.getFullYear(), cursor.getMonth(), i + 1))] as (Date | null)[];
  }, [cursor]);

  const sel = byDay.get(selected);
  const todayKey = dayKey(new Date());

  const book = async (s: AvailableSession) => {
    setBusy(s.id);
    try { await memberApi.book(s.id); await load(); }
    catch (e) { Alert.alert('Could not book', e instanceof ApiError ? e.message : 'Try again.'); }
    finally { setBusy(null); }
  };
  const cancel = (s: AvailableSession) =>
    Alert.alert('Cancel booking?', `${s.name} · ${fmtDate(s.scheduledAt)}`, [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel booking', style: 'destructive', onPress: async () => {
        setBusy(s.id);
        try { await memberApi.cancelBooking(s.id); await load(); }
        catch (e) { Alert.alert('Could not cancel', e instanceof ApiError ? e.message : 'Try again.'); }
        finally { setBusy(null); }
      } },
    ]);

  const upcoming = [...available].sort((a, b) => +new Date(a.scheduledAt) - +new Date(b.scheduledAt));

  return (
    <Screen edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      >
        <Text style={styles.heading}>Workout</Text>
        <UnderlineTabs value={tab} onChange={setTab} tabs={[{ key: 'calendar', label: 'Calendar' }, { key: 'book', label: 'Book', badge: upcoming.filter((s) => !s.isBooked).length || undefined }]} />

        {loading ? <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} /> : tab === 'calendar' ? (
          <>
            <Glass style={{ padding: spacing.lg }}>
              <View style={styles.monthRow}>
                <TouchableOpacity hitSlop={10} onPress={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}><ChevronLeft size={20} color={colors.foreground} /></TouchableOpacity>
                <Text style={styles.month}>{cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
                <TouchableOpacity hitSlop={10} onPress={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}><ChevronRight size={20} color={colors.foreground} /></TouchableOpacity>
              </View>
              <View style={styles.grid}>
                {DOW.map((d, i) => <Text key={i} style={styles.dow}>{d}</Text>)}
                {cells.map((d, i) => {
                  if (!d) return <View key={i} style={styles.cell} />;
                  const k = dayKey(d); const info = byDay.get(k); const on = k === selected;
                  return (
                    <TouchableOpacity key={i} style={styles.cell} onPress={() => setSelected(k)} activeOpacity={0.8}>
                      <View style={[styles.day, on && styles.dayOn, k === todayKey && !on && styles.dayToday]}>
                        <Text style={[styles.dayText, on && { color: '#fff' }]}>{d.getDate()}</Text>
                      </View>
                      <View style={styles.dots}>
                        {info?.workouts.length ? <View style={[styles.dotMark, { backgroundColor: colors.primary }]} /> : null}
                        {info?.booked.length ? <View style={[styles.dotMark, { backgroundColor: colors.recovery }]} /> : null}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.legend}>
                <Legend color={colors.primary} text="Workout" /><Legend color={colors.recovery} text="Booked" />
              </View>
            </Glass>

            <MetricLabel style={{ marginTop: spacing.xl, marginBottom: spacing.md }}>{new Date(Number(selected.split('-')[0]), Number(selected.split('-')[1]), Number(selected.split('-')[2])).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</MetricLabel>
            {!sel || (!sel.workouts.length && !sel.booked.length) ? (
              <Glass tone="soft" style={styles.empty}><Text style={styles.meta}>Nothing on this day.</Text></Glass>
            ) : (
              <View style={{ gap: spacing.sm }}>
                {sel.workouts.map((w) => (
                  <TouchableOpacity key={w.id} activeOpacity={0.85} onPress={() => nav.navigate('WorkoutDetail', { sessionId: w.sessionId })}>
                    <Glass style={styles.item}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.itemTitle}>{w.session.name}</Text>
                        <Text style={styles.meta}>{pts(w)} pts · {Math.round(w.calories ?? 0)} kcal{w.avgHr ? ` · ${Math.round(w.avgHr)} bpm` : ''}</Text>
                      </View>
                      <ChevronRight size={18} color={colors.mutedForeground} />
                    </Glass>
                  </TouchableOpacity>
                ))}
                {sel.booked.map((s) => (
                  <Glass key={s.id} style={styles.item}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemTitle}>{s.name}</Text>
                      <Text style={styles.meta}>{fmtDate(s.scheduledAt)} · booked</Text>
                    </View>
                    <PillButton variant="glass" label="Cancel" disabled={busy === s.id} onPress={() => cancel(s)} />
                  </Glass>
                ))}
              </View>
            )}
          </>
        ) : upcoming.length === 0 ? (
          <EmptyState icon={CalendarPlus} title="No sessions to book" subtitle="Your gym hasn't scheduled upcoming sessions yet. Check back soon." />
        ) : (
          <View style={{ gap: spacing.sm }}>
            {upcoming.map((s) => (
              <Glass key={s.id} style={styles.item}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemTitle}>{s.name}</Text>
                  <Text style={styles.meta}>{fmtDate(s.scheduledAt)}{s.trainer?.name ? ` · ${s.trainer.name}` : ''}</Text>
                  <Text style={[styles.meta, { color: s.spotsOpen ? colors.recovery : colors.destructive }]}>{s.spotsOpen ? `${s.spotsOpen} spot${s.spotsOpen === 1 ? '' : 's'} open` : 'Full'}</Text>
                </View>
                {s.isBooked ? (
                  <PillButton variant="glass" label="Cancel" disabled={busy === s.id} onPress={() => cancel(s)} />
                ) : (
                  <PillButton label={busy === s.id ? '…' : 'Book'} disabled={busy === s.id || !s.spotsOpen} onPress={() => book(s)} />
                )}
              </Glass>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

function Legend({ color, text }: { color: string; text: string }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><View style={[styles.dotMark, { backgroundColor: color }]} /><Text style={styles.legendText}>{text}</Text></View>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: 130 },
  heading: { fontFamily: fonts.heading, fontSize: 30, letterSpacing: -0.5, color: colors.foreground, marginBottom: spacing.lg },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  month: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.foreground },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  dow: { width: '14.285%', textAlign: 'center', fontFamily: fonts.bodySemiBold, fontSize: 10, color: colors.mutedForeground, marginBottom: 6 },
  cell: { width: '14.285%', alignItems: 'center', paddingVertical: 3, minHeight: 46 },
  day: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  dayOn: { backgroundColor: colors.primary },
  dayToday: { borderWidth: 1, borderColor: colors.primary },
  dayText: { fontFamily: fonts.metric, fontSize: 13, color: colors.foreground },
  dots: { flexDirection: 'row', gap: 3, height: 6, marginTop: 2 },
  dotMark: { width: 5, height: 5, borderRadius: 3 },
  legend: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md, justifyContent: 'center' },
  legendText: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground },
  empty: { padding: spacing.lg },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  itemTitle: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.foreground },
  meta: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 3 },
});
