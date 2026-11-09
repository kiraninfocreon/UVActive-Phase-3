import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, ActivityIndicator, Alert, ScrollView, useWindowDimensions,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { Search, Check, Radio, X, ChevronLeft, Users, BatteryMedium, AlertTriangle } from 'lucide-react-native';
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useAuth } from '../hooks/useAuth';
import {
  membersApi, sensorsApi, sessionsApi,
  type RemoteMember, type RemoteSensor, type RemoteSession,
} from '../services/sessionsApi';
import { getSession, getSessionMembers } from '../db/database';
import { ApiError } from '../services/api';
import { sessionEngine } from '../services/sessionEngine';
import { startNearbyScan, registerNearbyDevice, addGlobalBLEListener, rssiToBars, type NearbyBLEDevice, type PolarDeviceStatus } from '../services/ble';
import { startTelemetryReporting, stopTelemetryReporting } from '../services/telemetryReporter';
import { getSensorAssignments, assignSensorToMember, addRegisteredSensor } from '../services/sensorRegistry';
import { Screen } from '../components/Screen';

type Step = 'details' | 'members' | 'sensors';

function initialsOf(name: string): string {
  return name.split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

const DAY_CHOICES = [
  { label: 'Today', offset: 0 },
  { label: 'Tomorrow', offset: 1 },
  { label: 'Day after', offset: 2 },
];

export function SessionSetupScreen() {
  const navigation = useNavigation<StackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'SessionSetup'>>();
  const { staff } = useAuth();
  const { width } = useWindowDimensions();
  const wide = width >= 700;

  const mode = route.params?.mode ?? 'start';
  const scheduledSessionId = route.params?.mode === 'start-scheduled' ? route.params.sessionId : undefined;

  const [step, setStep] = useState<Step>(mode === 'schedule' ? 'details' : mode === 'start-scheduled' ? 'sensors' : 'members');
  const [sessionName, setSessionName] = useState(route.params?.mode === 'start-scheduled' ? route.params.sessionName ?? '' : '');

  // ── Schedule fields ──────────────────────────────────────────────
  // Default the start time to the current time, rounded up to the next
  // 5-minute mark so the initial value is always in the future.
  const now = new Date();
  let initHour = now.getHours();
  let initMinute = Math.ceil(now.getMinutes() / 5) * 5;
  if (initMinute === 60) {
    initMinute = 0;
    initHour = (initHour + 1) % 24;
  }
  const [dayOffset, setDayOffset] = useState(0);
  const [hour, setHour] = useState(initHour % 12 === 0 ? 12 : initHour % 12);
  const [minute, setMinute] = useState(initMinute);
  const [amPm, setAmPm] = useState<'AM' | 'PM'>(initHour < 12 ? 'AM' : 'PM');

  const [members, setMembers] = useState<RemoteMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<RemoteMember[]>([]);
  const [remoteSession, setRemoteSession] = useState<RemoteSession | null>(null);
  const [sensorCap, setSensorCap] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Load members + sensors; for start-scheduled also load the session's roster ──
  useEffect(() => {
    (async () => {
      let roster: RemoteMember[] = [];
      try {
        const [m, sensors]: [RemoteMember[], RemoteSensor[]] = await Promise.all([
          membersApi.list(),
          sensorsApi.list().catch(() => [] as RemoteSensor[]), // trainer may 403 — cap just won't be enforced client-side
        ]);
        setMembers(m);
        roster = m;
        setSensorCap(sensors.length || null);
      } catch {
        Alert.alert('Could not load', 'Failed to load members — check your connection.');
      } finally {
        setLoadingMembers(false);
      }

      if (scheduledSessionId) {
        try {
          const s = await sessionsApi.get(scheduledSessionId);
          setRemoteSession(s);
          const rosterMembers = s.members
            ?.map((sm) => roster.find((mm) => mm.id === sm.memberId))
            .filter((x): x is RemoteMember => !!x) ?? [];
          setSelected(rosterMembers);
          setSessionName((prev) => prev || s.name);
        } catch {
          // Local-only resume (session never synced to the cloud, e.g. the
          // app was killed mid-session before the sync queue drained). Build
          // the roster from local SQLite rows — body stats fall back to the
          // formula engine's defaults, same as a brand-new member.
          const sess = await getSession(scheduledSessionId).catch(() => null);
          const rawMembers = await getSessionMembers(scheduledSessionId).catch(() => [] as unknown[]);
          if (sess) setSessionName((prev) => prev || sess.session_name);
          const localMembers: RemoteMember[] = (rawMembers as { member_id: string; member_name: string }[]).map((sm) => ({
            id: sm.member_id,
            memberCode: sm.member_id,
            name: sm.member_name ?? 'Member',
            status: 'active',
          }));
          setSelected(localMembers);
        }
      }
    })();
  }, [scheduledSessionId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.name.toLowerCase().includes(q) || m.memberCode.toLowerCase().includes(q));
  }, [members, search]);

  const atCap = sensorCap !== null && selected.length >= sensorCap;

  const toggleMember = (member: RemoteMember) => {
    setSelected((prev) => {
      const exists = prev.find((m) => m.id === member.id);
      if (exists) return prev.filter((m) => m.id !== member.id);
      if (atCap) {
        Alert.alert('Sensor limit reached', `Only ${sensorCap} sensor${sensorCap === 1 ? '' : 's'} registered at your gym — remove someone else first.`);
        return prev;
      }
      return [...prev, member];
    });
  };

  const scheduledAt = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    // 12-hour state → 24-hour wall clock: 12 AM = 0h, 12 PM = 12h.
    const hour24 = (hour % 12) + (amPm === 'PM' ? 12 : 0);
    d.setHours(hour24, minute, 0, 0);
    return d;
  }, [dayOffset, hour, minute, amPm]);

  // Start times must be in the future — for today, a time that has
  // already passed cannot be scheduled.
  const timeInPast = scheduledAt.getTime() <= Date.now();

  // ── Schedule save ────────────────────────────────────────────────
  const saveScheduled = async () => {
    if (!staff || !sessionName.trim()) return;
    // Scheduling with zero members is allowed — a trainer can put a
    // session on the calendar first and let members book into it later
    // (or add people to the roster afterwards), it doesn't need a
    // roster up front.
    if (timeInPast) {
      Alert.alert('Start time must be in the future', 'Pick a start time that has not passed yet.');
      return;
    }
    setSaving(true);
    try {
      // No trainer-set capacity anymore — it's always the number of
      // sensor slots registered at the gym, computed server-side.
      const created = await sessionsApi.create({
        id: uuidv4(),
        name: sessionName.trim(),
        scheduledAt: scheduledAt.toISOString(),
      });
      // Enroll whichever members were selected (may be none) so the
      // roster shows up immediately for anyone already picked.
      if (selected.length > 0) {
        await Promise.allSettled(selected.map((m) => sessionsApi.enrollMember(created.id, m.id)));
      }
      Alert.alert('Session Scheduled', `"${created.name}" is on the schedule for ${scheduledAt.toLocaleString()}.`, [
        { text: 'Done', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert('Could not schedule', e instanceof ApiError ? e.message : 'Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Start-now / start-scheduled: begin the live session ─────────
  const beginLiveSession = async (assignments: Record<string, string>) => {
    if (!staff) return;
    setSaving(true);
    try {
      const localSessionId = scheduledSessionId ?? uuidv4();
      // Build engine members from the SELECTED roster (works for start-now,
      // remote scheduled sessions AND local-only resume), enriching each
      // member with the full gym roster where available so the formula
      // engine gets real body stats instead of defaults.
      const membersForEngine = selected.map((sel) => {
        const full = members.find((mm) => mm.id === sel.id);
        return { member: full ?? sel, sensorDeviceId: assignments[sel.id] ?? '' };
      });

      if (membersForEngine.length === 0) {
        Alert.alert('No members', 'This session has no members with sensors assigned.');
        setSaving(false);
        return;
      }

      await sessionEngine.startSession({
        localSessionId,
        gymId: staff.gymId,
        trainerId: staff.id,
        sessionName: sessionName.trim(),
        members: membersForEngine,
        scheduledAt: remoteSession?.scheduledAt ?? (mode === 'schedule' ? scheduledAt.toISOString() : undefined),
      });
      sessionEngine.pause(); // CountdownOverlay on the live screen resumes it — see LiveSessionScreen
      navigation.replace('LiveSession', { sessionId: localSessionId });
    } catch (e) {
      Alert.alert('Could not start session', e instanceof Error ? e.message : 'Try again.');
      setSaving(false);
    }
  };

  const headerTitle = step === 'details' ? 'Schedule Session'
    : step === 'members' ? 'New Session'
    : 'Assign Sensors';

  return (
    <Screen edges={['top', 'bottom']}>
    <View style={styles.root}>
      <View style={styles.header}>
        {step !== (mode === 'schedule' ? 'details' : mode === 'start-scheduled' ? 'sensors' : 'members') && (
          <TouchableOpacity onPress={() => setStep(step === 'sensors' ? (mode === 'schedule' ? 'details' : 'members') : 'details')} hitSlop={10} style={styles.backBtn}>
            <ChevronLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
        )}
        <Text style={styles.title}>{headerTitle}</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10}>
          <X size={22} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      {step === 'details' && (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={styles.label}>Session name</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. Morning HIIT Blast"
            placeholderTextColor={colors.mutedForeground}
            value={sessionName}
            onChangeText={setSessionName}
          />

          <Text style={styles.label}>Date</Text>
          <View style={styles.chipRow}>
            {DAY_CHOICES.map((c) => (
              <TouchableOpacity
                key={c.offset}
                style={[styles.chip, dayOffset === c.offset && styles.chipActive]}
                onPress={() => setDayOffset(c.offset)}
              >
                <Text style={[styles.chipText, dayOffset === c.offset && styles.chipTextActive]}>{c.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.label}>Start time</Text>
          <View style={[styles.timeRow, wide && styles.timeRowWide]}>
            <Stepper label="Hour" value={hour} min={1} max={12} onChange={setHour} />
            <Stepper label="Minute" value={minute} min={0} max={55} step={5} onChange={setMinute} />
            <View style={styles.amPmWrap}>
              <Text style={styles.stepperLabel}>AM / PM</Text>
              <TouchableOpacity
                style={styles.amPmBtn}
                onPress={() => setAmPm((p) => (p === 'AM' ? 'PM' : 'AM'))}
                hitSlop={6}
                activeOpacity={0.7}
              >
                <Text style={styles.amPmText}>{amPm}</Text>
              </TouchableOpacity>
            </View>
          </View>
          {timeInPast && (
            <Text style={styles.pastTimeNote}>Start time must be in the future — choose a later time.</Text>
          )}

          <TouchableOpacity
            style={[styles.primaryButton, (!sessionName.trim() || saving || timeInPast) && styles.primaryButtonDisabled]}
            disabled={!sessionName.trim() || saving || timeInPast}
            onPress={() => setStep('members')}
          >
            <Text style={styles.primaryButtonText}>Next — Choose Members ({selected.length})</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {step === 'members' && (
        <View style={{ flex: 1 }}>
          <TextInput
            style={styles.nameInput}
            placeholder="Session name (e.g. Morning HIIT)"
            placeholderTextColor={colors.mutedForeground}
            value={sessionName}
            onChangeText={setSessionName}
          />

          <View style={styles.searchRow}>
            <Search size={16} color={colors.mutedForeground} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search by name or member code…"
              placeholderTextColor={colors.mutedForeground}
              value={search}
              onChangeText={setSearch}
              autoCorrect={false}
              returnKeyType="search"
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')} hitSlop={8}>
                <X size={15} color={colors.mutedForeground} />
              </TouchableOpacity>
            )}
          </View>

          {/* Sensor-slot readout — capacity is never a trainer-typed
              number, it's always the count of sensors registered for
              this branch (see SensorsScreen / /branch/sensors), and
              scheduling with zero members selected is completely fine
              — the roster can be filled in later. */}
          <View style={styles.capBar}>
            <View style={styles.capBarTop}>
              <Users size={13} color={atCap ? colors.warning : colors.primary} />
              <Text style={styles.capBarText}>
                {selected.length} selected{sensorCap !== null ? ` of ${sensorCap} sensor slot${sensorCap === 1 ? '' : 's'}` : ''}
              </Text>
            </View>
            {sensorCap !== null && sensorCap > 0 && (
              <View style={styles.capTrack}>
                <View
                  style={[
                    styles.capFill,
                    { width: `${Math.min(100, (selected.length / sensorCap) * 100)}%`, backgroundColor: atCap ? colors.warning : colors.primary },
                  ]}
                />
              </View>
            )}
          </View>

          {/* Selected members as removable chips — lets the trainer see
              and adjust the whole roster without hunting through the
              full list below. */}
          {selected.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.selectedChipsRow} contentContainerStyle={{ gap: spacing.xs }}>
              {selected.map((m) => (
                <TouchableOpacity key={m.id} style={styles.selectedChip} onPress={() => toggleMember(m)}>
                  <View style={styles.selectedChipAvatar}>
                    <Text style={styles.selectedChipAvatarText}>{initialsOf(m.name)}</Text>
                  </View>
                  <Text style={styles.selectedChipText} numberOfLines={1}>{m.name.split(' ')[0]}</Text>
                  <X size={12} color={colors.mutedForeground} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {loadingMembers ? (
            <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.primary} />
          ) : filtered.length === 0 ? (
            <View style={styles.emptySearch}>
              <Text style={styles.capNote}>{search.trim() ? 'No members match your search.' : 'No members found for this branch.'}</Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(m) => m.id}
              contentContainerStyle={styles.list}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const isSelected = !!selected.find((m) => m.id === item.id);
                const disabledByCap = !isSelected && atCap;
                return (
                  <TouchableOpacity
                    style={[styles.memberRow, isSelected && styles.memberRowSelected]}
                    onPress={() => toggleMember(item)}
                    activeOpacity={0.75}
                  >
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>{initialsOf(item.name)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.memberName}>{item.name}</Text>
                      <Text style={styles.memberCode}>{item.memberCode}</Text>
                    </View>
                    <View style={[styles.checkbox, isSelected && styles.checkboxChecked, disabledByCap && styles.checkboxDisabled]}>
                      {isSelected && <Check size={14} color={colors.primaryForeground} />}
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}

          <View style={styles.footerRow}>
            {mode === 'schedule' && (
              <TouchableOpacity style={styles.secondaryButton} onPress={() => setStep('details')}>
                <Text style={styles.secondaryButtonText}>Back</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.primaryButton, { flex: 1 }, (!sessionName.trim() || (mode !== 'schedule' && selected.length === 0) || saving) && styles.primaryButtonDisabled]}
              disabled={!sessionName.trim() || (mode !== 'schedule' && selected.length === 0) || saving}
              onPress={() => {
                if (mode === 'schedule') {
                  saveScheduled();
                } else {
                  setStep('sensors');
                }
              }}
            >
              {saving ? <ActivityIndicator color={colors.primaryForeground} /> : (
                <Text style={styles.primaryButtonText}>
                  {mode === 'schedule'
                    ? (selected.length > 0 ? `Schedule Session (${selected.length})` : 'Schedule Session (no members yet)')
                    : `Next — Assign Sensors (${selected.length})`}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {step === 'sensors' && (
        <SensorAssignStep
          members={selected}
          loadingMembers={loadingMembers}
          starting={saving}
          onBack={() => { if (mode === 'start-scheduled') navigation.goBack(); else setStep('members'); }}
          onStart={beginLiveSession}
        />
      )}
    </View>
    </Screen>
  );
}

// ── Stepper for hour/minute ──────────────────────────────────────────
// ── Tiny 4-bar signal indicator for the pre-flight sensor row ───────
function SignalDots({ bars }: { bars: 0 | 1 | 2 | 3 | 4 }) {
  const color = bars <= 1 ? colors.destructive : bars === 2 ? colors.warning : colors.mutedForeground;
  return (
    <View style={styles.signalDotsRow}>
      {[1, 2, 3, 4].map((i) => (
        <View key={i} style={[styles.signalDot, { height: 3 + i * 2, backgroundColor: i <= bars ? color : colors.border }]} />
      ))}
    </View>
  );
}

function Stepper({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperRow}>
        <TouchableOpacity style={styles.stepperBtn} onPress={() => onChange(clamp(value - step))} hitSlop={6}>
          <Text style={styles.stepperBtnText}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepperValue}>{String(value).padStart(2, '0')}</Text>
        <TouchableOpacity style={styles.stepperBtn} onPress={() => onChange(clamp(value + step))} hitSlop={6}>
          <Text style={styles.stepperBtnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Step 2: live BLE scan + tap-to-assign per member ────────────────
function SensorAssignStep({
  members,
  loadingMembers,
  starting,
  onBack,
  onStart,
}: {
  members: RemoteMember[];
  loadingMembers: boolean;
  starting: boolean;
  onBack: () => void;
  onStart: (assignments: Record<string, string>) => void;
}) {
  const [nearby, setNearby] = useState<NearbyBLEDevice[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({}); // memberId -> deviceId
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pickerForMember, setPickerForMember] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  // Pre-flight connectivity: live per-device status (BPM/battery/state),
  // keyed by ble.ts's deviceId — same source the live session screen
  // reads from, so "green here" reliably means "will stay green live".
  const [statuses, setStatuses] = useState<Record<string, PolarDeviceStatus>>({});

  // Prefill from the persisted sensor registry (member ↔ sensor defaults).
  // Runs once members actually arrive (async roster load); never clobbers an
  // assignment the trainer has already made manually.
  useEffect(() => {
    if (members.length === 0) return;
    getSensorAssignments().then((map) => {
      setAssignments((prev) => {
        const next = { ...prev };
        for (const m of members) {
          if (map[m.id] && !next[m.id]) next[m.id] = map[m.id];
        }
        return next;
      });
    });
  }, [members]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    startNearbyScan(setNearby)
      .then((s) => { stop = s; })
      .catch((e) => setScanError(e instanceof Error ? e.message : 'Could not start Bluetooth scan — check that Bluetooth is on and permissions are granted.'));
    return () => stop?.();
  }, []);

  useEffect(() => {
    const unsub = addGlobalBLEListener((deviceId, status) => {
      setStatuses((prev) => ({ ...prev, [deviceId]: status }));
    });
    return unsub;
  }, []);

  // Pre-flight telemetry reporting: no sessionId yet (none exists
  // until Start is pressed), so the portal dashboard shows these as
  // "connected, not in an active session" — still useful for a
  // trainer/manager checking sensor health from another device before
  // walking onto the floor. Torn down on unmount so it doesn't keep
  // reporting after the trainer navigates away without starting.
  useEffect(() => {
    const gen = startTelemetryReporting();
    return () => stopTelemetryReporting(gen);
  }, []);

  const assignDevice = async (memberId: string, device: NearbyBLEDevice) => {
    setConnecting(device.id);
    try {
      const deviceId = await registerNearbyDevice(device);
      setAssignments((prev) => ({ ...prev, [memberId]: deviceId }));
      setPickerForMember(null);
      // Persist so the same pairing is pre-filled next time.
      assignSensorToMember(memberId, deviceId).catch(() => {});
      addRegisteredSensor(deviceId).catch(() => {});
    } catch {
      Alert.alert('Could not connect', `Failed to connect to ${device.name}. Try again.`);
    } finally {
      setConnecting(null);
    }
  };

  const assignedCount = Object.keys(assignments).filter((id) => assignments[id]).length;
  const assignedDeviceIds = new Set(Object.values(assignments));

  // Pre-flight readiness rollup — drives both the banner and the soft
  // warning on Start. "Ready" = BLE state connected AND has produced
  // at least one HR packet; a sensor can be "connected" for a few
  // seconds before its first real reading, which is normal and not
  // something to warn about.
  const readiness = members.map((m) => {
    const deviceId = assignments[m.id];
    const status = deviceId ? statuses[deviceId] : undefined;
    const ready = !!status && status.state === 'connected' && status.hr > 0;
    const lowBattery = !!status && status.battery >= 0 && status.battery < 15;
    return { memberId: m.id, deviceId, status, ready, lowBattery };
  });
  const notReadyCount = readiness.filter((r) => r.deviceId && !r.ready).length;
  const lowBatteryCount = readiness.filter((r) => r.lowBattery).length;

  const handleStart = () => {
    const warnings: string[] = [];
    if (notReadyCount > 0) warnings.push(`${notReadyCount} assigned sensor${notReadyCount === 1 ? ' is' : 's are'} not streaming yet`);
    if (lowBatteryCount > 0) warnings.push(`${lowBatteryCount} sensor${lowBatteryCount === 1 ? ' is' : 's are'} low on battery`);
    if (warnings.length === 0) { onStart(assignments); return; }
    Alert.alert(
      'Some sensors aren\'t ready',
      `${warnings.join(' and ')}. You can still start — anyone not streaming yet shows as "waiting for signal" and connects automatically once worn.`,
      [
        { text: 'Go back', style: 'cancel' },
        { text: 'Start anyway', style: 'default', onPress: () => onStart(assignments) },
      ],
    );
  };

  return (
    <View style={{ flex: 1 }}>
      {members.length === 0 && loadingMembers ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm }}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.capNote}>Loading session members…</Text>
        </View>
      ) : members.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm }}>
          <Text style={styles.capNote}>This session has no members — go back and add some.</Text>
        </View>
      ) : (
      <>
      <Text style={styles.capNote}>
        Tap each member to connect their sensor. Scanning for nearby Polar sensors…{'\n'}
        Members without a sensor can still start — assign or mark them absent live from the session grid.
      </Text>

      {scanError && (
        <View style={styles.scanErrorBanner}>
          <Text style={styles.scanErrorText}>{scanError}</Text>
        </View>
      )}

      {(notReadyCount > 0 || lowBatteryCount > 0) && (
        <View style={styles.readinessBanner}>
          <AlertTriangle size={13} color={colors.warning} />
          <Text style={styles.readinessText}>
            {notReadyCount > 0 ? `${notReadyCount} not streaming` : ''}
            {notReadyCount > 0 && lowBatteryCount > 0 ? ' · ' : ''}
            {lowBatteryCount > 0 ? `${lowBatteryCount} low battery` : ''}
          </Text>
        </View>
      )}

      <FlatList
        data={members}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          const assignedDeviceId = assignments[item.id];
          const assignedDevice = nearby.find((d) => d.id === assignedDeviceId);
          const status = assignedDeviceId ? statuses[assignedDeviceId] : undefined;
          const ready = !!status && status.state === 'connected' && status.hr > 0;
          const dotColor = !assignedDeviceId ? colors.mutedForeground
            : ready ? colors.success
            : status?.state === 'connecting' || status?.state === 'scanning' || status?.state === 'discovering' ? colors.warning
            : status?.state === 'error' ? colors.destructive
            : colors.mutedForeground;
          return (
            <TouchableOpacity style={styles.memberRow} onPress={() => setPickerForMember(item.id)}>
              <View style={[styles.sensorDot, assignedDeviceId && { backgroundColor: dotColor + '22', borderColor: dotColor }]}>
                <Radio size={14} color={dotColor} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.memberName}>{item.name}</Text>
                <Text style={styles.memberCode}>
                  {!assignedDeviceId ? 'Tap to assign a sensor'
                    : ready ? `${status!.hr} bpm — live`
                    : assignedDevice ? `${assignedDevice.name} — connecting…`
                    : 'Connecting…'}
                </Text>
              </View>
              {assignedDeviceId && status && status.battery >= 0 && (
                <View style={styles.batteryChip}>
                  <BatteryMedium size={12} color={status.battery < 15 ? colors.destructive : colors.mutedForeground} />
                  <Text style={[styles.batteryText, status.battery < 15 && { color: colors.destructive }]}>{status.battery}%</Text>
                </View>
              )}
              {assignedDeviceId && status?.rssi != null && (
                <SignalDots bars={rssiToBars(status.rssi)} />
              )}
            </TouchableOpacity>
          );
        }}
      />

      {pickerForMember && (
        <View style={styles.pickerOverlay}>
          <View style={styles.pickerCard}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Nearby Sensors</Text>
              <TouchableOpacity onPress={() => setPickerForMember(null)} hitSlop={10}>
                <X size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
            {nearby.filter((d) => !assignedDeviceIds.has(d.id)).length === 0 && (
              <Text style={styles.emptyPicker}>No unassigned sensors found yet — make sure it's powered on and nearby.</Text>
            )}
            <FlatList
              data={nearby.filter((d) => !assignedDeviceIds.has(d.id))}
              keyExtractor={(d) => d.id}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.deviceRow}
                  onPress={() => assignDevice(pickerForMember, item)}
                  disabled={connecting === item.id}
                >
                  <Text style={styles.deviceName}>{item.name}</Text>
                  {connecting === item.id ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={styles.deviceRssi}>{item.rssi ?? '—'} dBm</Text>}
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      )}

      <View style={styles.footerRow}>
        <TouchableOpacity style={styles.secondaryButton} onPress={onBack}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryButton, { flex: 1 }, starting && styles.primaryButtonDisabled]}
          disabled={starting}
          onPress={handleStart}
        >
          {starting ? <ActivityIndicator color={colors.primaryForeground} /> : (
            <Text style={styles.primaryButtonText}>
              {assignedCount === members.length ? 'Start Session' : `Start Session (${assignedCount}/${members.length} sensors)`}
            </Text>
          )}
        </TouchableOpacity>
      </View>
      </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md, gap: spacing.sm },
  backBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fonts.heading, fontSize: 20, color: colors.foreground, flex: 1 },
  content: { paddingBottom: spacing.xxl },
  label: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.mutedForeground, marginTop: spacing.lg, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md, fontFamily: fonts.body, fontSize: 15, color: colors.foreground,
  },
  nameInput: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md, fontFamily: fonts.body, fontSize: 15, color: colors.foreground, marginBottom: spacing.md,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.full, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.foreground },
  chipTextActive: { color: colors.primaryForeground },
  timeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.md },
  timeRowWide: { gap: spacing.lg },
  stepper: { alignItems: 'center' },
  stepperLabel: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, marginBottom: 4 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.xs },
  stepperBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.muted },
  stepperBtnText: { fontFamily: fonts.heading, fontSize: 18, color: colors.foreground },
  stepperValue: { fontFamily: fonts.heading, fontSize: 18, color: colors.foreground, minWidth: 40, textAlign: 'center' },
  amPmWrap: { alignItems: 'center' },
  amPmBtn: { height: 42, minWidth: 60, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  amPmText: { fontFamily: fonts.heading, fontSize: 18, color: colors.foreground },
  pastTimeNote: { fontFamily: fonts.body, fontSize: 12, color: colors.destructive, marginTop: spacing.xs },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: spacing.md, marginBottom: spacing.sm,
  },
  searchInput: { flex: 1, paddingVertical: spacing.sm, fontFamily: fonts.body, fontSize: 14, color: colors.foreground },
  capNote: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginBottom: spacing.sm },
  capBar: { marginBottom: spacing.sm, gap: 6 },
  capBarTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  capBarText: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.foreground },
  capTrack: { height: 5, borderRadius: radius.full, backgroundColor: colors.muted, overflow: 'hidden' },
  capFill: { height: '100%', borderRadius: radius.full },
  selectedChipsRow: { marginBottom: spacing.sm, maxHeight: 40 },
  selectedChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.card, borderWidth: 1,
    borderColor: colors.primary + '44', borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 6, maxWidth: 140,
  },
  selectedChipAvatar: { width: 18, height: 18, borderRadius: 9, backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center' },
  selectedChipAvatarText: { fontFamily: fonts.bodySemiBold, fontSize: 8, color: colors.primary },
  selectedChipText: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.foreground, maxWidth: 70 },
  emptySearch: { alignItems: 'center', paddingTop: spacing.xl },
  scanErrorBanner: { backgroundColor: colors.destructive + '1A', borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
  scanErrorText: { fontFamily: fonts.body, fontSize: 12, color: colors.destructive },
  readinessBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.warning + '1A',
    borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: 7, marginBottom: spacing.sm,
  },
  readinessText: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.warning },
  batteryChip: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: spacing.xs },
  batteryText: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground },
  signalDotsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, marginLeft: spacing.xs },
  signalDot: { width: 3, borderRadius: 1 },
  list: { paddingBottom: spacing.lg },
  memberRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm,
    borderRadius: radius.md, marginBottom: 2,
  },
  memberRowSelected: { backgroundColor: colors.primary + '0F' },
  memberAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  memberAvatarText: { fontFamily: fonts.bodySemiBold, fontSize: 12, color: colors.foreground },
  checkbox: { width: 22, height: 22, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkboxDisabled: { opacity: 0.35 },
  memberName: { fontFamily: fonts.bodyMedium, fontSize: 14, color: colors.foreground },
  memberCode: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 1 },
  sensorDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  sensorDotOk: { borderColor: colors.success },
  primaryButton: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center', marginTop: spacing.sm },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonText: { fontFamily: fonts.bodySemiBold, color: colors.primaryForeground, fontSize: 15 },
  secondaryButton: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, marginTop: spacing.sm },
  secondaryButtonText: { fontFamily: fonts.bodyMedium, color: colors.foreground, fontSize: 15 },
  footerRow: { flexDirection: 'row', gap: spacing.sm },
  pickerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: spacing.lg },
  pickerCard: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, maxHeight: '70%' },
  pickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  pickerTitle: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.foreground },
  emptyPicker: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground, paddingVertical: spacing.lg, textAlign: 'center' },
  deviceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  deviceName: { fontFamily: fonts.bodyMedium, fontSize: 14, color: colors.foreground },
  deviceRssi: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground },
});
