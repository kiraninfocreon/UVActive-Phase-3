import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, ActivityIndicator, RefreshControl, useWindowDimensions } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { Search, ChevronRight, Users, AlertCircle, RefreshCw, Radio } from 'lucide-react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { membersApi, type RemoteMember } from '../services/sessionsApi';
import { ApiError } from '../services/api';
import { getSensorAssignments } from '../services/sensorRegistry';
import { Screen } from '../components/Screen';
import { Avatar } from '../components/uv/Avatar';

export function MembersScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const [members, setMembers] = useState<RemoteMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const { width } = useWindowDimensions();
  const wide = width >= 700;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      membersApi.list(),
      getSensorAssignments().catch(() => ({} as Record<string, string>)),
    ])
      .then(([m, a]) => { setMembers(m); setAssignments(a); })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load members — check your connection.'))
      .finally(() => setLoading(false));
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.name.toLowerCase().includes(q) || m.memberCode.toLowerCase().includes(q));
  }, [members, search]);

  return (
    <Screen edges={['top']}>
    <View style={styles.root}>
      <Text style={styles.heading}>Members</Text>

      <View style={styles.searchRow}>
        <Search size={16} color={colors.mutedForeground} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search members…"
          placeholderTextColor={colors.mutedForeground}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.primary} />
      ) : error ? (
        <View style={styles.empty}>
          <AlertCircle size={32} color={colors.destructive} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={load}>
            <RefreshCw size={14} color={colors.primaryForeground} />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(m) => m.id}
          contentContainerStyle={[styles.list, wide && styles.list2]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Users size={32} color={colors.mutedForeground} />
              <Text style={styles.emptyText}>{search ? 'No members match your search' : 'No members registered at your gym yet'}</Text>
            </View>
          }
          renderItem={({ item }) => {
            const hasSensor = !!assignments[item.id];
            return (
              <TouchableOpacity
                style={[styles.row, wide && styles.rowWide]}
                onPress={() => navigation.navigate('AthleteDetail', { memberId: item.id })}
              >
                <Avatar sex={item.sex} seed={item.id} size={44} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.code}>{item.memberCode}</Text>
                </View>
                {hasSensor && (
                  <View style={styles.sensorBadge}>
                    <Radio size={10} color={colors.success} />
                    <Text style={styles.sensorBadgeText}>Sensor</Text>
                  </View>
                )}
                <ChevronRight size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: spacing.xl },
  heading: { fontFamily: fonts.heading, fontSize: 30, letterSpacing: -0.5, color: colors.foreground, marginBottom: spacing.lg },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder,
    borderRadius: radius.full, paddingHorizontal: spacing.lg, marginBottom: spacing.lg,
  },
  searchInput: { flex: 1, paddingVertical: spacing.sm, fontFamily: fonts.body, fontSize: 14, color: colors.foreground },
  list: { paddingBottom: 130 },
  list2: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  empty: { alignItems: 'center', paddingTop: spacing.xxl, gap: spacing.sm, paddingHorizontal: spacing.xl },
  emptyText: { fontFamily: fonts.body, color: colors.mutedForeground, textAlign: 'center' },
  errorText: { fontFamily: fonts.body, color: colors.destructive, textAlign: 'center', fontSize: 13 },
  retryButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginTop: spacing.xs },
  retryText: { fontFamily: fonts.bodySemiBold, color: colors.primaryForeground, fontSize: 13 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder,
    borderRadius: radius.xl, padding: spacing.md, marginBottom: spacing.sm,
  },
  rowWide: { width: '48.5%' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bodySemiBold, fontSize: 12, color: colors.foreground },
  name: { fontFamily: fonts.bodyMedium, fontSize: 14, color: colors.foreground },
  code: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 1 },
  sensorBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.success + '1A', borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  sensorBadgeText: { fontFamily: fonts.bodySemiBold, fontSize: 9, color: colors.success },
});
