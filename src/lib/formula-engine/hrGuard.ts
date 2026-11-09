/**
 * UV Active — live heart-rate glitch guard.
 *
 * A Polar strap that is re-seated, sweaty-dry, or briefly loses skin
 * contact can emit a single wild packet (0, 255, 210 while the member is
 * at 140…). Before this guard those went straight into processTick(), so
 * one packet could: jump the tile to Zone 5, mint a fake "peak HR", and
 * bank a second of Zone-5 sweat points. Real heart rate cannot move that
 * fast, so we filter on rate of change.
 *
 * Rules (deliberately conservative — a real, sustained change is never
 * suppressed for more than one reading):
 *   1. Impossible values (<30, >240, or >115% of the member's MHR) are
 *      rejected outright.
 *   2. A reading that differs from the last accepted one by more than
 *      ALLOWED_BASE + ALLOWED_PER_SECOND * dt is HELD, not applied.
 *   3. If the very next reading AGREES with the held one (a genuine step
 *      change — e.g. sprint start, or HR genuinely staying high), the
 *      step is accepted. If the next reading returns to baseline, the
 *      held reading was an isolated spike and is discarded.
 *   4. After a long silence (reconnect after a gap) there is no baseline
 *      to compare against, so the first reading is accepted as the new
 *      baseline.
 *
 * Pure: no timers, no I/O — see __tests__/hrGuard.test.ts.
 */

export const MIN_PLAUSIBLE_BPM = 30;
export const MAX_PLAUSIBLE_BPM = 240;
/** Max believable jump between adjacent readings = BASE + PER_SECOND * seconds-between. */
export const ALLOWED_BASE_BPM = 25;
export const ALLOWED_PER_SECOND_BPM = 6;
/** Silence longer than this means the last good reading is no longer a trustworthy baseline. */
export const BASELINE_STALE_MS = 20_000;

export interface GuardMemory {
  lastGoodBpm: number | null;
  lastGoodTs: number;
  /** A suspicious reading waiting for the next one to confirm or refute it. */
  pending: { ts: number; bpm: number } | null;
  /** Readings dropped as glitches — ops/QA only. */
  rejected: number;
}

export function newGuardMemory(seed?: { lastBpm?: number | null; lastTs?: number }): GuardMemory {
  return { lastGoodBpm: seed?.lastBpm ?? null, lastGoodTs: seed?.lastTs ?? 0, pending: null, rejected: 0 };
}

export type GuardVerdict = "accept" | "hold" | "reject";

function allowedJump(fromTs: number, toTs: number): number {
  const dt = Math.min(10, Math.max(1, Math.abs(toTs - fromTs) / 1000));
  return ALLOWED_BASE_BPM + ALLOWED_PER_SECOND_BPM * dt;
}

export function isPlausibleBpm(bpm: number, mhr: number): boolean {
  if (!Number.isFinite(bpm)) return false;
  if (bpm < MIN_PLAUSIBLE_BPM || bpm > MAX_PLAUSIBLE_BPM) return false;
  // Allow modest overshoot of an estimated MHR (the estimate can be well
  // under a fit member's true max) but not an absurd one.
  return bpm <= Math.max(mhr * 1.15, 130);
}

export interface GuardResult {
  verdict: GuardVerdict;
  memory: GuardMemory;
}

export function guardReading(memory: GuardMemory, tick: { ts: number; bpm: number }, mhr: number): GuardResult {
  if (!isPlausibleBpm(tick.bpm, mhr)) {
    return { verdict: "reject", memory: { ...memory, pending: null, rejected: memory.rejected + 1 } };
  }

  const baselineUsable = memory.lastGoodBpm !== null && memory.lastGoodTs > 0 && tick.ts - memory.lastGoodTs <= BASELINE_STALE_MS;
  if (!baselineUsable) {
    return { verdict: "accept", memory: { ...memory, lastGoodBpm: tick.bpm, lastGoodTs: tick.ts, pending: null } };
  }

  const jump = Math.abs(tick.bpm - (memory.lastGoodBpm as number));
  if (jump <= allowedJump(memory.lastGoodTs, tick.ts)) {
    // Back in line with baseline — if something was pending it was an isolated spike.
    const spikeDropped = memory.pending ? 1 : 0;
    return {
      verdict: "accept",
      memory: { ...memory, lastGoodBpm: tick.bpm, lastGoodTs: tick.ts, pending: null, rejected: memory.rejected + spikeDropped },
    };
  }

  // Big jump from baseline.
  if (memory.pending && Math.abs(tick.bpm - memory.pending.bpm) <= allowedJump(memory.pending.ts, tick.ts)) {
    // The next reading agrees with the held one → genuine step change.
    return { verdict: "accept", memory: { ...memory, lastGoodBpm: tick.bpm, lastGoodTs: tick.ts, pending: null } };
  }
  return { verdict: "hold", memory: { ...memory, pending: { ts: tick.ts, bpm: tick.bpm } } };
}
