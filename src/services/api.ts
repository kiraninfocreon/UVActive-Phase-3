/**
 * UV Active Member App — cloud API client (member realm).
 * Same transport as the trainer app: fetch + timeout + one silent
 * refresh on 401, tokens in SecureStore. The response envelope is
 * `{ data }`; errors carry `{ error: { message, code } }`.
 */
import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '../config';

const ACCESS = 'uva_member_access';
const REFRESH = 'uva_member_refresh';
const PROFILE = 'uva_member_profile';

export interface MemberProfile {
  id: string;
  memberCode: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  photoUrl?: string | null;
  currentGymId?: string | null;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export const tokenStore = {
  getAccess: () => SecureStore.getItemAsync(ACCESS),
  getRefresh: () => SecureStore.getItemAsync(REFRESH),
  async getProfile(): Promise<MemberProfile | null> {
    const raw = await SecureStore.getItemAsync(PROFILE);
    return raw ? JSON.parse(raw) : null;
  },
  async set(access: string, refresh: string, profile: MemberProfile) {
    await Promise.all([
      SecureStore.setItemAsync(ACCESS, access),
      SecureStore.setItemAsync(REFRESH, refresh),
      SecureStore.setItemAsync(PROFILE, JSON.stringify(profile)),
    ]);
  },
  setAccess: (access: string) => SecureStore.setItemAsync(ACCESS, access),
  async setProfile(profile: MemberProfile) { await SecureStore.setItemAsync(PROFILE, JSON.stringify(profile)); },
  async clear() {
    await Promise.all([SecureStore.deleteItemAsync(ACCESS), SecureStore.deleteItemAsync(REFRESH), SecureStore.deleteItemAsync(PROFILE)]);
  },
};

const TIMEOUT_MS = 45_000; // survives a cold-started free-tier host

interface Opts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  isRetry?: boolean;
}

async function request<T>(path: string, o: Opts = {}): Promise<T> {
  const { method = 'GET', body, auth = true, isRetry = false } = o;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = await tokenStore.getAccess();
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') throw new ApiError('Request timed out — check your connection.', 0, 'TIMEOUT');
    throw new ApiError('Network error — check your connection.', 0, 'NETWORK');
  }
  clearTimeout(timer);

  if (res.status === 401 && auth && !isRetry) {
    if (await tryRefresh()) return request<T>(path, { ...o, isRetry: true });
    await tokenStore.clear();
    onUnauthorized?.();
    throw new ApiError('Session expired — please sign in again.', 401, 'UNAUTHORIZED');
  }
  const env = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(env?.error?.message || env?.message || `Server error (${res.status})`, res.status, env?.error?.code);
  return (env?.data ?? env) as T;
}

let refreshing: Promise<boolean> | null = null;
function tryRefresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refreshToken = await tokenStore.getRefresh();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken, realm: 'member' }),
      });
      if (!res.ok) return false;
      const env = await res.json();
      const access = env?.data?.accessToken ?? env?.accessToken;
      if (!access) return false;
      await tokenStore.setAccess(access);
      return true;
    } catch { return false; } finally { refreshing = null; }
  })();
  return refreshing;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown, opts?: Partial<Opts>) => request<T>(p, { method: 'POST', body, ...opts }),
  patch: <T>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body }),
  delete: <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};

interface LoginResult { accessToken: string; refreshToken: string; member: MemberProfile }

export async function loginWithPin(memberCode: string, pin: string): Promise<MemberProfile> {
  const r = await request<LoginResult>('/auth/member/login', { method: 'POST', body: { memberCode: memberCode.trim(), pin }, auth: false });
  await tokenStore.set(r.accessToken, r.refreshToken, r.member);
  return r.member;
}

export async function loginWithEmail(email: string, password: string): Promise<MemberProfile> {
  const r = await request<LoginResult>('/auth/member/login-email', { method: 'POST', body: { email: email.trim(), password }, auth: false });
  await tokenStore.set(r.accessToken, r.refreshToken, r.member);
  return r.member;
}

export async function logout() {
  const refreshToken = await tokenStore.getRefresh();
  try { if (refreshToken) await api.post('/auth/logout', { refreshToken, realm: 'member' }); } catch { /* best-effort */ } finally { await tokenStore.clear(); }
}
