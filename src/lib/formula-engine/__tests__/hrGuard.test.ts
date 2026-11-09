import { guardReading, newGuardMemory, isPlausibleBpm } from '../hrGuard';
import { createAccumulator, processTick, finalizeSummary, computeLiveCalories } from '../session';
import type { MemberProfile } from '../types';

const T0 = 1_700_000_000_000;
const MHR = 190;

function run(bpms: number[], startMs = T0) {
  let mem = newGuardMemory();
  const accepted: number[] = [];
  bpms.forEach((bpm, i) => {
    const r = guardReading(mem, { ts: startMs + i * 1000, bpm }, MHR);
    mem = r.memory;
    if (r.verdict === 'accept') accepted.push(bpm);
  });
  return { accepted, mem };
}

describe('hrGuard — impossible values', () => {
  it('rejects 0, 255 and values far above MHR', () => {
    expect(isPlausibleBpm(0, MHR)).toBe(false);
    expect(isPlausibleBpm(255, MHR)).toBe(false);
    expect(isPlausibleBpm(25, MHR)).toBe(false);
    expect(isPlausibleBpm(230, MHR)).toBe(false); // > 115% of a 190 MHR
    expect(isPlausibleBpm(150, MHR)).toBe(true);
  });
});

describe('hrGuard — spikes', () => {
  it('drops an isolated spike (strap re-seat) and keeps the surrounding data', () => {
    const { accepted, mem } = run([140, 141, 142, 205, 143, 144]);
    expect(accepted).toEqual([140, 141, 142, 143, 144]);
    expect(mem.rejected).toBe(1);
  });

  it('accepts a genuine, sustained step change after one confirming reading', () => {
    const { accepted } = run([120, 121, 122, 170, 171, 172]);
    // 170 is held, then 171 confirms the step → accepted; 170 itself is the only lost reading.
    expect(accepted).toEqual([120, 121, 122, 171, 172]);
  });

  it('a normal fast ramp (sprint start) is NOT suppressed', () => {
    const { accepted } = run([110, 118, 126, 134, 142, 150]);
    expect(accepted).toHaveLength(6);
  });

  it('treats the first reading after a long silence as a fresh baseline', () => {
    let mem = newGuardMemory({ lastBpm: 170, lastTs: T0 });
    const r = guardReading(mem, { ts: T0 + 5 * 60_000, bpm: 95 }, MHR); // came back after 5 min, resting
    expect(r.verdict).toBe('accept');
  });

  it('a glitch never reaches the accumulator: no fake peak HR, no Zone-5 sweat', () => {
    const profile: MemberProfile = { age: 30, sex: 'male', weightKg: 75, heightCm: 175, restingHr: 60, storedMhr: 190, sessionCount: 3 };
    let mem = newGuardMemory();
    let state = createAccumulator(profile, 'm');
    const feed = [145, 146, 147, 148, 188, 149, 150, 150, 151, 151, 152];
    feed.forEach((bpm, i) => {
      const ts = T0 + i * 1000;
      const g = guardReading(mem, { ts, bpm }, state.mhr);
      mem = g.memory;
      if (g.verdict === 'accept') state = processTick(state, { memberId: 'm', ts, bpm }, 'M').state;
    });
    expect(state.peakHr).toBeLessThan(160);
    expect(state.zoneSeconds[5]).toBe(0);
  });
});

describe('active-time scaling (late join / early leave)', () => {
  const profile: MemberProfile = { age: 30, sex: 'male', weightKg: 75, heightCm: 175, restingHr: 60, storedMhr: 190, sessionCount: 3 };

  function train(seconds: number) {
    let state = createAccumulator(profile, 'm');
    for (let s = 0; s < seconds; s++) state = processTick(state, { memberId: 'm', ts: T0 + s * 1000, bpm: 155 }, 'M').state;
    return state;
  }

  it('calories follow the member\'s own active seconds, not the session length', () => {
    const state = train(600); // trained 10 min of a 60-min session
    const asFullSession = finalizeSummary({ state: { ...state, activeSeconds: undefined }, durationHours: 1 }); // legacy path
    const scaled = finalizeSummary({ state, durationHours: 1 });
    expect(scaled.activeSeconds).toBe(600);
    expect(scaled.netCalories).toBeLessThan(asFullSession.netCalories / 4);
  });

  it('live calories converge on the final figure', () => {
    const state = train(900);
    expect(Math.round(computeLiveCalories(state))).toBe(finalizeSummary({ state, durationHours: 1 }).netCalories);
  });

  it('a member who never produced a reading gets 0 calories, never negative', () => {
    const state = createAccumulator(profile, 'ghost');
    expect(finalizeSummary({ state, durationHours: 1 }).netCalories).toBe(0);
    expect(computeLiveCalories(state)).toBe(0);
  });
});
