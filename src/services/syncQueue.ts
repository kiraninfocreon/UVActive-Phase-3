/**
 * Sync queue flusher.
 *
 * Drains database.ts's `sync_queue` table (the durable outbox — every
 * cloud-bound write lands there first, from sessionEngine.ts, never
 * posted to the API directly from the hot tick path). This file is the
 * ONLY thing that talks to the cloud API for session data; it runs
 * whenever the network is up, on its own schedule, and is completely
 * decoupled from whether a session is currently live.
 *
 * A tick row is a special case: rather than one sync_queue row per
 * tick (which would be a lot of tiny rows during a live session), raw
 * ticks are read directly from the `ticks` table's `synced = 0` rows
 * and batched — see flushTicks() below. Everything else (session
 * create/end, member enroll, etc.) goes through the generic
 * sync_queue path.
 */
import { sessionsApi, toEndSessionResult } from './sessionsApi';
import { ApiError } from './api';
import {
  getPendingSync, removeSyncRow, markSyncAttempt,
  getUnsyncedTicks, markTicksSynced, upsertSession, getSession,
  type SyncQueueRow,
} from '../db/database';
import { isOnline, addNetworkListener } from './networkStatus';
import { SYNC_BATCH_SIZE, SYNC_POLL_INTERVAL_MS } from '../config';
import type { FinalSessionSummary } from '../lib/formula-engine';
import * as SecureStore from 'expo-secure-store';

const LAST_SYNCED_KEY = 'uva_last_synced_at_v1';

type SyncListener = (state: { flushing: boolean; queueDepth: number; lastError: string | null; lastSyncedAtMs: number | null }) => void;
const listeners = new Set<SyncListener>();
let _lastError: string | null = null;
let _flushing = false;
let _lastSyncedAtMs: number | null = null;

// Rehydrate the persisted last-sync time as soon as this module loads,
// so the Settings screen shows something meaningful even before the
// first flush of this app session completes.
SecureStore.getItemAsync(LAST_SYNCED_KEY)
  .then((raw) => { if (raw) _lastSyncedAtMs = Number(raw) || null; })
  .catch(() => {});

export function addSyncListener(fn: SyncListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Snapshot for screens that just need a one-off read (e.g. Settings on mount) rather than a live subscription. */
export function getSyncState() {
  return { flushing: _flushing, lastError: _lastError, lastSyncedAtMs: _lastSyncedAtMs };
}

function notify(queueDepth: number) {
  for (const fn of listeners) fn({ flushing: _flushing, queueDepth, lastError: _lastError, lastSyncedAtMs: _lastSyncedAtMs });
}

let _timer: ReturnType<typeof setInterval> | null = null;
let _unsubscribeNetwork: (() => void) | null = null;

export function startSyncQueue() {
  if (_timer) return;
  _timer = setInterval(() => { flushAll().catch(() => {}); }, SYNC_POLL_INTERVAL_MS);
  _unsubscribeNetwork = addNetworkListener((online) => {
    if (online) flushAll().catch(() => {});
  });
  flushAll().catch(() => {});
}

export function stopSyncQueue() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _unsubscribeNetwork?.();
  _unsubscribeNetwork = null;
}

export async function flushAll(): Promise<void> {
  if (_flushing) return; // one flush at a time — a second trigger while one's in flight just no-ops
  if (!(await isOnline())) return;

  _flushing = true;
  notify(await pendingCount());
  try {
    await flushTicks();
    await flushQueue();
    if (!_lastError) {
      _lastSyncedAtMs = Date.now();
      SecureStore.setItemAsync(LAST_SYNCED_KEY, String(_lastSyncedAtMs)).catch(() => {});
    }
  } finally {
    _flushing = false;
    notify(await pendingCount());
  }
}

/**
 * Settings screen's manual "Sync to Cloud" button — same underlying
 * flush as the automatic background one, just with a result the UI can
 * show immediately instead of waiting on the next poll tick.
 */
export async function syncNow(): Promise<{ ok: boolean; message: string }> {
  if (!(await isOnline())) return { ok: false, message: 'No internet connection.' };
  await flushAll();
  if (_lastError) return { ok: false, message: _lastError };
  return { ok: true, message: 'Synced.' };
}

// ── Raw ticks — batched straight from the ticks table ────────────────

async function flushTicks(): Promise<void> {
  // Loop until a batch comes back empty — a long offline stretch can
  // leave far more than one batch's worth queued up.
  for (;;) {
    const rows = await getUnsyncedTicks(SYNC_BATCH_SIZE);
    if (rows.length === 0) return;

    // Group by session — the ingest endpoint is per-session.
    const bySession = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = bySession.get(row.session_id) ?? [];
      list.push(row);
      bySession.set(row.session_id, list);
    }

    for (const [sessionId, sessionRows] of bySession) {
      try {
        await sessionsApi.ingestReadings(
          sessionId,
          sessionRows.map((r) => ({ memberId: r.member_id, ts: new Date(r.ts).toISOString(), hr: r.bpm, interpolated: !!r.interpolated })),
        );
        await markTicksSynced(sessionRows.map((r) => r.id));
        _lastError = null;
      } catch (e) {
        // A session that's been deleted/cancelled server-side (404) would
        // otherwise wedge the queue forever retrying the same batch —
        // treat that specific case as "nothing more to sync for this
        // session" rather than a retry-worthy failure.
        if (e instanceof ApiError && e.status === 404) {
          await markTicksSynced(sessionRows.map((r) => r.id));
          continue;
        }
        _lastError = e instanceof Error ? e.message : 'Sync failed';
        notify(await pendingCount());
        return; // stop this pass — next poll/online-event tries again
      }
    }
    notify(await pendingCount());
  }
}

// ── Generic sync_queue (session lifecycle events) ────────────────────

async function flushQueue(): Promise<void> {
  for (;;) {
    const rows = await getPendingSync(20);
    if (rows.length === 0) return;

    for (const row of rows) {
      const ok = await processSyncRow(row);
      if (!ok) {
        notify(await pendingCount());
        return; // preserve order — don't skip ahead of a failed row
      }
      await removeSyncRow(row.id);
    }
    notify(await pendingCount());
  }
}

async function processSyncRow(row: SyncQueueRow): Promise<boolean> {
  try {
    const payload = JSON.parse(row.payload_json);
    switch (row.entity_type) {
      case 'session_create': {
        // payload.id is the same value as row.entity_id (sessionEngine.ts
        // sends its local id as the create request's id), so the cloud
        // row's real id already matches the local one — this just marks
        // the existing row synced, it's not reconciling two different
        // ids. See CreateSessionDto.id on the cloud side for why a
        // client-supplied id is used instead of a server-generated one.
        const remote = await sessionsApi.create(payload);
        const local = await getSession(row.entity_id);
        if (local) await upsertSession({ ...local, session_id: remote.id, synced: 1 });
        break;
      }
      case 'session_start':
        await sessionsApi.start(row.entity_id);
        break;
      case 'session_end': {
        const summaries = payload as FinalSessionSummary[];
        await sessionsApi.end(row.entity_id, summaries.map(toEndSessionResult));
        break;
      }
      case 'session_cancel':
        await sessionsApi.cancel(row.entity_id, payload.reason ?? 'Cancelled');
        break;
      case 'member_enroll':
        await sessionsApi.enrollMember(row.entity_id, payload.memberId);
        break;
      case 'member_absent':
        // Maps directly onto the existing attendance endpoint — no new
        // cloud route needed. See sessionEngine.ts's markAbsent().
        await sessionsApi.setAttendance(row.entity_id, payload.memberId, 'no_show');
        break;
      default:
        // Unknown entity type — drop it rather than retry forever;
        // this only happens if an older app version queued something
        // a newer version doesn't recognize.
        return true;
    }
    _lastError = null;
    return true;
  } catch (e) {
    // 404 — target already gone server-side, nothing to retry.
    // 409 — the offline outbox replayed something the server already
    // applied (e.g. enrollMember() after a response was lost to a
    // dropped connection); the cloud API returns Conflict for
    // "already enrolled" precisely because that's the correct answer
    // to a genuinely new duplicate request, but from a retry it means
    // "already done" and must not jam the rest of the queue behind it.
    if (e instanceof ApiError && (e.status === 404 || e.status === 409)) return true;
    _lastError = e instanceof Error ? e.message : 'Sync failed';
    await markSyncAttempt(row.id, _lastError);
    return false;
  }
}

async function pendingCount(): Promise<number> {
  const [ticks, queue] = await Promise.all([getUnsyncedTicks(1), getPendingSync(1)]);
  // Cheap approximation for the UI badge — exact count isn't worth a
  // second round-trip on every notify(); "0 vs not-0" is what the
  // Live Session screen's "syncing" indicator actually needs.
  return ticks.length + queue.length;
}
