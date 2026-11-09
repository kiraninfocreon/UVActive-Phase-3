import { recalcSessionMember, rejectOutliers, isPlausibleHr } from '../src/sessions/session-recalc.util';

const bio = { ageYears: 30, sex: 'male', heightCm: 175, weightKg: 75 };
const t0 = Date.UTC(2026, 10, 7, 10, 0, 0);
const at = (sec: number, hr: number) => ({ ts: new Date(t0 + sec * 1000), hr });

function steady(fromSec: number, toSec: number, hr: number) {
  const out = [];
  for (let s = fromSec; s <= toSec; s++) out.push(at(s, hr));
  return out;
}

describe('session recalculation hardening', () => {
  it('rejects physiologically impossible values', () => {
    expect(isPlausibleHr(0)).toBe(false);
    expect(isPlausibleHr(255)).toBe(false);
    expect(isPlausibleHr(25)).toBe(false);
    expect(isPlausibleHr(150)).toBe(true);
  });

  it('drops an isolated spike but keeps a genuine step change', () => {
    const spike = [...steady(0, 9, 140), at(10, 215), ...steady(11, 20, 141)];
    const cleaned = rejectOutliers(spike, 190);
    expect(cleaned.find((r) => r.hr === 215)).toBeUndefined();

    // A real jump that STAYS high is kept (the next reading agrees with it).
    const step = [...steady(0, 9, 120), ...steady(10, 20, 175)];
    expect(rejectOutliers(step, 190)).toHaveLength(step.length);
  });

  it('a single glitch does not move the peak HR or score', () => {
    const clean = steady(0, 600, 150);
    const glitched = [...clean.slice(0, 300), at(300, 238), ...clean.slice(301)];
    const a = recalcSessionMember(clean, bio);
    const b = recalcSessionMember(glitched, bio);
    expect(b.maxHr).toBe(a.maxHr);
    expect(b.rejectedCount).toBe(1);
    expect(b.sweatPoints).toBeCloseTo(a.sweatPoints!, 0);
  });

  it('calories use the member\'s ACTIVE time, not first-to-last timestamp', () => {
    // Trained 0-300s, left for 20 minutes, came back 1500-1800s.
    const split = [...steady(0, 300, 160), ...steady(1500, 1800, 160)];
    const continuous = steady(0, 600, 160); // same 10 minutes of real work
    const a = recalcSessionMember(split, bio);
    const b = recalcSessionMember(continuous, bio);
    // Each long gap contributes at most the capped 16s — never 20 minutes.
    expect(a.activeSeconds!).toBeLessThan(b.activeSeconds! + 40);
    expect(a.calories!).toBeLessThan(b.calories! * 1.15);
  });

  it('late joiners are scored over their own window', () => {
    const late = steady(1200, 1500, 150); // joined 20 minutes in, trained 5 minutes
    const r = recalcSessionMember(late, bio);
    expect(r.activeSeconds).toBeGreaterThanOrEqual(300);
    expect(r.activeSeconds).toBeLessThan(310);
  });
});
