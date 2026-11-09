import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { Eye, EyeOff, LogOut, KeyRound, User, Bluetooth, Building2, Mail, Info, CloudUpload, Pencil, X, Check } from 'lucide-react-native';
import Constants from 'expo-constants';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import { useAuth } from '../hooks/useAuth';
import { api, ApiError, changePassword } from '../services/api';
import { getBLEAdapterState } from '../services/ble';
import { addSyncListener, getSyncState, syncNow } from '../services/syncQueue';
import { Screen } from '../components/Screen';

export function SettingsScreen() {
  const { staff, logout } = useAuth();

  return (
    <Screen edges={['top']}>
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Settings</Text>

      <ProfileCard
        name={staff?.name ?? ''}
        email={staff?.email ?? ''}
        gymName={staff?.gymName ?? ''}
        role={staff?.role ?? 'trainer'}
      />
      <ChangePasswordCard />
      <SyncCard />
      <BleDiagnosticsCard />
      <AppInfoCard />

      <TouchableOpacity style={styles.signOutButton} onPress={() => logout()}>
        <LogOut size={18} color={colors.destructive} />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
    </Screen>
  );
}

// ── Edit profile (name/phone — email stays the login identity, same rule as the Branch Portal) ──
// Read-only summary by default with a pencil to enter edit mode — the
// name/phone inputs aren't sitting open on screen the whole time, and
// tapping the pencil is the one clear place to start editing (matching
// the Branch Portal's own profile-edit pattern).
function ProfileCard({ name: initialName, email, gymName, role }: { name: string; email: string; gymName: string; role: string }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setName(initialName);
    setEditing(true);
  };

  const cancelEdit = () => {
    setName(initialName);
    setEditing(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      // Trainers edit their OWN name/phone via a dedicated self-service
      // endpoint — the branch-managed PATCH /branch/trainers/:id route
      // is manager-only and can't be reached by a plain trainer at all.
      await api.patch(`/trainer/me`, { name, phone });
      setEditing(false);
      Alert.alert('Saved', 'Your profile was updated.');
    } catch (e) {
      Alert.alert('Could not save', e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <User size={16} color={colors.primary} />
        <Text style={styles.cardTitle}>Profile</Text>
        {!editing && (
          <TouchableOpacity style={styles.pencilBtn} onPress={startEdit} hitSlop={8}>
            <Pencil size={14} color={colors.mutedForeground} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.infoRow}>
        <Mail size={13} color={colors.mutedForeground} />
        <Text style={styles.infoRowText} numberOfLines={1}>{email || '—'}</Text>
      </View>
      <View style={styles.infoRow}>
        <Building2 size={13} color={colors.mutedForeground} />
        <Text style={styles.infoRowText} numberOfLines={1}>{gymName || '—'}</Text>
      </View>
      <View style={styles.infoRow}>
        <User size={13} color={colors.mutedForeground} />
        <Text style={styles.infoRowText}>{role === 'branch_manager' ? 'Branch Manager' : 'Trainer'}</Text>
      </View>

      {!editing ? (
        <View style={styles.readonlyBlock}>
          <Text style={styles.label}>Name</Text>
          <Text style={styles.readonlyValue}>{initialName || '—'}</Text>
        </View>
      ) : (
        <>
          <Text style={styles.label}>Name</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholderTextColor={colors.mutedForeground} autoFocus />
          <Text style={styles.label}>Phone</Text>
          <TextInput style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Optional" placeholderTextColor={colors.mutedForeground} />
          <View style={styles.editButtonRow}>
            <TouchableOpacity style={styles.cancelButton} onPress={cancelEdit} disabled={saving}>
              <X size={15} color={colors.mutedForeground} />
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.saveButton, styles.saveButtonFlex]} onPress={save} disabled={saving || !name.trim()}>
              {saving ? <ActivityIndicator color={colors.primaryForeground} /> : (
                <>
                  <Check size={15} color={colors.primaryForeground} />
                  <Text style={styles.saveButtonText}>Save</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

// ── Sync to cloud — sessions auto-push after each session ends; this ──
// gives the trainer visibility into last-sync time plus a manual trigger.
function SyncCard() {
  const [state, setState] = useState(getSyncState());
  const [syncing, setSyncing] = useState(false);

  React.useEffect(() => addSyncListener((s) => setState(s)), []);

  const trigger = async () => {
    setSyncing(true);
    try {
      const result = await syncNow();
      if (!result.ok) Alert.alert('Could not sync', result.message);
    } finally {
      setSyncing(false);
    }
  };

  const lastSyncLabel = state.lastSyncedAtMs
    ? new Date(state.lastSyncedAtMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Never';

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <CloudUpload size={16} color={colors.primary} />
        <Text style={styles.cardTitle}>Sync to Cloud</Text>
      </View>
      <View style={styles.diagRow}>
        <Text style={styles.diagLabel}>Last sync</Text>
        <Text style={styles.diagValue}>{lastSyncLabel}</Text>
      </View>
      {state.lastError ? <Text style={styles.errorText}>{state.lastError}</Text> : null}
      <TouchableOpacity style={styles.saveButton} onPress={trigger} disabled={syncing || state.flushing}>
        {syncing || state.flushing ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={styles.saveButtonText}>Sync Now</Text>}
      </TouchableOpacity>
      <Text style={styles.note}>
        Sessions push to the cloud automatically when they end — use this to force a sync now (e.g. after being offline).
      </Text>
    </View>
  );
}

// ── App / environment info ──────────────────────────────────────────
function AppInfoCard() {
  const version = Constants.expoConfig?.version ?? '—';
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Info size={16} color={colors.primary} />
        <Text style={styles.cardTitle}>About</Text>
      </View>
      <View style={styles.diagRow}>
        <Text style={styles.diagLabel}>App version</Text>
        <Text style={styles.diagValue}>{version}</Text>
      </View>
      <View style={styles.diagRow}>
        <Text style={styles.diagLabel}>Sensor limit</Text>
        <Text style={styles.diagValue}>Up to 6 concurrent BLE sensors</Text>
      </View>
      <Text style={styles.note}>
        UV Active Trainer — sessions record locally and sync to the cloud when online.
      </Text>
    </View>
  );
}

// ── Change password — collapsed behind a button by default. The fields
// only appear once the trainer taps "Change Password", instead of three
// password inputs sitting open on the Settings page all the time.
function ChangePasswordCard() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 8;
  const valid = current.length > 0 && next.length >= 8 && next === confirm;

  const reset = () => {
    setCurrent(''); setNext(''); setConfirm(''); setShow(false);
  };

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await changePassword(current, next);
      reset();
      setOpen(false);
      Alert.alert('Password updated', 'Use your new password next time you sign in.');
    } catch (e) {
      Alert.alert('Could not update password', e instanceof ApiError ? e.message : 'Check your current password.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <TouchableOpacity style={styles.card} onPress={() => setOpen(true)} activeOpacity={0.8}>
        <View style={styles.cardHeader}>
          <KeyRound size={16} color={colors.primary} />
          <Text style={styles.cardTitle}>Change Password</Text>
        </View>
        <View style={styles.changePasswordButton}>
          <Text style={styles.changePasswordButtonText}>Change Password</Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <KeyRound size={16} color={colors.primary} />
        <Text style={styles.cardTitle}>Change Password</Text>
        <TouchableOpacity style={styles.pencilBtn} onPress={() => { reset(); setOpen(false); }} hitSlop={8}>
          <X size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <Text style={styles.label}>Current password</Text>
      <PasswordField value={current} onChangeText={setCurrent} show={show} setShow={setShow} />

      <Text style={styles.label}>New password</Text>
      <PasswordField value={next} onChangeText={setNext} show={show} setShow={setShow} />
      {tooShort && <Text style={styles.errorText}>Password must be at least 8 characters.</Text>}

      <Text style={styles.label}>Confirm new password</Text>
      <PasswordField value={confirm} onChangeText={setConfirm} show={show} setShow={setShow} />
      {mismatch && <Text style={styles.errorText}>Passwords don't match.</Text>}

      <TouchableOpacity style={[styles.saveButton, !valid && styles.saveButtonDisabled]} onPress={submit} disabled={!valid || saving}>
        {saving ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={styles.saveButtonText}>Update Password</Text>}
      </TouchableOpacity>
    </View>
  );
}

function PasswordField({ value, onChangeText, show, setShow }: { value: string; onChangeText: (t: string) => void; show: boolean; setShow: (v: boolean) => void }) {
  return (
    <View style={styles.passwordRow}>
      <TextInput
        style={[styles.input, styles.passwordInput]}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={!show}
        placeholderTextColor={colors.mutedForeground}
      />
      <TouchableOpacity style={styles.eyeButton} onPress={() => setShow(!show)} hitSlop={10}>
        {show ? <EyeOff size={17} color={colors.mutedForeground} /> : <Eye size={17} color={colors.mutedForeground} />}
      </TouchableOpacity>
    </View>
  );
}

// ── BLE adapter diagnostics ────────────────────────────────────────
function BleDiagnosticsCard() {
  const [state, setState] = useState<string>('checking…');

  React.useEffect(() => {
    getBLEAdapterState().then(setState).catch(() => setState('unknown'));
  }, []);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Bluetooth size={16} color={colors.primary} />
        <Text style={styles.cardTitle}>Bluetooth</Text>
      </View>
      <View style={styles.diagRow}>
        <Text style={styles.diagLabel}>Adapter state</Text>
        <Text style={[styles.diagValue, state === 'PoweredOn' ? styles.diagOk : styles.diagWarn]}>{state}</Text>
      </View>
      <Text style={styles.note}>
        Sensor connection limits and pairing are managed from the Sensor Bridge screen during a live session.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  heading: { fontFamily: fonts.heading, fontSize: 24, color: colors.foreground, marginBottom: spacing.sm },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.sm },
  cardTitle: { fontFamily: fonts.bodySemiBold, fontSize: 14, color: colors.foreground, flex: 1 },
  pencilBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
  readonlyBlock: { marginTop: spacing.xs },
  readonlyValue: { fontFamily: fonts.bodyMedium, fontSize: 15, color: colors.foreground, marginTop: 2 },
  editButtonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  cancelButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
  },
  cancelButtonText: { fontFamily: fonts.bodyMedium, fontSize: 14, color: colors.mutedForeground },
  saveButtonFlex: { flex: 1, marginTop: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  changePasswordButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: spacing.sm, alignItems: 'center' },
  changePasswordButtonText: { fontFamily: fonts.bodySemiBold, color: colors.primaryForeground, fontSize: 14 },
  label: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.mutedForeground, marginTop: spacing.sm, marginBottom: spacing.xs },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
  infoRowText: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, flex: 1 },
  input: {
    backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontFamily: fonts.body, fontSize: 14, color: colors.foreground,
  },
  passwordRow: { position: 'relative', justifyContent: 'center' },
  passwordInput: { paddingRight: 40 },
  eyeButton: { position: 'absolute', right: spacing.sm },
  errorText: { color: colors.destructive, fontFamily: fonts.body, fontSize: 11, marginTop: 4 },
  saveButton: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingVertical: spacing.sm, alignItems: 'center', marginTop: spacing.md },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { fontFamily: fonts.bodySemiBold, color: colors.primaryForeground, fontSize: 14 },
  diagRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  diagLabel: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground },
  diagValue: { fontFamily: fonts.bodyMedium, fontSize: 13 },
  diagOk: { color: colors.success },
  diagWarn: { color: colors.warning },
  note: { fontFamily: fonts.body, fontSize: 11, color: colors.mutedForeground, marginTop: spacing.sm },
  signOutButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    borderWidth: 1, borderColor: colors.destructive, borderRadius: radius.md, paddingVertical: spacing.md, marginTop: spacing.md,
  },
  signOutText: { color: colors.destructive, fontFamily: fonts.bodySemiBold, fontSize: 15 },
});
