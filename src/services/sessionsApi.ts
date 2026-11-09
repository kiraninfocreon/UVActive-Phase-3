import { api } from './api';
import type { FinalSessionSummary } from '../lib/formula-engine';

// ── Sessions (POST /trainer/sessions/*) ────────────────────────────

export interface CreateSessionInput {
  // Client-generated id (the same uuid sessionEngine.ts mints as the
  // local SQLite session id). Sending it makes the cloud row's real id
  // match the local one from creation onward — see sessionEngine.ts's
  // startSession() for why that matters for every later sync event.
  id?: string;
  name: string;
  capacity?: number;
  scheduledAt?: string; // ISO
  scheduledEndAt?: string; // ISO
  trainerId?: string; // only set when a branch manager schedules on behalf of a trainer
}

export interface RemoteSession {
  id: string;
  gymId: string;
  trainerId: string;
  trainer?: { id: string; name: string };
  name: string;
  capacity: number;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  startedAt?: string | null;
  endedAt?: string | null;
  scheduledAt?: string | null;
  scheduledEndAt?: string | null;
  needsReassignment: boolean;
  createdAt: string;
  members?: RemoteSessionMember[];
  _count?: { members: number };
}

export interface RemoteSessionMember {
  id: string;
  memberId: string;
  member?: { id: string; name: string; memberCode: string };
  avgHr?: number | null;
  maxHr?: number | null;
  calories?: number | null;
  score?: number | null;
  attendance: string;
  // Rich post-workout results (spec §7), present once a session has
  // ended — same fields the Admin Panel / Branch Portal leaderboard
  // drill-down shows. May be null when a member ran no recovery
  // challenge (recoveryPoints) or the session predates this data.
  sweatPoints?: number | null;
  recoveryPoints?: number | null;
  recoveryGrade?: string | null;
  epocCalories?: number | null;
  epocHours?: number | null;
  avgPctMhr?: number | null;
  maxPctMhr?: number | null;
  finalRank?: number | null;
  /**
   * Per-zone minutes (keyed by zone number as a string, e.g.
   * {"1": 3.5, "2": 5.2, ...}). Returned by the cloud API once
   * a session ends — the trainer-app's Session Details and
   * Session Athlete Detail screens need this to render the zone
   * distribution bar/breakdown for sessions that were run on
   * another device (synced from the cloud). Previously missing
   * from this type, which silently dropped the field.
   */
  zoneMinutes?: Record<string, number> | null;
}

// Per-second BPM history for one member within one session — powers the
// leaderboard → member drill-down graph. `zone`/`pctMhr` come pre-computed
// from the cloud API so the graph can be colour-coded without needing the
// member's bio client-side.
export interface HrTick {
  ts: number;
  bpm: number;
  zone?: number | null;
  pctMhr?: number | null;
}

export const sessionsApi = {
  create: (dto: CreateSessionInput) => api.post<RemoteSession>('/trainer/sessions', dto),
  listMine: () => api.get<RemoteSession[]>('/trainer/sessions'),
  get: (id: string) => api.get<RemoteSession>(`/trainer/sessions/${id}`),

  enrollMember: (sessionId: string, memberId: string) => api.post(`/trainer/sessions/${sessionId}/members`, { memberId }),
  unenrollMember: (sessionId: string, memberId: string) => api.delete(`/trainer/sessions/${sessionId}/members/${memberId}`),
  // Values must match the cloud API's SetAttendanceDto exactly
  // (AttendanceStatus enum: enrolled | attended | no_show) — this
  // previously listed 'checked_in' / 'cancelled', neither of which the
  // backend accepts, which would have 400'd the moment any screen
  // wired this call up.
  setAttendance: (sessionId: string, memberId: string, attendance: 'enrolled' | 'attended' | 'no_show') =>
    api.post(`/trainer/sessions/${sessionId}/attendance`, { memberId, attendance }),

  start: (sessionId: string) => api.post<RemoteSession>(`/trainer/sessions/${sessionId}/start`),

  /**
   * Leaderboard → member drill-down graph data (History tab: session →
   * leaderboard → tap a member → full stat screen). Zone-coloured
   * per-second BPM history, scoped to the trainer's own gym.
   */
  athleteTicks: (sessionId: string, memberId: string) =>
    api.get<{ ticks: HrTick[] }>(`/trainer/sessions/${sessionId}/athlete/${memberId}/ticks`),

  /**
   * Batched raw-tick ingestion — the sync queue's primary drain target.
   * `readings` is capped client-side at SYNC_BATCH_SIZE per call (see
   * config.ts); this function doesn't chunk on its own, callers (the
   * sync queue flusher) are responsible for batching.
   */
  ingestReadings: (sessionId: string, readings: { memberId: string; ts: string; hr: number; interpolated?: boolean }[]) =>
    api.post(`/trainer/sessions/${sessionId}/readings`, { readings }),

  /**
   * Final per-member results, submitted once at session end. Field
   * names here are the cloud API's (avgHr/maxHr/calories/score/
   * zoneMinutes) — mapping from the formula engine's FinalSessionSummary
   * shape (peakHr/netCalories/uvScore/zoneSeconds) happens at the call
   * site (sessionEngine.ts's endSession), not in this file.
   */
  end: (sessionId: string, results: EndSessionResult[]) => api.post(`/trainer/sessions/${sessionId}/end`, { results }),

  cancel: (sessionId: string, reason: string) => api.post(`/trainer/sessions/${sessionId}/cancel`, { reason }),

  /**
   * Server-side recompute of Sweat/Recovery/EPOC/Max %HR/rank from the
   * cloud DB's stored readings — works for ANY past session, on any
   * device, independent of this phone's local SQLite.
   */
  recalculateSession: (sessionId: string) => api.post(`/trainer/sessions/${sessionId}/recalculate`),
};

export interface EndSessionResult {
  memberId: string;
  avgHr?: number;
  maxHr?: number;
  calories?: number;
  score?: number;
  zoneMinutes?: Record<string, number>;
  // Rich post-workout fields — must be forwarded or the History →
  // leaderboard → member drill-down screen has nothing to show for
  // Sweat/Recovery Points, EPOC and %MHR on sessions run through this
  // app (previously computed by finalizeSummary() and then silently
  // dropped here before the POST).
  sweatPoints?: number;
  recoveryPoints?: number;
  recoveryGrade?: string;
  epocCalories?: number;
  epocHours?: number;
  avgPctMhr?: number;
  maxPctMhr?: number;
  finalRank?: number;
  // Participation window — a late joiner / early leaver is scored over
  // THEIR own active time (the cloud stores it and recalculation uses it).
  activeSeconds?: number;
  joinedAt?: string; // ISO
  leftAt?: string;   // ISO — omitted when the member was there until the end
}

/** Maps the formula engine's summary shape onto what the cloud API's EndSessionDto expects. */
export function toEndSessionResult(summary: FinalSessionSummary): EndSessionResult {
  const zoneMinutes: Record<string, number> = {};
  summary.zoneSeconds.forEach((seconds, zone) => {
    zoneMinutes[String(zone)] = Math.round((seconds / 60) * 10) / 10;
  });
  return {
    memberId: summary.memberId,
    avgHr: Math.round(summary.avgHr),
    maxHr: Math.round(summary.peakHr),
    calories: Math.round(summary.netCalories * 10) / 10,
    score: Math.round(summary.uvScore * 10) / 10,
    zoneMinutes,
    sweatPoints: summary.sweatPoints,
    recoveryPoints: summary.recoveryPoints ?? undefined,
    recoveryGrade: summary.recoveryGrade ?? undefined,
    epocCalories: summary.epocCalories,
    epocHours: summary.epocDurationHours,
    avgPctMhr: summary.avgPctMhr,
    finalRank: summary.finalRank ?? undefined,
    activeSeconds: summary.activeSeconds,
    joinedAt: summary.joinedAtMs ? new Date(summary.joinedAtMs).toISOString() : undefined,
    leftAt: summary.leftAtMs ? new Date(summary.leftAtMs).toISOString() : undefined,
  };
}

// ── Members (roster, read-only from the Trainer App) ────────────────

export interface RemoteMember {
  id: string;
  memberCode: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  sex?: 'male' | 'female' | 'other' | null;
  ageYears?: number | null;
  heightCm?: number | null;
  weightKg?: number | null;
  restingHr?: number | null;
  status: string;
}

export interface MemberProfileResponse {
  member: RemoteMember;
  sessions: {
    sessionId: string;
    sessionName: string;
    startedAt: string | null;
    endedAt: string | null;
    avgHr: number | null;
    peakHr: number | null;
    calories: number | null;
    score: number | null;
    // The API has always returned these (getProfileForBranch), but this
    // type previously didn't declare them, so the client silently
    // dropped them on the floor — that's why the profile-mode Athlete
    // Detail screen (Members tab) never had zone data to show.
    zoneMinutes?: Record<string, number> | null;
  }[];
  avgBpmOverall: number | null;
  // Last ~500 sensor readings across ALL of this member's sessions at
  // this gym, already zone/%MHR-tagged server-side (zoneForBpm) — same
  // shape as HrTick below. Powers the profile-mode "zone colours" HR
  // curve toggle the same way session-mode gets it from local ticks.
  hrTicks?: HrTick[];
}

export const membersApi = {
  list: () => api.get<RemoteMember[]>('/branch/members'),
  search: (code: string) => api.get<RemoteMember[]>('/branch/members/search', { code }),
  profile: (id: string) => api.get<MemberProfileResponse>(`/branch/members/${id}/profile`),
};

// ── Sensors (read-only inventory — management stays on the Branch Portal) ──

export interface RemoteSensor {
  id: string;
  name: string;
  sensorId: string;
  note?: string | null;
}

export const sensorsApi = {
  list: () => api.get<RemoteSensor[]>('/branch/sensors'),
  /**
   * Report one sensor's live connection/battery state for the
   * connectivity dashboard (branch/admin portals + this app's own
   * pre-flight check across app restarts). Fire-and-forget by design
   * at the call site — a dropped telemetry POST should never block or
   * disrupt the live session, it just means the dashboard is a beat
   * stale until the next state change reports successfully.
   */
  reportTelemetry: (sensorId: string, data: { batteryPct?: number; connectionState: 'connected' | 'reconnecting' | 'disconnected'; sessionId?: string }) =>
    api.post(`/trainer/sensors/${encodeURIComponent(sensorId)}/telemetry`, data),
  telemetry: () => api.get<{ sensor: RemoteSensor; telemetry: { connectionState: string; batteryPct: number | null; lastSeenAt: string | null } }[]>('/trainer/sensors/telemetry'),
};

// ── Gym / dashboard context ──────────────────────────────────────────

export interface BranchDashboard {
  memberCount: number;
  memberLimit: number;
  sessionsToday: RemoteSession[];
  pendingTransferCount: number;
  trainerCount: number;
  sensorCount: number;
}

export const gymApi = {
  dashboard: () => api.get<BranchDashboard>('/branch/dashboard'),
};
