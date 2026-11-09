import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, Image } from 'react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import { Screen } from '../components/Screen';
import { Glass } from '../components/uv/Glass';
import { PillButton, UnderlineTabs } from '../components/uv/Ui';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../services/api';

export function LoginScreen() {
  const { loginPin, loginEmail } = useAuth();
  const [mode, setMode] = useState<'pin' | 'email'>('pin');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = mode === 'pin' ? code.trim().length > 0 && pin.length === 6 : email.includes('@') && password.length > 0;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (mode === 'pin') await loginPin(code, pin); else await loginEmail(email, password);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not sign in. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
        <Image source={require('../../assets/uvactive-logo.jpg')} style={styles.logo} resizeMode="contain" />
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.sub}>Sign in to see your workouts and book your next session.</Text>

        <Glass style={{ padding: spacing.xl, marginTop: spacing.xl }}>
          <UnderlineTabs value={mode} onChange={setMode} tabs={[{ key: 'pin', label: 'Member ID' }, { key: 'email', label: 'Email' }]} />
          {mode === 'pin' ? (
            <>
              <Field label="Member ID" value={code} onChangeText={setCode} autoCapitalize="characters" />
              <Field label="6-digit PIN" value={pin} onChangeText={(t) => setPin(t.replace(/\D/g, '').slice(0, 6))} secure keyboardType="number-pad" />
            </>
          ) : (
            <>
              <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
              <Field label="Password" value={password} onChangeText={setPassword} secure />
            </>
          )}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PillButton label={busy ? 'Signing in…' : 'Sign in'} disabled={!ready || busy} onPress={submit} icon={busy ? <ActivityIndicator size="small" color="#fff" /> : undefined} style={{ marginTop: spacing.md }} />
        </Glass>
      </KeyboardAvoidingView>
    </Screen>
  );
}

export function Field({ label, value, onChangeText, secure, keyboardType, autoCapitalize }: {
  label: string; value: string; onChangeText: (t: string) => void; secure?: boolean; keyboardType?: any; autoCapitalize?: any;
}) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize ?? 'none'}
        autoCorrect={false}
        placeholderTextColor={colors.mutedForeground}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xl },
  logo: { width: 120, height: 56, alignSelf: 'flex-start', marginBottom: spacing.xl },
  title: { fontFamily: fonts.heading, fontSize: 32, letterSpacing: -0.5, color: colors.foreground },
  sub: { fontFamily: fonts.body, fontSize: 14, color: colors.mutedForeground, marginTop: 8, lineHeight: 20 },
  label: { fontFamily: fonts.bodySemiBold, fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase', color: colors.mutedForeground, marginBottom: 6 },
  input: { backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder, borderRadius: radius.lg, paddingHorizontal: spacing.lg, paddingVertical: 13, fontFamily: fonts.metric, fontSize: 15, color: colors.foreground },
  error: { fontFamily: fonts.body, fontSize: 13, color: colors.destructive, marginTop: 4 },
});
