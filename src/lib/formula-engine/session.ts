import { computeZone, computePctMhr, ZONE_COLOURS } from "./zones";
import { computeSweatPointsTick } from "./points";
import { computeGrossCalories, computeBmr, computeRestingCalories, computeNetCalories, computeAdjustedCalories } from "./calories";
import { computeEpoc } from "./epoc";
import { isSustainedPeak } from "./mhr";
import { DEFAULT_ZONE_TABLE } from "./types";
import type { FinalSessionSummary, HrTick, LiveTick, MemberProfile, SessionAccumulatorState, ZoneBoundaryTable } from "./types";

const RECENT_BPM_WINDOW = 5;
const MHR_ADJUSTMENT_MIN_SESSIONS = 5;
/** How far back the gap-fill trend estimator looks for real samples. Kept well under GAP_FILL_MAX_SECONDS (sensorWatchdog.ts) so a fill never trends off data from before the current work/rest phase. */
const REAL_SAMPLE_WINDOW_MS = 30_000;

/** Fresh per-member accumulator at session start. Rehydrate from SQLite instead of this on app-relaunch-mid-session (spec §4 "offer to resume"). */
export function createAccumulator(profile: MemberProfile, memberId: string, allTimeBestPctMhr = 0): SessionAccumulatorState {
  const mhr = profile.storedMhr ?? Math.round(profile.age > 40 || profile.sex === "female" ? 208 - 0.7 * profile.age : 220 - profile.age);
  return {
    memberId,
    mhr,
    restingHr: profile.restingHr,
    weightKg: profile.weightKg,
    heightCm: profile.heightCm,
    age: profile.age,
    sex: profile.sex,
    zoneSeconds: [0, 0, 0, 0, 0, 0],
    sweatPoints: 0,
    hrSum: 0,
    hrCount: 0,
    peakHr: 0,
    currentZone: 0,
    secondsInCurrentZone: 0,
    recentBpm: [],
    recentRealSamples: [],
    consecutiveInterpolatedSeconds: 0,
    totalInterpolatedSeconds: 0,
    allTimeBestPctMhr,
    intervalPeakHr: null,
    intervalRestStartTs: null,
    intervalRecoveries60: [],
    activeTargetZone: null,
    targetZoneSecondsInInterval: 0,
    targetIntervalTotalSeconds: 0,
    intervalConsistencies: [],
    lastTickTs: 0,
    activeSeconds: 0,
  };
}

/**
 * Net calories for a member's OWN active time so far — the identical
 * Keytel → minus-resting formula finalizeSummary() uses, evaluated on the
 * running average HR. That makes the live tile's calories converge on
 * (and finish equal to) the post-workout figure instead of two different
 * numbers. Returns 0 until the member has produced a reading, and never
 * goes negative (Keytel is only meaningful at exercise heart rates).
 */
export function computeLiveCalories(state: Pick<SessionAccumulatorState, "hrSum" | "hrCount" | "weightKg" | "heightCm" | "age" | "sex" | "activeSeconds">): number {
  if (state.hrCount <= 0) return 0;
  const hours = (state.activeSeconds ?? state.hrCount) / 3600;
  if (hours <= 0) return 0;
  const avgHr = state.hrSum / state.hrCount;
  const gross = computeGrossCalories({ avgHr, weightKg: state.weightKg, age: state.age, sex: state.sex, durationHours: hours });
  const resting = computeRestingCalories(computeBmr({ weightKg: state.weightKg, heightCm: state.heightCm, age: state.age, sex: state.sex }), hours);
  return Math.max(0, computeNetCalories(gross, resting));
}

/**
 * Called when a paused session resumes. The first tick after a break
 * must not be credited the break as elapsed time, and the watchdog must
 * not read the break as a sensor dropout — clearing lastTickTs makes the
 * next real tick count as exactly one second.
 */
export function markResumed(state: SessionAccumulatorState): SessionAccumulatorState {
  return { ...state, lastTickTs: 0 };
}

export interface ProcessTickResult {
  state: SessionAccumulatorState;
  liveTick: LiveTick;
}

/**
 * The one function called once per BLE HR tick per athlete (spec §3).
 * Pure — takes the previous accumulator state and one new reading,
 * returns the next state plus the live-dashboard payload. Caller
 * writes `state` to SQLite immediately after calling this (write-through,
 * never batched-then-lost).
 */
export function processTick(
  state: SessionAccumulatorState,
  tick: HrTick,
  memberName: string,
  zoneTable: ZoneBoundaryTable = DEFAULT_ZONE_TABLE,
): ProcessTickResult {
  const pctMhr = computePctMhr(tick.bpm, state.mhr);
  const zone = computeZone(pctMhr, zoneTable);

  // For a real tick, derive elapsed time from the wall-clock gap since
  // the last tick, capped at 5s so a short natural hiccup (app
  // backgrounded briefly, sensor out of range for a couple seconds)
  // doesn't retroactively credit zone time it didn't actually observe.
  //
  // For a WATCHDOG-SYNTHESIZED tick this cap is wrong and was a real
  // bug caught by the sensorWatchdog end-to-end scenario test: the
  // watchdog only starts firing once a gap has ALREADY exceeded the
  // 15s alert threshold (by design — that's the point where a hiccup
  // becomes a discontinuity worth fixing), so tick.ts - lastTickTs on
  // the FIRST synthetic tick is always >15s, and deriving elapsed time
  // from that delta would hit the 5s cap and silently under-credit
  // the gap — exactly the "quietly wrong data" the watchdog exists to
  // prevent, just moved one layer deeper. The watchdog fires exactly
  // once per second (see WATCHDOG_TICK_MS in sensorWatchdog.ts), so an
  // interpolated tick's elapsed time is always exactly 1s, full stop,
  // regardless of how large the gap that preceded it was. Seconds 0-15
  // of the gap (before the watchdog engages) are deliberately left
  // uncredited — that's the alert threshold working as intended, not
  // a hole this mechanism is responsible for filling.
  const secondsElapsed = tick.interpolated
    ? 1
    : state.lastTickTs > 0 ? Math.max(0, Math.min(5, Math.round((tick.ts - state.lastTickTs) / 1000))) : 1;

  const recentBpm = [...state.recentBpm, tick.bpm].slice(-RECENT_BPM_WINDOW);

  // Real-sample window feeds the watchdog's gap-fill trend estimate —
  // interpolated ticks are deliberately excluded so a fill can never
  // trend off a previous fill (that's how you get runaway drift).
  const recentRealSamples = tick.interpolated
    ? state.recentRealSamples
    : [...state.recentRealSamples, { ts: tick.ts, bpm: tick.bpm }].filter((s) => tick.ts - s.ts <= REAL_SAMPLE_WINDOW_MS);
  const consecutiveInterpolatedSeconds = tick.interpolated ? state.consecutiveInterpolatedSeconds + secondsElapsed : 0;
  const totalInterpolatedSeconds = state.totalInterpolatedSeconds + (tick.interpolated ? secondsElapsed : 0);

  let peakHr = state.peakHr;
  if (tick.bpm > peakHr && isSustainedPeak(recentBpm, tick.bpm)) {
    peakHr = tick.bpm;
  }

  const zoneSeconds = [...state.zoneSeconds] as SessionAccumulatorState["zoneSeconds"];
  if (zone > 0) zoneSeconds[zone] += secondsElapsed;

  const sweatPointsTick = computeSweatPointsTick(pctMhr, zone, zoneTable) * secondsElapsed;
  const sweatPoints = state.sweatPoints + sweatPointsTick;

  const secondsInCurrentZone = zone === state.currentZone ? state.secondsInCurrentZone + secondsElapsed : secondsElapsed;

  // Consistency tracking, only active while a trainer-set target zone is running.
  let targetZoneSecondsInInterval = state.targetZoneSecondsInInterval;
  let targetIntervalTotalSeconds = state.targetIntervalTotalSeconds;
  if (state.activeTargetZone !== null) {
    targetIntervalTotalSeconds += secondsElapsed;
    if (zone === state.activeTargetZone) targetZoneSecondsInInterval += secondsElapsed;
  }

  const isPersonalBest = pctMhr > state.allTimeBestPctMhr;

  const nextState: SessionAccumulatorState = {
    ...state,
    zoneSeconds,
    sweatPoints,
    hrSum: state.hrSum + tick.bpm,
    hrCount: state.hrCount + 1,
    peakHr,
    currentZone: zone,
    secondsInCurrentZone,
    recentBpm,
    recentRealSamples,
    consecutiveInterpolatedSeconds,
    totalInterpolatedSeconds,
    allTimeBestPctMhr: isPersonalBest ? pctMhr : state.allTimeBestPctMhr,
    targetZoneSecondsInInterval,
    targetIntervalTotalSeconds,
    lastTickTs: tick.ts,
    // Rehydrated from an older build (no activeSeconds yet)? Seed from the reading count (~1 reading/sec) rather than restarting at 0.
    activeSeconds: (state.activeSeconds ?? state.hrCount) + secondsElapsed,
  };

  const liveTick: LiveTick = {
    memberId: state.memberId,
    memberName,
    currentBPM: tick.bpm,
    pctMHR: pctMhr,
    currentZone: zone,
    zoneColour: ZONE_COLOURS[zone],
    sweatPointsSoFar: Math.round(sweatPoints * 10) / 10,
    timeInCurrentZone: secondsInCurrentZone,
    isPersonalBest,
    // A tile that's currently being gap-filled reads as "reconnecting",
    // never as dropped/blank — the trainer still sees a live-looking
    // BPM + zone, it just isn't a fresh sensor packet underneath.
    isReconnecting: !!tick.interpolated,
    caloriesSoFar: Math.round(computeLiveCalories(nextState)),
    memberStatus: "active",
    activeSeconds: nextState.activeSeconds,
  };

  return { state: nextState, liveTick };
}

/**
 * Start a trainer-defined interval with a target zone — consistency
 * tracking begins accumulating from the next tick onward.
 */
export function startTargetInterval(state: SessionAccumulatorState, targetZone: SessionAccumulatorState["activeTargetZone"]): SessionAccumulatorState {
  return { ...state, activeTargetZone: targetZone, targetZoneSecondsInInterval: 0, targetIntervalTotalSeconds: 0 };
}

/** End the current target interval — folds its consistency % into the running list and clears the active target. */
export function endTargetInterval(state: SessionAccumulatorState): SessionAccumulatorState {
  if (state.activeTargetZone === null || state.targetIntervalTotalSeconds === 0) {
    return { ...state, activeTargetZone: null, targetZoneSecondsInInterval: 0, targetIntervalTotalSeconds: 0 };
  }
  const consistency = (state.targetZoneSecondsInInterval / state.targetIntervalTotalSeconds) * 100;
  return {
    ...state,
    activeTargetZone: null,
    targetZoneSecondsInInterval: 0,
    targetIntervalTotalSeconds: 0,
    intervalConsistencies: [...state.intervalConsistencies, consistency],
  };
}

export interface FinalizeSummaryInput {
  state: SessionAccumulatorState;
  durationHours: number;
  /** Recovery challenge result, if the trainer ran one at session end — omit if not run. */
  endOfSessionRecovery?: { peakHr: number; recoveryHr60s: number };
}

/**
 * Roll a finished accumulator into the immutable post-workout summary —
 * the exact field list from the "Post-Workout Summary — Data Output
 * Specification" (PDF page 8-9). Called once, at session end.
 */
export function finalizeSummary(input: FinalizeSummaryInput): FinalSessionSummary {
  const { endOfSessionRecovery } = input;
  const { state } = input;
  // Scale calories/EPOC to THIS member's own scored time. `durationHours`
  // (the whole session) is only the fallback for an accumulator rehydrated
  // from an older build that never tracked activeSeconds — using it for a
  // late joiner or early leaver is exactly what inflated their calories.
  const durationHours = state.activeSeconds != null ? state.activeSeconds / 3600 : input.durationHours;

  const avgHr = state.hrCount > 0 ? state.hrSum / state.hrCount : 0;
  const avgPctMhr = computePctMhr(avgHr, state.mhr);

  const zoneMinutes = state.zoneSeconds.map((s) => s / 60) as FinalSessionSummary["zoneSeconds"];

  const gross = computeGrossCalories({ avgHr, weightKg: state.weightKg, age: state.age, sex: state.sex, durationHours });
  const bmr = computeBmr({ weightKg: state.weightKg, heightCm: state.heightCm, age: state.age, sex: state.sex });
  const resting = computeRestingCalories(bmr, durationHours);
  // A member who never produced a reading has avgHr 0, which Keytel turns
  // into a large NEGATIVE burn — clamp so nobody is ever shown negative calories.
  const netCalories = state.hrCount > 0 ? Math.max(0, computeNetCalories(gross, resting)) : 0;
  const adjustedCalories =
    // sessionCount is tracked by the caller/DB, not this accumulator —
    // callers on session 5+ should call computeAdjustedCalories
    // themselves; finalizeSummary always returns the plain net figure
    // plus null here unless the caller supplies enough history. Kept
    // simple: this function doesn't know session history.
    null;

  const { epocCalories, epocDurationHours } = computeEpoc(zoneMinutes[4], zoneMinutes[5], state.weightKg);

  const recoveryPoints = endOfSessionRecovery ? endOfSessionRecovery.peakHr - endOfSessionRecovery.recoveryHr60s : null;

  const consistencyPct =
    state.intervalConsistencies.length > 0 ? state.intervalConsistencies.reduce((a, b) => a + b, 0) / state.intervalConsistencies.length : null;

  const sweatPointsRounded = Math.round(state.sweatPoints * 10) / 10;
  const uvScore = Math.round(sweatPointsRounded + (recoveryPoints ?? 0));

  return {
    memberId: state.memberId,
    uvScore,
    sweatPoints: sweatPointsRounded,
    recoveryPoints,
    recoveryGrade: null, // caller applies gradeRecoveryPoints(recoveryPoints) if recoveryPoints !== null
    consistencyPct,
    netCalories: Math.round(netCalories),
    adjustedCalories,
    epocCalories: Math.round(epocCalories),
    epocDurationHours: Math.round(epocDurationHours * 10) / 10,
    avgHr: Math.round(avgHr),
    peakHr: state.peakHr,
    avgPctMhr: Math.round(avgPctMhr * 10) / 10,
    zoneSeconds: state.zoneSeconds,
    zoneMinutes,
    intervalRecoveries60: state.intervalRecoveries60,
    finalRank: null, // caller sorts all members in the session by uvScore and assigns rank
    isPersonalBest: false, // caller compares against stored history — this accumulator only tracks pctMHR-based PB, exposed via allTimeBestPctMhr
    proposedMhr: state.peakHr > state.mhr ? state.peakHr : null,
    totalInterpolatedSeconds: state.totalInterpolatedSeconds,
    activeSeconds: Math.round(state.activeSeconds ?? 0),
  };
}

export { computeAdjustedCalories };
