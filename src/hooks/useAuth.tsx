import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loginWithEmail, loginWithPin, logout as apiLogout, tokenStore, setUnauthorizedHandler, type MemberProfile } from '../services/api';

interface Ctx {
  member: MemberProfile | null;
  loading: boolean;
  loginPin: (code: string, pin: string) => Promise<void>;
  loginEmail: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setMember: (m: MemberProfile) => void;
}
const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [member, setMemberState] = useState<MemberProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    tokenStore.getProfile().then((p) => { setMemberState(p); setLoading(false); });
    setUnauthorizedHandler(() => setMemberState(null));
  }, []);

  const loginPin = useCallback(async (c: string, p: string) => setMemberState(await loginWithPin(c, p)), []);
  const loginEmail = useCallback(async (e: string, p: string) => setMemberState(await loginWithEmail(e, p)), []);
  const logout = useCallback(async () => { await apiLogout(); setMemberState(null); }, []);
  const setMember = useCallback((m: MemberProfile) => { setMemberState(m); tokenStore.setProfile(m).catch(() => {}); }, []);

  const value = useMemo(() => ({ member, loading, loginPin, loginEmail, logout, setMember }), [member, loading, loginPin, loginEmail, logout, setMember]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthContext);
  if (!c) throw new Error('useAuth must be used within AuthProvider');
  return c;
}
