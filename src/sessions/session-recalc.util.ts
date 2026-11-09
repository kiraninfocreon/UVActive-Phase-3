import {
  estimateMhr, computePctMhr, computeZone, sweatPointsTick, computeEpocKcal,
  grossCaloriesKeytel, harrisBenedictBmr, gradeRecoveryPoints,
} from '../common/hr.util';

export interface RecalcReadingInput {
  ts: Date;
  hr: number;
}

export interface RecalcMemberBio {
  ageYears: number | null;
  sex: string | null;
  heightCm: number | null;
  weightKg: number | null;
}

export interface RecalcResult {
  avgHr: number | null;
  maxHr: number | null;
  calories: number | null;
  zoneMinutes: Record<string, number> | null;
  sweatPoints: number | null;
  recoveryPoints: number | null;
  recoveryGrade: string | null;
  epocCalories: number | null;
  epocHours: number | null;
  avgPctMhr: number | null;
  maxPctMhr: number | null;
  score: number | null;
  readingCount: number;
  /** Seconds actually scored for this member (sum of per-reading elapsed, gaps capped) — the member's own active window. */
  activeSeconds: number | null;
  /** Readings dropped as physiologically implausible or as isolated spikes. */
  rejectedCount: number;
}

// A gap this large means the sensor was off/disconnected between ticks
// (trainer paused, member stepped away, sync jitter) — never credit
// zone-seconds across a gap that size.
//
// IMPORTANT: this used to be 5s, mirroring the Trainer App's live
// per-tick cadence back when every real BLE reading (~1/sec) got a
// `ticks`/`sensor_readings` row. As of the adaptive tick-storage filter
// (Trainer App's tickStorageFilter.ts), the Trainer App now only
// PERSISTS a reading when >=15s has passed since the last stored point
// OR bpm moved >=4bpm — so a completely ordinary, fully-connected,
// steady-state stretch can legitimately show up here as a ~15s gap
// between two stored readings. A 5s cap would silently undercount that
// member's zone-seconds/sweatPoints/calories by up to ~66% during any
// steady block, on every recompute. 16s (the filter's 15s cap + a
// second of slack for clock/network jitter) is the new ceiling: any
// GENUINE dropout is still bridged by sensorWatchdog.ts's ~1/sec
// interpolated fill ticks, which are exempt from the storage filter and
// always land at full density — so a stored gap actually exceeding this
// window still means "was truly disconnected", exactly as before.
const MAX_TICK_GAP_SECONDS = 16;

// Recovery-Points reconstruction: the Trainer App's dedicated recovery
// challenge (peak HR -> HR 60s later, standing still) requires a UI
// flow this dataset may never have gone through. Instead, reconstruct
// the same PDF-page-4 formula from whatever the session's natural peak
// and post-peak cool-down actually looked like: find the session's
// highest BPM tick, then the reading closest to 60s after it. Only
// fires when a real reading exists in that window — never invents one.
const RECOVERY_WINDOW_MIN_MS = 45_000;
// Upper bound is deliberately wider than the raw 60s spec: the Trainer
// App's adaptive tick-storage filter only persists a reading when >=15s
// has passed OR bpm moved >=4bpm, so a smooth, steady cool-down can
// legitimately have NO stored reading inside a strict 45-90s window —
// which left recoveryPoints null (later zero-filled to 0) for exactly
// the members who cooled down cleanly. The candidate choice still picks
// the reading NEAREST 60s after the peak, so widening the net never
// pulls the figure further from the spec — it only rescues sessions
// that would otherwise get no recovery figure at all.
const RECOVERY_WINDOW_MAX_MS = 120_000;
const RECOVERY_WINDOW_TARGET_MS = 60_000;

/**
 * Recomputes every rich post-workout field for one session-member from
 * their raw SensorReading log — used by the Recalculate feature
 * (Branch Portal / Admin Panel / Trainer App buttons) to backfill
 * sessions that synced with sweatPoints/recoveryPoints/epoc/maxPctMhr
 * null or zero, and to re-run the same math after a formula fix.
 * Pure function — the caller persists the result.
 */
export function recalcSessionMember(readings: RecalcReadingInput[], bio: RecalcMemberBio): RecalcResult {
  if (readings.length === 0) {
    return {
      avgHr: null, maxHr: null, calories: null, zoneMinutes: null, sweatPoints: null,
      recoveryPoints: null, recoveryGrade: null, epocCalories: null, epocHours: null,
      avgPctMhr: null, maxPctMhr: null, score: null, readingCount: 0, activeSeconds: null, rejectedCount: 0,
    };
  }

  const mhr = estimateMhr(bio.ageYears, bio.sex);
  const ordered = [...readings].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  // Strap glitches / isolated spikes must not feed peak HR, zone time or
  // sweat points — see rejectOutliers().
  const sorted = rejectOutliers(ordered, mhr);
  const rejectedCount = ordered.length - sorted.length;
  if (sorted.length === 0) {
    return {
      avgHr: null, maxHr: null, calories: null, zoneMinutes: null, sweatPoints: null,
      recoveryPoints: null, recoveryGrade: null, epocCalories: null, epocHours: null,
      avgPctMhr: null, maxPctMhr: null, score: null, readingCount: 0, activeSeconds: null, rejectedCount,
    };
  }

  const zoneSeconds: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  let sweatPoints = 0;
  let hrSum = 0;
  let maxHr = 0;
  let maxPctMhr = 0;
  let lastTs: number | null = null;
  let activeSeconds = 0;

  for (const r of sorted) {
    const pctMhr = computePctMhr(r.hr, mhr);
    const zone = computeZone(pctMhr);

    const elapsed = lastTs === null ? 1 : Math.max(0, Math.min(MAX_TICK_GAP_SECONDS, Math.round((r.ts.getTime() - lastTs) / 1000)));
    lastTs = r.ts.getTime();
    activeSeconds += elapsed;

    if (zone > 0) zoneSeconds[zone] += elapsed;
    sweatPoints += sweatPointsTick(pctMhr, zone) * elapsed;

    hrSum += r.hr;
    if (r.hr > maxHr) maxHr = r.hr;
    if (pctMhr > maxPctMhr) maxPctMhr = pctMhr;
  }

  const avgHr = hrSum / sorted.length;
  const avgPctMhr = computePctMhr(avgHr, mhr);
  const zoneMinutes = { '1': zoneSeconds[1] / 60, '2': zoneSeconds[2] / 60, '3': zoneSeconds[3] / 60, '4': zoneSeconds[4] / 60, '5': zoneSeconds[5] / 60 };

  const weightKg = bio.weightKg ?? 70;
  const { epocCalories, epocHours } = computeEpocKcal(zoneMinutes['4'], zoneMinutes['5'], weightKg);

  // Calories need height + weight + age + sex on file — skip (null,
  // left untouched by the caller) rather than silently burning a
  // guessed BMI into a member's historical record.
  let calories: number | null = null;
  if (bio.heightCm != null && bio.weightKg != null && bio.ageYears != null) {
    // The member's OWN active time (gaps capped) — NOT last-minus-first
    // timestamp: a member who left for ten minutes and came back, or who
    // joined late, must not be credited calories for time they were away.
    const durationHours = activeSeconds / 3600;
    const gross = grossCaloriesKeytel(avgHr, bio.weightKg, bio.ageYears, bio.sex, durationHours);
    const bmr = harrisBenedictBmr(bio.weightKg, bio.heightCm, bio.ageYears, bio.sex);
    const resting = (bmr / 24) * durationHours;
    calories = Math.max(0, Math.round(gross - resting));
  }

  // Peak-to-cooldown recovery reconstruction (see comment above).
  let recoveryPoints: number | null = null;
  let recoveryGrade: string | null = null;
  const peakIdx = sorted.reduce((best, r, i) => (r.hr > sorted[best].hr ? i : best), 0);
  const peakTs = sorted[peakIdx].ts.getTime();
  const peakHrValue = sorted[peakIdx].hr;
  let closest: { r: RecalcReadingInput; delta: number } | null = null;
  for (const r of sorted) {
    const dt = r.ts.getTime() - peakTs;
    if (dt < RECOVERY_WINDOW_MIN_MS || dt > RECOVERY_WINDOW_MAX_MS) continue;
    const delta = Math.abs(dt - RECOVERY_WINDOW_TARGET_MS);
    if (!closest || delta < closest.delta) closest = { r, delta };
  }
  if (closest) {
    const drop = peakHrValue - closest.r.hr;
    recoveryPoints = drop;
    recoveryGrade = gradeRecoveryPoints(drop);
  }

  const sweatPointsRounded = Math.round(sweatPoints * 10) / 10;
  const score = Math.round(sweatPointsRounded + (recoveryPoints ?? 0));

  return {
    avgHr: Math.round(avgHr),
    maxHr,
    calories,
    zoneMinutes: { '1': zoneSeconds[1] / 60, '2': zoneSeconds[2] / 60, '3': zoneSeconds[3] / 60, '4': zoneSeconds[4] / 60, '5': zoneSeconds[5] / 60 },
    sweatPoints: sweatPointsRounded,
    recoveryPoints,
    recoveryGrade,
    epocCalories: Math.round(epocCalories),
    epocHours: Math.round(epocHours * 10) / 10,
    avgPctMhr: Math.round(avgPctMhr * 10) / 10,
    maxPctMhr: Math.round(maxPctMhr * 10) / 10,
    score,
    readingCount: sorted.length,
    activeSeconds,
    rejectedCount,
  };
}

// ── Plausibility / spike filtering ─────────────────────────────────────

/** A single reading outside this band is a sensor glitch, never a real heart rate. */
export const MIN_PLAUSIBLE_HR = 30;
export const MAX_PLAUSIBLE_HR = 240;
export function isPlausibleHr(hr: number): boolean {
  return Number.isFinite(hr) && hr >= MIN_PLAUSIBLE_HR && hr <= MAX_PLAUSIBLE_HR;
}

// A heart rate can legitimately climb ~5 bpm/s at the start of a sprint;
// anything beyond this base + per-second allowance between two adjacent
// readings is suspicious.
const SPIKE_BASE_BPM = 25;
const SPIKE_PER_SECOND_BPM = 6;

/**
 * Drops (a) implausible values and (b) ISOLATED spikes — a reading that
 * jumps away from BOTH its neighbours by more than the allowed rate
 * while the neighbours agree with each other. A genuine step change
 * (e.g. HR stays high after a jump) is kept, because the next reading
 * agrees with it; only the one-off glitch (a strap re-seating, a
 * dropped-contact packet) is removed. Pure and deterministic, so a
 * Recalculate always yields the same figures.
 */
export function rejectOutliers(sorted: RecalcReadingInput[], mhr: number): RecalcReadingInput[] {
  const ceiling = Math.min(MAX_PLAUSIBLE_HR, Math.max(mhr * 1.15, 120));
  const plausible = sorted.filter((r) => isPlausibleHr(r.hr) && r.hr <= ceiling);
  if (plausible.length < 3) return plausible;

  const allowed = (a: RecalcReadingInput, b: RecalcReadingInput) =>
    SPIKE_BASE_BPM + SPIKE_PER_SECOND_BPM * Math.max(1, Math.abs(b.ts.getTime() - a.ts.getTime()) / 1000);

  const out: RecalcReadingInput[] = [plausible[0]];
  for (let i = 1; i < plausible.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = plausible[i];
    const next = plausible[i + 1];
    const jumpsFromPrev = Math.abs(cur.hr - prev.hr) > allowed(prev, cur);
    const jumpsToNext = Math.abs(cur.hr - next.hr) > allowed(cur, next);
    const neighboursAgree = Math.abs(prev.hr - next.hr) <= allowed(prev, next);
    if (jumpsFromPrev && jumpsToNext && neighboursAgree) continue; // isolated spike
    out.push(cur);
  }
  out.push(plausible[plausible.length - 1]);
  return out;
}
