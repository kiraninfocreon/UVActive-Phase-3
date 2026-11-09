import { api } from './api';

export type Sex = 'male' | 'female' | 'other';

export interface MemberDetail {
  id: string;
  memberCode: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  sex?: Sex | null;
  ageYears?: number | null;
  heightCm?: number | null;
  weightKg?: number | null;
  restingHr?: number | null;
  currentGym?: { id: string; name: string } | null;
}

export interface WorkoutSession {
  id: string;
  name: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  scheduledAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  gym?: { name: string } | null;
  trainer?: { name: string } | null;
}

/** One of the member's own session rows (their result in a session). */
export interface Workout {
  id: string;
  sessionId: string;
  attendance: string;
  avgHr?: number | null;
  maxHr?: number | null;
  calories?: number | null;
  score?: number | null;
  sweatPoints?: number | null;
  recoveryPoints?: number | null;
  recoveryGrade?: string | null;
  epocCalories?: number | null;
  avgPctMhr?: number | null;
  maxPctMhr?: number | null;
  finalRank?: number | null;
  zoneMinutes?: Record<string, number> | null;
  participantCount?: number;
  session: WorkoutSession;
}

export interface AvailableSession extends WorkoutSession {
  capacity: number;
  isBooked: boolean;
  spotsOpen: number;
  scheduledAt: string;
}

export interface AppNotification {
  id: string;
  type: string;
  title?: string | null;
  body: string;
  readAt?: string | null;
  createdAt: string;
}

export interface Tick { ts: string | number; bpm: number; zone?: number }

export const memberApi = {
  me: () => api.get<MemberDetail>('/member/me'),
  updateBody: (p: Partial<Pick<MemberDetail, 'sex' | 'ageYears' | 'heightCm' | 'weightKg' | 'restingHr'>>) => api.patch<MemberDetail>('/member/me', p),
  changePin: (currentPin: string, newPin: string) => api.post('/member/change-pin', { currentPin, newPin }),
  changePassword: (currentPassword: string, newPassword: string) => api.post('/member/change-password', { currentPassword, newPassword }),
  setPushToken: (token: string) => api.post('/member/push-token', { token }),

  workouts: () => api.get<Workout[]>('/member/sessions'),
  workout: (id: string) => api.get<Workout>(`/member/sessions/${id}`),
  ticks: (id: string) => api.get<{ ticks: Tick[] }>(`/member/sessions/${id}/ticks`),
  available: () => api.get<AvailableSession[]>('/member/sessions/available'),
  book: (id: string) => api.post(`/member/sessions/${id}/book`),
  cancelBooking: (id: string) => api.delete(`/member/sessions/${id}/booking`),

  notifications: () => api.get<AppNotification[]>('/member/notifications'),
  markRead: (id: string) => api.post(`/member/notifications/${id}/read`),
  markAllRead: () => api.post('/member/notifications/read-all'),
};
