import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { staffLogin, staffLogout, tokenStore, setUnauthorizedHandler, type StaffProfile, type StaffLoginResult } from '../services/api';

interface AuthContextValue {
  staff: StaffProfile | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<StaffLoginResult>;
  logout: () => Promise<void>;
  isBranchManager: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [staff, setStaff] = useState<StaffProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    tokenStore.getProfile().then((p) => {
      setStaff(p);
      setLoading(false);
    });
    setUnauthorizedHandler(() => setStaff(null));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await staffLogin(email, password);
    if (result.staff) setStaff(result.staff);
    return result;
  }, []);

  const logout = useCallback(async () => {
    await staffLogout();
    setStaff(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ staff, loading, login, logout, isBranchManager: staff?.role === 'branch_manager' }),
    [staff, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
