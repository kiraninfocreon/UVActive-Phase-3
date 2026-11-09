// ── UV Active Formula Engine — shared types ──────────────────────────
// Every field name here matches the existing AthleteSummary / live-tick
// shape already established in the trainer-app spec doc, plus the
// exact field list from "Post-Workout Summary — Data Output Specification"
// (Formula Reference PDF, page 8-9).

export type Sex = "male" | "female";

/** Zone 1 (Recovery) .. Zone 5 (Peak). 0 = below Zone 1 / not yet warmed up. */
export type Zone = 0 | 1 | 2 | 3 | 4 | 5;

export interface ZoneBoundaryTable {
  /** Upper %MHR bound of each zone, e.g. {1:60,2:70,3:80,4:90,5:100} (PDF default). */
  ceilings: Record<1 | 2 | 3 | 4 | 5, number>;
}

/** Default 5-zone table from the Formula Reference PDF, Module 01. Configurable per gym — never hardcode this table into calling code, always pass one in. */
export const DEFAULT_ZONE_TABLE: ZoneBoundaryTable = {
  ceilings: { 1: 60, 2: 70, 3: 80, 4: 90, 5: 100 },
};

export interface MemberProfile {
  age: number;
  sex: Sex;
  weightKg: number;
  heightCm: number;
  restingHr: number;
  /** Currently stored MHR — may be null for a brand-new member (compute one with computeMhr). */
  storedMhr: number | null;
  /** Number of completed sessions so far — gates the 5-session Karvonen adjustment and the "adaptive MHR" auto-update rule. */
  sessionCount: number;
}

/** One raw BLE HR tick for one member, arriving roughly once per second. */
export interface HrTick {
  memberId: string;
  ts: number; // epoch ms
  bpm: number;
  /** True when this tick was synthesized by the watchdog's gap-fill, not read off the sensor. Stored (isInterpolated=1) in the local/cloud ticks table for ops/QA — never surfaced in any member- or trainer-facing copy. */
  interpolated?: boolean;
}

/** Per-member, per-second live dashboard payload — PDF page 9, "Real-Time Display". */
export interface LiveTick {
  memberId: string;
  memberName: string;
  currentBPM: number;
  pctMHR: number;
  currentZone: Zone;
  zoneColour: string;
  sweatPointsSoFar: number;
  timeInCurrentZone: number; // seconds, resets on zone change
  isPersonalBest: boolean;
  rank?: number;
  rssi?: number;
  battery?: number; // 0-100, -1/undefined if unknown — pre-flight + live dashboard only
  /** No tick has ever arrived for this member (never-connected / dead block). Distinct from isReconnecting. */
  isDropped?: boolean;
  /**
   * Sensor connected and streaming previously, but the watchdog hasn't
   * seen a REAL packet in >15s and is currently gap-filling from this
   * member's own trend. Internal signal only — the trainer UI shows a
   * neutral "Reconnecting…" pill, never "hardware fault" / "dropout"
   * language, and the member-facing app shows nothing different at all.
   */
  isReconnecting?: boolean;
  /** Running net calories for THIS member's own active time — same formula as the final summary, so the live tile and the post-workout figure agree. */
  caloriesSoFar?: number;
  /** Lifecycle of the member within this session. `away` = sensor silent past the gap-fill cap (scoring frozen, rejoins automatically if the sensor returns); `left` = trainer marked them as having left. */
  memberStatus?: "active" | "away" | "left";
  /** Drives the avatar on the live tile — girl avatar for female, boy avatar otherwise. No photos. */
  sex?: Sex;
  /** Seconds this member has actually been scored for this session (their own window, not the session clock). */
  activeSeconds?: number;
  /** Epoch ms this member entered the session; > session start for a late joiner. */
  joinedAtMs?: number;
}

/** Continuous per-session accumulator carried tick-to-tick. Persist this to SQLite every tick so a crash never loses progress (spec §4/§5). */
export interface SessionAccumulatorState {
  memberId: string;
  mhr: number;
  restingHr: number;
  weightKg: number;
  heightCm: number;
  age: number;
  sex: Sex;

  /** Whole seconds spent in each zone so far (index 0 unused, 1-5 used). */
  zoneSeconds: [number, number, number, number, number, number];
  /** Intensity-weighted sweat points, accumulated per §UV Score module. */
  sweatPoints: number;
  /** Sum of BPM readings and reading count, for avgHr. */
  hrSum: number;
  hrCount: number;
  peakHr: number;

  currentZone: Zone;
  /** Seconds spent continuously in currentZone (for zone-5-sustained alerting and timeInCurrentZone). */
  secondsInCurrentZone: number;
  /** Last N seconds of raw ticks kept in memory only for stall/glitch guardrails — not for storage. */
  recentBpm: number[]; // capped ring buffer, most recent last

  /**
   * Windowed (ts, bpm) pairs of REAL (non-interpolated) ticks only, used
   * by the watchdog's gap-fill trend estimate — see sensorWatchdog.ts.
   * Deliberately separate from recentBpm (glitch-guard window is short
   * and includes everything); this one is longer and never contains a
   * synthetic sample, so a dropout can't pollute its own fill estimate.
   */
  recentRealSamples: { ts: number; bpm: number }[];
  /** Consecutive seconds currently being gap-filled (0 when live). Reset to 0 the moment a real tick lands. Capped by GAP_FILL_MAX_SECONDS in the watchdog — beyond the cap, accumulation freezes instead of continuing to fabricate. */
  consecutiveInterpolatedSeconds: number;
  /** Running total of interpolated seconds this session — ops/QA visibility only, never surfaced to the member or on the public leaderboard. */
  totalInterpolatedSeconds: number;

  /** Highest %MHR ever observed for this member (any session) — for isPersonalBest. Pass in from history, default 0. */
  allTimeBestPctMhr: number;

  /** Interval-based recovery tracking (§Recovery Points improvement). */
  intervalPeakHr: number | null;
  intervalRestStartTs: number | null;
  intervalRecoveries60: number[]; // one entry per completed rest interval

  /** Consistency tracking, only used when the trainer sets interval targets. */
  activeTargetZone: Zone | null;
  targetZoneSecondsInInterval: number;
  targetIntervalTotalSeconds: number;
  intervalConsistencies: number[]; // % per completed interval

  lastTickTs: number;

  /**
   * Seconds actually scored for this member this session (measured +
   * bounded gap-fill ticks). This — NOT the session clock — is the
   * duration calories/EPOC are scaled to, so a late joiner or an early
   * leaver is never credited for time they weren't there. Optional so
   * accumulator rows persisted by an older build still rehydrate.
   */
  activeSeconds?: number;
}

export type RecoveryGrade = "Elite" | "Excellent" | "Good" | "Average" | "Building" | "Needs work";

export interface FinalSessionSummary {
  memberId: string;
  uvScore: number;
  sweatPoints: number; // 1 decimal
  recoveryPoints: number | null; // null if no recovery challenge was run
  recoveryGrade: RecoveryGrade | null;
  consistencyPct: number | null;
  netCalories: number;
  adjustedCalories: number | null; // only after 5+ sessions
  epocCalories: number;
  epocDurationHours: number;
  avgHr: number;
  peakHr: number;
  avgPctMhr: number;
  zoneSeconds: [number, number, number, number, number, number];
  zoneMinutes: [number, number, number, number, number, number];
  intervalRecoveries60: number[];
  finalRank: number | null; // set by caller after sorting all members by uvScore
  isPersonalBest: boolean;
  proposedMhr: number | null; // set if peakHr > storedMhr this session — needs member confirmation
  /** Ops/QA field only — total seconds of this member's session that were gap-filled rather than measured. Never rendered on the member summary, trainer leaderboard, or any export; exists purely so an operator can audit "was this score mostly real data" if a member disputes a result. */
  totalInterpolatedSeconds: number;
  /** Seconds this member was actually scored for — their own participation window. Sent to the cloud so recalculation uses the same figure. */
  activeSeconds?: number;
  /** Epoch ms the member entered the session (== session start unless a late joiner). */
  joinedAtMs?: number;
  /** Epoch ms the member left / went silent for good. Null/undefined when they were there until the end. */
  leftAtMs?: number | null;
  /** Readings dropped by the live glitch guard (impossible values / isolated spikes). Ops/QA only. */
  rejectedReadings?: number;
}

export interface AlertEvent {
  memberId: string;
  message: string;
  severity: "info" | "warning" | "error";
  code: string;
}
