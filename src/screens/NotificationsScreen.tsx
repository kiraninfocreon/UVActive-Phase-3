import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Bell, CheckCheck } from 'lucide-react-native';
import { colors, fonts, spacing } from '../theme/tokens';
import { Screen } from '../components/Screen';
import { Glass } from '../components/uv/Glass';
import { EmptyState } from '../components/EmptyState';
import { memberApi, type AppNotification } from '../services/memberApi';

function ago(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - +new Date(iso)) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

export function NotificationsScreen() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setItems((await memberApi.notifications()) ?? []); } catch { /* keep last */ } finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const unread = items.filter((n) => !n.readAt).length;

  const open = async (n: AppNotification) => {
    if (n.readAt) return;
    setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
    memberApi.markRead(n.id).catch(() => {});
  };
  const readAll = async () => {
    setItems((cur) => cur.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    memberApi.markAllRead().catch(() => load());
  };

  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.heading}>Notifications</Text>
          <Text style={styles.sub}>{unread ? `${unread} unread` : 'You’re all caught up'}</Text>
        </View>
        {unread > 0 && (
          <TouchableOpacity onPress={readAll} style={styles.readAll} activeOpacity={0.8}>
            <CheckCheck size={14} color={colors.primary} /><Text style={styles.readAllText}>Mark all read</Text>
          </TouchableOpacity>
        )}
      </View>
      {loading ? <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} /> : (
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingBottom: 130, gap: spacing.sm }}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
          ListEmptyComponent={<EmptyState icon={Bell} title="No notifications" subtitle="Session reminders and results will show up here." />}
          renderItem={({ item }) => (
            <TouchableOpacity activeOpacity={0.85} onPress={() => open(item)}>
              <Glass tone={item.readAt ? 'soft' : 'default'} style={styles.card}>
                {!item.readAt && <View style={styles.dot} />}
                <View style={{ flex: 1 }}>
                  {item.title ? <Text style={styles.title}>{item.title}</Text> : null}
                  <Text style={styles.body}>{item.body}</Text>
                </View>
                <Text style={styles.time}>{ago(item.createdAt)}</Text>
              </Glass>
            </TouchableOpacity>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.lg },
  heading: { fontFamily: fonts.heading, fontSize: 30, letterSpacing: -0.5, color: colors.foreground },
  sub: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 2 },
  readAll: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(251,80,97,0.12)', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  readAllText: { fontFamily: fonts.bodySemiBold, fontSize: 11, color: colors.primary },
  card: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, padding: spacing.lg },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary, marginTop: 6 },
  title: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.foreground, marginBottom: 3 },
  body: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: colors.secondaryForeground },
  time: { fontFamily: fonts.metric, fontSize: 11, color: colors.mutedForeground },
});
