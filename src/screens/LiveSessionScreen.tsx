import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ScrollView, useWindowDimensions, Modal, TouchableOpacity, Alert, BackHandler, ActivityIndicator, TextInput, Linking, Platform } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useKeepAwake } from 'expo-keep-awake';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { X, Plus, Radio, UserX, Search, Cast, LogOut } from 'lucide-react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { sessionEngine } from '../services/sessionEngine';
import type { LiveTick } from '../lib/formula-engine';
import { AthleteTile } from '../components/AthleteTile';
import { BpmLineGraph, type GraphPoint } from '../components/BpmLineGraph';
import { SessionControlBar } from '../components/SessionControlBar';
import { CountdownOverlay } from '../components/CountdownOverlay';
import { ConnectionStatus } from '../components/ConnectionStatus';
import { getTicksForMember, getSessionMembers } from '../db/database';
import { ZoneDistributionBar, ZoneTimeBreakdown, zoneSecondsToBuckets } from '../components/ZoneDistribution';
import { Screen } from '../components/Screen';
import { Glass } from '../components/uv/Glass';
import { PillButton } from '../components/uv/Ui';
import { membersApi, type RemoteMember } from '../services/sessionsApi';
import { startNearbyScan, registerNearbyDevice, type NearbyBLEDevice } from '../services/ble';
import { assignSensorToMember, addRegisteredSensor } from '../services/sensorRegistry';

const TILE_GAP = 8;
const MIN_TILE_WIDTH = 100;

type TileData = LiveTick & { needsSensor?: boolean };

export function LiveSessionScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'LiveSession'>>();
  const { width } = useWindowDimensions();

  const [showCountdown, setShowCountdown] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [breakActive, setBreakActive] = useState(false);
  const [ticks, setTicks] = useState<Map<string, LiveTick>>(new Map());
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [assignMemberId, setAssignMemberId] = useState<string | null>(null); // dead-block tap → assign/absent sheet
  const [showLateJoin, setShowLateJoin] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [castHelp, setCastHelp] = useState(false); // instruction overlay
  const [tvMode, setTvMode] = useState(false); // full-screen landscape grid
  useKeepAwake();

  // Cast to TV: rotate to landscape, show how to mirror the screen, then
  // present a no-scroll grid sized to fit every athlete. Always restore
  // portrait when leaving TV mode or the screen unmounts.
  const startCast = useCallback(async () => {
    try { await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE); } catch { /* best-effort */ }
    setCastHelp(true);
  }, []);
  const stopCast = useCallback(async () => {
    setCastHelp(false);
    setTvMode(false);
    try { await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); } catch { /* best-effort */ }
  }, []);
  useEffect(() => () => { ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {}); }, []);
  const openCastSettings = useCallback(() => {
    if (Platform.OS === 'android') {
      Linking.sendIntent('android.settings.CAST_SETTINGS').catch(() => Linking.openSettings().catch(() => {}));
    } else {
      Linking.openSettings().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const unsub = sessionEngine.addLiveListener(setTicks);
    return unsub;
  }, []);

  // Roster composition (who's in the session + who has a sensor) changes
  // independently of the tick stream — assign/late-join/mark-absent all
  // fire this listener so the grid re-renders immediately.
  const [rosterVersion, setRosterVersion] = useState(0);
  useEffect(() => sessionEngine.addRosterListener(() => setRosterVersion((v) => v + 1)), []);
  const roster = useMemo(() => sessionEngine.getMemberRoster(), [rosterVersion]);

  const confirmEnd = useCallback(() => {
    Alert.alert('End Session', 'This finalizes results for everyone and posts the leaderboard.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End Session',
        style: 'destructive',
        onPress: async () => {
          try {
            await sessionEngine.endSession();
            navigation.replace('SessionSummary', { sessionId: route.params.sessionId });
          } catch (e) {
            Alert.alert('Could not end session', e instanceof Error ? e.message : 'Try again.');
          }
        },
      },
    ]);
  }, [navigation, route.params.sessionId]);

  // A hardware back-button mid-session would otherwise strand the
  // session in a weird nav state — force it through the same "end or
  // stay" prompt as the End button, never a silent back-out.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      confirmEnd();
      return true;
    });
    return () => sub.remove();
  }, [confirmEnd]);

  // Elapsed timer — paused when the session is paused so the clock matches
  // actual training time, not wall-clock time.
  useEffect(() => {
    if (showCountdown || isPaused || breakActive) return;
    const t = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [showCountdown, isPaused, breakActive]);

  const columns = Math.max(2, Math.floor(width / (MIN_TILE_WIDTH + TILE_GAP)));
  const tileWidth = (width - spacing.lg * 2 - TILE_GAP * (columns - 1)) / columns;

  // Tiles are driven by the roster so status (active / away / left) is
  // always right. Ranked: scoring members by points, then members still
  // waiting for a signal, then away, then left (greyed at the bottom).
  const displayList = useMemo(() => {
    const entries = roster.map((m) => {
      const t = ticks.get(m.memberId);
      const base: TileData = t
        ? { ...t }
        : {
            memberId: m.memberId, memberName: m.memberName, currentBPM: 0, pctMHR: 0, currentZone: 0, zoneColour: colors.muted,
            sweatPointsSoFar: 0, timeInCurrentZone: 0, isPersonalBest: false, isDropped: true, rank: 0,
          };
      base.sex = base.sex ?? m.sex;
      base.memberStatus = m.status;
      base.needsSensor = m.status !== 'left' && !m.sensorDeviceId;
      return { tile: base, hasTick: !!t };
    });
    const group = (e: { tile: TileData; hasTick: boolean }) =>
      e.tile.memberStatus === 'left' ? 3 : e.tile.memberStatus === 'away' ? 2 : e.hasTick && !e.tile.needsSensor ? 0 : 1;
    entries.sort((a, b) => group(a) - group(b) || b.tile.sweatPointsSoFar - a.tile.sweatPointsSoFar);
    return { tiles: entries.map((e) => e.tile), liveCount: entries.filter((e) => group(e) === 0).length };
  }, [ticks, roster]);

  const onCountdownDone = useCallback(() => {
    sessionEngine.resume();
    setShowCountdown(false);
  }, []);

  const onCountdownCancel = useCallback(() => {
    sessionEngine.cancelSession('Cancelled before start').catch(() => {});
    navigation.goBack();
  }, [navigation]);

  const onPauseResume = () => {
    if (isPaused) { sessionEngine.resume(); setIsPaused(false); } else { sessionEngine.pause(); setIsPaused(true); }
  };
  const onBreak = () => { sessionEngine.pause(); setBreakActive(true); };
  const onBreakEnd = () => { sessionEngine.resume(); setBreakActive(false); };

  const onTilePress = (memberId: string) => {
    const rosterEntry = roster.find((m) => m.memberId === memberId);
    if (rosterEntry && rosterEntry.status !== 'left' && !rosterEntry.sensorDeviceId) {
      setAssignMemberId(memberId); // dead block — open assign/absent sheet, not the stats modal
    } else {
      setSelectedMemberId(memberId);
    }
  };

  const allTiles: TileData[] = displayList.tiles;
  const assignTarget = assignMemberId ? roster.find((m) => m.memberId === assignMemberId) : null;

  return (
    <Screen edges={['top', 'bottom']}>
    <View style={styles.root}>
      {showCountdown && <CountdownOverlay onDone={onCountdownDone} onCancel={onCountdownCancel} />}

      <View style={styles.header}>
        <View>
          <Text style={styles.timer}>{formatElapsed(elapsedSeconds)}</Text>
          <Text style={styles.athleteCount}>
            {displayList.liveCount}/{roster.length} connected{isPaused ? ' · paused' : breakActive ? ' · break' : ''}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.castButton} onPress={startCast} hitSlop={8} accessibilityLabel="Cast to TV">
            <Cast size={16} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.lateJoinButton} onPress={() => setShowLateJoin(true)} hitSlop={8}>
            <Plus size={18} color={colors.primaryForeground} />
          </TouchableOpacity>
          <ConnectionStatus />
        </View>
      </View>

      <FlatList
        data={allTiles}
        keyExtractor={(item) => item.memberId}
        numColumns={columns}
        key={columns} // force re-layout if orientation/column-count changes
        contentContainerStyle={styles.grid}
        columnWrapperStyle={{ gap: TILE_GAP, marginBottom: TILE_GAP }}
        renderItem={({ item, index }) => (
          <AthleteTile
            tick={item}
            rank={index + 1}
            tileWidth={tileWidth}
            onPress={onTilePress}
            preSession={item.isDropped && item.currentBPM === 0 && item.memberStatus === 'active' && !item.needsSensor}
            needsSensor={item.needsSensor}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No members in this session — tap + to add one.</Text>
          </View>
        }
      />

      <SessionControlBar
        isActive
        isPaused={isPaused}
        breakActive={breakActive}
        onStart={() => {}}
        onEnd={confirmEnd}
        onPauseResume={onPauseResume}
        onBreak={onBreak}
        onBreakEnd={onBreakEnd}
      />

      {selectedMemberId && (
        <AthleteDetailModal
          sessionId={route.params.sessionId}
          memberId={selectedMemberId}
          tick={ticks.get(selectedMemberId) ?? null}
          status={roster.find((m) => m.memberId === selectedMemberId)?.status ?? 'active'}
          onClose={() => setSelectedMemberId(null)}
          onRejoin={() => { const id = selectedMemberId; setSelectedMemberId(null); setAssignMemberId(id); }}
        />
      )}

      {assignTarget && (
        <AssignSensorSheet
          rejoin={assignTarget.status === 'left'}
          memberId={assignTarget.memberId}
          memberName={assignTarget.memberName}
          onClose={() => setAssignMemberId(null)}
        />
      )}

      {castHelp && <CastHelpOverlay onClose={stopCast} onOpenSettings={openCastSettings} onReady={() => { setCastHelp(false); setTvMode(true); }} />}
      {tvMode && (
        <TvGrid tiles={allTiles} elapsed={formatElapsed(elapsedSeconds)} liveCount={displayList.liveCount} total={roster.length} paused={isPaused || breakActive} onExit={stopCast} />
      )}

      {showLateJoin && (
        <LateJoinSheet
          existingMemberIds={new Set(roster.map((m) => m.memberId))}
          onClose={() => setShowLateJoin(false)}
        />
      )}
    </View>
    </Screen>
  );
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function AthleteDetailModal({ sessionId, memberId, tick, status, onClose, onRejoin }: { sessionId: string; memberId: string; tick: LiveTick | null; status: 'active' | 'away' | 'left'; onClose: () => void; onRejoin: () => void }) {
  const [points, setPoints] = useState<GraphPoint[]>([]);
  const [zoneSeconds, setZoneSeconds] = useState<number[] | Record<string, number> | null>(null);
  const [memberStats, setMemberStats] = useState<{ avgHr: number | null; peakHr: number | null; calories: number | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getTicksForMember(sessionId, memberId)
        .then((rows) => {
          if (!cancelled) setPoints(rows.map((r) => ({ value: r.bpm })));
        })
        .catch((e) => console.warn('[AthleteDetailModal] Failed to load ticks', e));
      getSessionMembers(sessionId)
        .then((members) => {
          if (cancelled) return;
          const row = (members as unknown as { member_id: string; avg_hr: number | null; peak_hr: number | null; calories: number | null; zone_seconds_json: string | null }[])
            .find((m) => m.member_id === memberId);
          if (row) {
            setMemberStats({ avgHr: row.avg_hr, peakHr: row.peak_hr, calories: row.calories });
            if (row.zone_seconds_json) {
              try { setZoneSeconds(JSON.parse(row.zone_seconds_json)); } catch { /* ignore */ }
            }
          }
        })
        .catch(() => {}); // best-effort for zone data
    };
    load();
    const t = setInterval(load, 2000); // live-refresh while the modal is open
    return () => { cancelled = true; clearInterval(t); };
  }, [sessionId, memberId]);

  const buckets = zoneSecondsToBuckets(zoneSeconds);

  return (
    <Modal animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <ScrollView contentContainerStyle={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{tick?.memberName ?? 'Athlete'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {tick && tick.currentBPM > 0 && (
            <View style={styles.modalStatsRow}>
              <ModalStat label="BPM" value={String(tick.currentBPM)} />
              <ModalStat label="%MHR" value={`${Math.round(tick.pctMHR)}%`} />
              <ModalStat label="UV Points" value={String(Math.round(tick.sweatPointsSoFar))} />
            </View>
          )}

          {memberStats && (
            <View style={styles.modalStatsRow}>
              <ModalStat label="Avg BPM" value={memberStats.avgHr != null ? String(Math.round(memberStats.avgHr)) : '—'} />
              <ModalStat label="Peak BPM" value={memberStats.peakHr != null ? String(Math.round(memberStats.peakHr)) : '—'} />
              <ModalStat label="Calories" value={memberStats.calories != null ? `${Math.round(memberStats.calories)} kcal` : '—'} />
            </View>
          )}

          {status === 'left' ? (
            <PillButton label="Rejoin with a sensor" onPress={onRejoin} style={{ marginBottom: spacing.md }} />
          ) : (
            <PillButton
              variant="danger"
              label="Member left the session"
              icon={<LogOut size={15} color={colors.destructive} />}
              style={{ marginBottom: spacing.md }}
              onPress={() =>
                Alert.alert('Member left?', 'Their result is kept and scoring stops. The strap is released so it can\'t add spikes. You can rejoin them later.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Mark as left', style: 'destructive', onPress: () => { sessionEngine.markLeft(memberId).catch(() => {}); onClose(); } },
                ])
              }
            />
          )}

          <BpmLineGraph points={points} height={160} emptyLabel={tick && tick.currentBPM === 0 ? 'Waiting for readings…' : 'No readings recorded yet.'} />

          {/* Zone distribution bar + breakdown */}
          {buckets.some((b) => b.seconds > 0) && (
            <View style={styles.modalZoneBlock}>
              <Text style={styles.modalZoneTitle}>Zone Distribution</Text>
              <ZoneDistributionBar buckets={buckets} height={14} />
              <ZoneTimeBreakdown buckets={buckets} />
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function ModalStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.modalStat}>
      <Text style={styles.modalStatValue}>{value}</Text>
      <Text style={styles.modalStatLabel}>{label}</Text>
    </View>
  );
}

/**
 * Tap-a-dead-block sheet — this IS the sensor-assignment flow, live,
 * inline in the session. There's no separate "assign sensor" screen:
 * scan for nearby BLE sensors, tap one to assign, or mark the member
 * absent to pull their block off the grid entirely.
 */
function AssignSensorSheet({ memberId, memberName, onClose, rejoin = false }: { memberId: string; memberName: string; onClose: () => void; rejoin?: boolean }) {
  const [nearby, setNearby] = useState<NearbyBLEDevice[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    startNearbyScan(setNearby)
      .then((s) => { stop = s; })
      .catch((e) => setScanError(e instanceof Error ? e.message : 'Could not start Bluetooth scan.'));
    return () => stop?.();
  }, []);

  const assign = async (device: NearbyBLEDevice) => {
    setConnecting(device.id);
    try {
      const deviceId = await registerNearbyDevice(device);
      sessionEngine.assignSensor(memberId, deviceId);
      assignSensorToMember(memberId, deviceId).catch(() => {});
      addRegisteredSensor(deviceId).catch(() => {});
      onClose();
    } catch {
      Alert.alert('Could not connect', `Failed to connect to ${device.name}. Try again.`);
    } finally {
      setConnecting(null);
    }
  };

  const markAbsent = () => {
    Alert.alert('Mark Absent', `Mark ${memberName} as absent for this session?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Mark Absent',
        style: 'destructive',
        onPress: () => {
          sessionEngine.markAbsent(memberId).catch(() => {});
          onClose();
        },
      },
    ]);
  };

  return (
    <Modal animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{rejoin ? `Rejoin · ${memberName}` : memberName}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <Text style={styles.sheetNote}>{rejoin ? 'Pick a nearby sensor to bring them back. Scoring resumes from now; time away is not counted.' : 'Tap a nearby sensor to assign it, or mark them absent to remove their block.'}</Text>

          {scanError && <Text style={styles.sheetError}>{scanError}</Text>}
          {!scanError && nearby.length === 0 && (
            <View style={styles.sheetEmptyWrap}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.sheetEmpty}>Scanning for nearby Polar sensors…</Text>
            </View>
          )}

          <FlatList
            data={nearby}
            keyExtractor={(d) => d.id}
            style={{ maxHeight: 220 }}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.deviceRow} onPress={() => assign(item)} disabled={connecting === item.id}>
                <Radio size={16} color={colors.primary} />
                <Text style={styles.deviceName}>{item.name}</Text>
                {connecting === item.id ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={styles.deviceRssi}>{item.rssi ?? '—'} dBm</Text>}
              </TouchableOpacity>
            )}
          />

          {!rejoin && (
            <TouchableOpacity style={styles.absentButton} onPress={markAbsent}>
              <UserX size={16} color={colors.destructive} />
              <Text style={styles.absentButtonText}>Mark Absent</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

/**
 * "+" header button — a late-joiner picks themselves from the gym
 * roster, enters as a dead block, and the trainer taps that block to
 * assign a sensor. No separate flow needed beyond what's already here.
 */
function LateJoinSheet({ existingMemberIds, onClose }: { existingMemberIds: Set<string>; onClose: () => void }) {
  const [members, setMembers] = useState<RemoteMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    membersApi.list()
      .then(setMembers)
      .catch(() => Alert.alert('Could not load', 'Failed to load the member list — check your connection.'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const notInSession = members.filter((m) => !existingMemberIds.has(m.id));
    const q = search.trim().toLowerCase();
    if (!q) return notInSession;
    return notInSession.filter((m) => m.name.toLowerCase().includes(q) || m.memberCode.toLowerCase().includes(q));
  }, [members, existingMemberIds, search]);

  const addMember = async (member: RemoteMember) => {
    setAdding(member.id);
    try {
      await sessionEngine.addLateMember(member);
      onClose();
    } catch {
      Alert.alert('Could not add member', 'Try again.');
    } finally {
      setAdding(null);
    }
  };

  return (
    <Modal animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Add Late Joiner</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

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
            <ActivityIndicator style={{ marginTop: spacing.lg }} color={colors.primary} />
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(m) => m.id}
              style={{ maxHeight: 320 }}
              ListEmptyComponent={<Text style={styles.sheetEmpty}>No matching members.</Text>}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.deviceRow} onPress={() => addMember(item)} disabled={adding === item.id}>
                  <Text style={styles.deviceName}>{item.name}</Text>
                  {adding === item.id ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={styles.deviceRssi}>{item.memberCode}</Text>}
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

/** Step 1 of casting: landscape is already locked; tell the trainer how to mirror. */
function CastHelpOverlay({ onClose, onOpenSettings, onReady }: { onClose: () => void; onOpenSettings: () => void; onReady: () => void }) {
  const steps = Platform.OS === 'ios'
    ? ['Swipe down from the top-right corner to open Control Center.', 'Tap Screen Mirroring and pick your TV or Apple TV.', 'Come back here and tap "Show on TV".']
    : ['Make sure the phone and the TV (or Chromecast) are on the same Wi-Fi.', 'Tap "Open cast settings" and choose your TV from the list.', 'Come back here and tap "Show on TV".'];
  return (
    <View style={styles.castBackdrop}>
      <Glass tone="strong" style={styles.castCard}>
        <Text style={styles.castTitle}>Cast to TV</Text>
        <Text style={styles.castSub}>Your screen is now landscape. Mirror it to a TV so members can see their zones.</Text>
        {steps.map((t, i) => (
          <View key={i} style={styles.castStep}>
            <View style={styles.castNum}><Text style={styles.castNumText}>{i + 1}</Text></View>
            <Text style={styles.castStepText}>{t}</Text>
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' }}>
          <PillButton variant="glass" label={Platform.OS === 'android' ? 'Open cast settings' : 'Open settings'} onPress={onOpenSettings} />
          <PillButton label="Show on TV" onPress={onReady} />
          <PillButton variant="glass" label="Cancel" onPress={onClose} />
        </View>
      </Glass>
    </View>
  );
}

const ZONE_LEGEND: { z: 0 | 1 | 2 | 3 | 4 | 5; n: string }[] = [
  { z: 0, n: 'Standby' }, { z: 1, n: 'Recovery' }, { z: 2, n: 'Aerobic' }, { z: 3, n: 'Fitness' }, { z: 4, n: 'Burn' }, { z: 5, n: 'Peak' },
];

/** Full-screen landscape grid for the TV: every tile fits, no scrolling. */
function TvGrid({ tiles, elapsed, liveCount, total, paused, onExit }: { tiles: TileData[]; elapsed: string; liveCount: number; total: number; paused: boolean; onExit: () => void }) {
  const { width, height } = useWindowDimensions();
  const GAP = 6;
  const HEADER = 44;
  const FOOTER = 26;
  const n = Math.max(1, tiles.length);
  const availW = width - GAP * 2;
  const availH = height - HEADER - FOOTER - GAP * 2;
  // pick the column count that gives the largest tile area
  let best = { cols: 1, w: 0, h: 0, area: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = (availW - GAP * (cols - 1)) / cols;
    const h = (availH - GAP * (rows - 1)) / rows;
    const area = Math.min(w, h * 1.6) * Math.min(h, w / 1.1);
    if (area > best.area) best = { cols, w, h, area };
  }
  return (
    <Modal animationType="fade" supportedOrientations={['landscape', 'landscape-left', 'landscape-right']} onRequestClose={onExit}>
      <View style={{ flex: 1, backgroundColor: '#000', padding: GAP }}>
        <View style={{ height: HEADER, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6 }}>
          <Text style={styles.tvTimer}>{elapsed}{paused ? '  · PAUSED' : ''}</Text>
          <Text style={styles.tvCount}>{liveCount}/{total} connected</Text>
          <TouchableOpacity onPress={onExit} hitSlop={10} style={styles.tvExit}><X size={16} color="#fff" /><Text style={styles.tvExitText}>Exit TV</Text></TouchableOpacity>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GAP, flex: 1, alignContent: 'flex-start' }}>
          {tiles.map((t, i) => (
            <AthleteTile key={t.memberId} tick={t} rank={i + 1} tileWidth={best.w} tileHeight={best.h} tv onPress={() => {}}
              preSession={t.isDropped && t.currentBPM === 0 && t.memberStatus === 'active' && !t.needsSensor} needsSensor={t.needsSensor} />
          ))}
        </View>
        <View style={{ height: FOOTER, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
          {ZONE_LEGEND.map((l) => (
            <View key={l.z} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: colors.zone[l.z] }} />
              <Text style={styles.tvLegend}>{l.n}</Text>
            </View>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  castButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.glassBorder, alignItems: 'center', justifyContent: 'center' },
  castBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  castCard: { padding: spacing.xl, maxWidth: 560, width: '100%' },
  castTitle: { fontFamily: fonts.heading, fontSize: 22, color: colors.foreground },
  castSub: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground, marginTop: 6, marginBottom: spacing.md },
  castStep: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginTop: spacing.sm },
  castNum: { width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(251,80,97,0.18)', alignItems: 'center', justifyContent: 'center' },
  castNumText: { fontFamily: fonts.metricBold, fontSize: 11, color: colors.primary },
  castStepText: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.foreground, lineHeight: 19 },
  tvTimer: { fontFamily: fonts.metricBold, fontSize: 22, color: '#fff' },
  tvCount: { fontFamily: fonts.metric, fontSize: 13, color: 'rgba(255,255,255,0.6)' },
  tvExit: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  tvExitText: { fontFamily: fonts.bodySemiBold, fontSize: 12, color: '#fff' },
  tvLegend: { fontFamily: fonts.bodyMedium, fontSize: 10, color: 'rgba(255,255,255,0.65)' },
  root: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.lg, paddingBottom: spacing.sm },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  lateJoinButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  timer: { fontFamily: fonts.heading, fontSize: 26, color: colors.foreground },
  athleteCount: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground },
  grid: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  empty: { paddingTop: spacing.xxl, alignItems: 'center' },
  emptyText: { fontFamily: fonts.body, color: colors.mutedForeground },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: colors.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: spacing.lg, paddingBottom: spacing.xxl },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  modalTitle: { fontFamily: fonts.heading, fontSize: 18, color: colors.foreground },
  modalStatsRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  modalStat: { flex: 1, backgroundColor: colors.background, borderRadius: radius.md, padding: spacing.sm, alignItems: 'center' },
  modalStatValue: { fontFamily: fonts.heading, fontSize: 20, color: colors.primary },
  modalStatLabel: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, marginTop: 2 },
  modalZoneBlock: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, gap: spacing.sm, marginTop: spacing.md },
  modalZoneTitle: { fontFamily: fonts.bodyMedium, fontSize: 11, color: colors.mutedForeground },
  sheetNote: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginBottom: spacing.md },
  sheetError: { fontFamily: fonts.body, fontSize: 12, color: colors.destructive, marginBottom: spacing.sm },
  sheetEmptyWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },
  sheetEmpty: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground, textAlign: 'center', paddingVertical: spacing.md },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  deviceName: { fontFamily: fonts.bodyMedium, fontSize: 14, color: colors.foreground, flex: 1 },
  deviceRssi: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground },
  absentButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    borderWidth: 1, borderColor: colors.destructive, borderRadius: radius.md, paddingVertical: spacing.md, marginTop: spacing.md,
  },
  absentButtonText: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.destructive },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: spacing.md, marginBottom: spacing.md,
  },
  searchInput: { flex: 1, paddingVertical: spacing.sm, fontFamily: fonts.body, fontSize: 14, color: colors.foreground },
});
