import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import { Screen } from '../components/Screen';
import { Glass } from '../components/uv/Glass';
import { Avatar } from '../components/uv/Avatar';
import { PillButton, SectionTitle, UnderlineTabs } from '../components/uv/Ui';
import { Field } from './LoginScreen';
import { useAuth } from '../hooks/useAuth';
import { memberApi, type MemberDetail, type Sex } from '../services/memberApi';
import { ApiError } from '../services/api';

const SEXES: { key: Sex; label: string }[] = [{ key: 'female', label: 'Female' }, { key: 'male', label: 'Male' }, { key: 'other', label: 'Other' }];
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

export function SettingsScreen() {
  const { member, logout } = useAuth();
  const [me, setMe] = useState<MemberDetail | null>(null);
  const [sex, setSex] = useState<Sex | null>(null);
  const [age, setAge] = useState(''); const [height, setHeight] = useState('');
  const [weight, setWeight] = useState(''); const [rhr, setRhr] = useState('');
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useState<'body' | 'security'>('body');

  const [curPin, setCurPin] = useState(''); const [newPin, setNewPin] = useState('');
  const [curPw, setCurPw] = useState(''); const [newPw, setNewPw] = useState('');
  const [busy, setBusy] = useState<'pin' | 'pw' | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await memberApi.me();
      setMe(m); setSex(m.sex ?? null);
      setAge(m.ageYears?.toString() ?? ''); setHeight(m.heightCm?.toString() ?? '');
      setWeight(m.weightKg?.toString() ?? ''); setRhr(m.restingHr?.toString() ?? '');
    } catch { /* offline: leave blank */ }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const saveBody = async () => {
    const payload = { sex: sex ?? undefined, ageYears: num(age), heightCm: num(height), weightKg: num(weight), restingHr: num(rhr) };
    if ([payload.ageYears, payload.heightCm, payload.weightKg, payload.restingHr].some((v) => v !== undefined && (!Number.isFinite(v) || v <= 0))) {
      return Alert.alert('Check your numbers', 'Age, height, weight and resting heart rate must be positive numbers.');
    }
    if (payload.ageYears !== undefined && !Number.isInteger(payload.ageYears)) return Alert.alert('Check your numbers', 'Age must be a whole number.');
    if (payload.restingHr !== undefined && !Number.isInteger(payload.restingHr)) return Alert.alert('Check your numbers', 'Resting heart rate must be a whole number.');
    setSaving(true);
    try { setMe(await memberApi.updateBody(payload)); Alert.alert('Saved', 'Your body details were updated. Your heart-rate zones use these.'); }
    catch (e) { Alert.alert('Could not save', msg(e)); } finally { setSaving(false); }
  };

  const changePin = async () => {
    setBusy('pin');
    try { await memberApi.changePin(curPin, newPin); setCurPin(''); setNewPin(''); Alert.alert('PIN changed'); }
    catch (e) { Alert.alert('Could not change PIN', msg(e)); } finally { setBusy(null); }
  };
  const changePw = async () => {
    setBusy('pw');
    try { await memberApi.changePassword(curPw, newPw); setCurPw(''); setNewPw(''); Alert.alert('Password changed'); }
    catch (e) { Alert.alert('Could not change password', msg(e)); } finally { setBusy(null); }
  };

  const confirmLogout = () => Alert.alert('Sign out?', undefined, [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => logout() }]);

  return (
    <Screen edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={styles.heading}>Settings</Text>

        <Glass style={styles.profile}>
          <Avatar sex={sex ?? me?.sex} seed={member?.id ?? ''} size={64} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{member?.name}</Text>
            <Text style={styles.meta}>{member?.memberCode}{me?.currentGym?.name ? ` · ${me.currentGym.name}` : ''}</Text>
            {member?.email ? <Text style={styles.meta}>{member.email}</Text> : null}
          </View>
        </Glass>

        <View style={{ marginTop: spacing.xl }}>
          <UnderlineTabs value={section} onChange={setSection} tabs={[{ key: 'body', label: 'Body' }, { key: 'security', label: 'Security' }]} />
        </View>

        {section === 'body' ? (
          <Glass style={{ padding: spacing.xl }}>
            <Text style={styles.label}>Sex (sets your avatar and calorie formula)</Text>
            <View style={styles.seg}>
              {SEXES.map((s) => (
                <TouchableOpacity key={s.key} onPress={() => setSex(s.key)} style={[styles.segItem, sex === s.key && styles.segOn]} activeOpacity={0.85}>
                  <Text style={[styles.segText, sex === s.key && { color: '#fff' }]}>{s.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.two}>
              <View style={{ flex: 1 }}><Field label="Weight (kg)" value={weight} onChangeText={setWeight} keyboardType="decimal-pad" /></View>
              <View style={{ flex: 1 }}><Field label="Height (cm)" value={height} onChangeText={setHeight} keyboardType="decimal-pad" /></View>
            </View>
            <View style={styles.two}>
              <View style={{ flex: 1 }}><Field label="Age" value={age} onChangeText={setAge} keyboardType="number-pad" /></View>
              <View style={{ flex: 1 }}><Field label="Resting HR" value={rhr} onChangeText={setRhr} keyboardType="number-pad" /></View>
            </View>
            <PillButton label={saving ? 'Saving…' : 'Save changes'} disabled={saving} onPress={saveBody} />
          </Glass>
        ) : (
          <>
            <Glass style={{ padding: spacing.xl }}>
              <SectionTitle>Change PIN</SectionTitle>
              <Field label="Current PIN" value={curPin} onChangeText={(t) => setCurPin(t.replace(/\D/g, '').slice(0, 6))} secure keyboardType="number-pad" />
              <Field label="New PIN (6 digits)" value={newPin} onChangeText={(t) => setNewPin(t.replace(/\D/g, '').slice(0, 6))} secure keyboardType="number-pad" />
              <PillButton label={busy === 'pin' ? 'Updating…' : 'Update PIN'} disabled={busy !== null || curPin.length !== 6 || newPin.length !== 6} onPress={changePin} />
            </Glass>
            <Glass style={{ padding: spacing.xl, marginTop: spacing.lg }}>
              <SectionTitle>Change password</SectionTitle>
              <Field label="Current password" value={curPw} onChangeText={setCurPw} secure />
              <Field label="New password (min 8 characters)" value={newPw} onChangeText={setNewPw} secure />
              <PillButton label={busy === 'pw' ? 'Updating…' : 'Update password'} disabled={busy !== null || !curPw || newPw.length < 8} onPress={changePw} />
            </Glass>
          </>
        )}

        <PillButton variant="danger" label="Sign out" onPress={confirmLogout} style={{ marginTop: spacing.xxl }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: 130 },
  heading: { fontFamily: fonts.heading, fontSize: 30, letterSpacing: -0.5, color: colors.foreground, marginBottom: spacing.lg },
  profile: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, padding: spacing.lg },
  name: { fontFamily: fonts.heading, fontSize: 20, color: colors.foreground },
  meta: { fontFamily: fonts.body, fontSize: 12, color: colors.mutedForeground, marginTop: 3 },
  label: { fontFamily: fonts.bodySemiBold, fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase', color: colors.mutedForeground, marginBottom: 8 },
  seg: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: radius.full, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder },
  segOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  segText: { fontFamily: fonts.bodySemiBold, fontSize: 13, color: colors.mutedForeground },
  two: { flexDirection: 'row', gap: spacing.md },
});
