import type { Workout } from '../services/memberApi';

export const pts = (w: Workout) => Math.round(w.sweatPoints ?? w.score ?? 0);
export const when = (w: Workout) => w.session.endedAt ?? w.session.startedAt ?? w.session.scheduledAt ?? null;

export function isDone(w: Workout) {
  return w.session.status === 'completed' && w.attendance !== 'no_show' && w.attendance !== 'absent';
}
export const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function fmtDate(iso?: string | null, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return withTime ? `${date} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : date;
}
