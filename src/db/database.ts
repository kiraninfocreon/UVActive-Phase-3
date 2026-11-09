/**
 * UV Active Trainer App — local database.
 *
 * Real expo-sqlite (SDK 51+ async API), NOT AsyncStorage. The previous
 * app fell back to AsyncStorage after expo-sqlite crashed on a missing
 * native module — that was a dev-client/prebuild problem, not a reason
 * to avoid real SQLite. This file assumes a proper dev client / EAS
 * build (see app.json's "expo-sqlite" plugin entry); it will not work
 * inside plain Expo Go.
 *
 * WAL journal mode specifically protects against the failure mode that
 * matters most here: the app being killed mid-write during a live
 * session. Every write in this file is synchronous-in-the-write-path —
 * called directly from sessionEngine.ts's tick handler, never batched
 * and deferred — so a crash loses at most the one in-flight tick, never
 * the session.
 */
import * as SQLite from 'expo-sqlite';
import type { FinalSessionSummary, SessionAccumulatorState } from '../lib/formula-engine';

const DB_NAME = 'uvactive_trainer.db';

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await _db.execAsync('PRAGMA journal_mode = WAL;');
  await _db.execAsync('PRAGMA foreign_keys = ON;');
  await _migrate(_db);
  return _db;
}

async function _migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  // A single idempotent schema application — CREATE TABLE IF NOT EXISTS
  // throughout, safe to run on every app start.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id        TEXT PRIMARY KEY,
      section_id        TEXT,
      session_name      TEXT NOT NULL,
      trainer_id        TEXT NOT NULL,
      gym_id            TEXT NOT NULL,
      started_at        INTEGER,
      ended_at          INTEGER,
      scheduled_at      INTEGER,
      duration_seconds  INTEGER,
      status             TEXT NOT NULL DEFAULT 'scheduled',
      summary_json       TEXT,
      created_at         INTEGER NOT NULL,
      synced             INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_members (
      session_id     TEXT NOT NULL,
      member_id      TEXT NOT NULL,
      member_name    TEXT NOT NULL,
      sensor_device_id TEXT,
      avg_hr         REAL,
      peak_hr        REAL,
      calories       REAL,
      uv_score       REAL,
      zone_seconds_json TEXT,
      summary_json   TEXT,
      synced         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS ticks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL,
      member_id    TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      bpm          INTEGER NOT NULL,
      -- 1 when this row was synthesized by the sensor watchdog's
      -- gap-fill rather than read off the sensor (sessionEngine.ts /
      -- sensorWatchdog.ts). Ops/QA field only — the sync payload still
      -- sends it to the cloud API (see sessions.dto additions) but no
      -- member- or trainer-facing screen reads this column.
      interpolated INTEGER NOT NULL DEFAULT 0,
      synced       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ticks_session_member_ts
      ON ticks (session_id, member_id, ts);
    CREATE INDEX IF NOT EXISTS idx_ticks_unsynced
      ON ticks (synced) WHERE synced = 0;

    -- Every accumulator write persisted here too, keyed by session+member —
    -- this is what "resume a session after a crash/kill" rehydrates from,
    -- distinct from raw ticks (this is the derived running state, ticks
    -- are the immutable source-of-truth log).
    CREATE TABLE IF NOT EXISTS accumulator_state (
      session_id TEXT NOT NULL,
      member_id  TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, member_id)
    );

    -- Durable outbox — every cloud-bound write goes through here first.
    -- Only pruned after a confirmed 2xx from the cloud API.
    CREATE TABLE IF NOT EXISTS sync_queue (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      last_attempt_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sync_queue_created ON sync_queue (created_at);
  `);

  // CREATE TABLE IF NOT EXISTS is a no-op on an already-installed DB, so
  // it does NOT retroactively add the `interpolated` column to a ticks
  // table created by an older build. Patch it in explicitly, tolerating
  // "duplicate column" on every run after the first (SQLite has no
  // native ADD COLUMN IF NOT EXISTS).
  for (const stmt of [
    'ALTER TABLE ticks ADD COLUMN interpolated INTEGER NOT NULL DEFAULT 0;',
    // Per-member participation window (late join / early leave).
    'ALTER TABLE session_members ADD COLUMN joined_at INTEGER;',
    'ALTER TABLE session_members ADD COLUMN left_at INTEGER;',
  ]) {
    try {
      await db.execAsync(stmt);
    } catch (e: any) {
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
    }
  }
}

// ── Sessions ──────────────────────────────────────────────────────────

export interface LocalSessionRow {
  session_id: string;
  section_id: string | null;
  session_name: string;
  trainer_id: string;
  gym_id: string;
  started_at: number | null;
  ended_at: number | null;
  scheduled_at: number | null;
  duration_seconds: number | null;
  status: string;
  summary_json: string | null;
  created_at: number;
  synced: number;
}

export async function upsertSession(row: LocalSessionRow): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO sessions (session_id, section_id, session_name, trainer_id, gym_id, started_at, ended_at, scheduled_at, duration_seconds, status, summary_json, created_at, synced)
     VALUES ($session_id, $section_id, $session_name, $trainer_id, $gym_id, $started_at, $ended_at, $scheduled_at, $duration_seconds, $status, $summary_json, $created_at, $synced)
     ON CONFLICT(session_id) DO UPDATE SET
       section_id=excluded.section_id, session_name=excluded.session_name,
       started_at=excluded.started_at, ended_at=excluded.ended_at,
       scheduled_at=excluded.scheduled_at, duration_seconds=excluded.duration_seconds,
       status=excluded.status, summary_json=excluded.summary_json, synced=excluded.synced`,
    {
      $session_id: row.session_id, $section_id: row.section_id, $session_name: row.session_name,
      $trainer_id: row.trainer_id, $gym_id: row.gym_id, $started_at: row.started_at, $ended_at: row.ended_at,
      $scheduled_at: row.scheduled_at, $duration_seconds: row.duration_seconds, $status: row.status,
      $summary_json: row.summary_json, $created_at: row.created_at, $synced: row.synced,
    },
  );
}

export async function getSession(sessionId: string): Promise<LocalSessionRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<LocalSessionRow>('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
  return row ?? null;
}

/** Any session left in 'in_progress' with no ended_at — the "resume?" prompt on app relaunch (spec §4). */
export async function getResumableSessions(): Promise<LocalSessionRow[]> {
  const db = await getDb();
  return db.getAllAsync<LocalSessionRow>("SELECT * FROM sessions WHERE status = 'in_progress' AND ended_at IS NULL ORDER BY started_at DESC");
}

export async function listRecentSessions(limit = 50): Promise<LocalSessionRow[]> {
  const db = await getDb();
  return db.getAllAsync<LocalSessionRow>('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?', [limit]);
}

// ── Session members ──────────────────────────────────────────────────

export async function upsertSessionMember(
  sessionId: string,
  memberId: string,
  memberName: string,
  sensorDeviceId: string | null,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO session_members (session_id, member_id, member_name, sensor_device_id, synced)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(session_id, member_id) DO UPDATE SET member_name=excluded.member_name, sensor_device_id=excluded.sensor_device_id`,
    [sessionId, memberId, memberName, sensorDeviceId],
  );
}

/** Records when a member entered / left the live session (late join, early leave). Either bound may be null. */
export async function setSessionMemberWindow(sessionId: string, memberId: string, window: { joinedAt?: number | null; leftAt?: number | null }): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE session_members SET joined_at = COALESCE(?, joined_at), left_at = ? WHERE session_id=? AND member_id=?`,
    [window.joinedAt ?? null, window.leftAt ?? null, sessionId, memberId],
  );
}

export async function saveSessionMemberSummary(sessionId: string, memberId: string, summary: FinalSessionSummary): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE session_members SET avg_hr=?, peak_hr=?, calories=?, uv_score=?, zone_seconds_json=?, summary_json=?, synced=0
     WHERE session_id=? AND member_id=?`,
    [
      summary.avgHr, summary.peakHr, summary.netCalories, summary.uvScore,
      JSON.stringify(summary.zoneSeconds), JSON.stringify(summary),
      sessionId, memberId,
    ],
  );
}

export async function getSessionMembers(sessionId: string) {
  const db = await getDb();
  return db.getAllAsync('SELECT * FROM session_members WHERE session_id = ?', [sessionId]);
}

// ── Ticks (write-through, one row per BLE reading) ───────────────────

export async function insertTick(sessionId: string, memberId: string, ts: number, bpm: number, interpolated = false): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO ticks (session_id, member_id, ts, bpm, interpolated, synced) VALUES (?, ?, ?, ?, ?, 0)',
    [sessionId, memberId, ts, bpm, interpolated ? 1 : 0],
  );
}

export async function getUnsyncedTicks(limit = 200): Promise<{ id: number; session_id: string; member_id: string; ts: number; bpm: number; interpolated: number }[]> {
  const db = await getDb();
  return db.getAllAsync('SELECT id, session_id, member_id, ts, bpm, interpolated FROM ticks WHERE synced = 0 ORDER BY ts ASC LIMIT ?', [limit]);
}

export async function markTicksSynced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(`UPDATE ticks SET synced = 1 WHERE id IN (${placeholders})`, ids);
}

export async function getTicksForMember(sessionId: string, memberId: string): Promise<{ ts: number; bpm: number }[]> {
  const db = await getDb();
  return db.getAllAsync('SELECT ts, bpm FROM ticks WHERE session_id = ? AND member_id = ? ORDER BY ts ASC', [sessionId, memberId]);
}

// ── Accumulator state (crash-recovery rehydration) ───────────────────

export async function saveAccumulatorState(sessionId: string, memberId: string, state: SessionAccumulatorState): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO accumulator_state (session_id, member_id, state_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, member_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`,
    [sessionId, memberId, JSON.stringify(state), Date.now()],
  );
}

export async function loadAccumulatorStates(sessionId: string): Promise<Map<string, SessionAccumulatorState>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ member_id: string; state_json: string }>(
    'SELECT member_id, state_json FROM accumulator_state WHERE session_id = ?',
    [sessionId],
  );
  const map = new Map<string, SessionAccumulatorState>();
  for (const row of rows) {
    try {
      map.set(row.member_id, JSON.parse(row.state_json));
    } catch {
      // Corrupt row — skip it rather than crash the resume flow; that
      // member's accumulator starts fresh, which is a lesser loss than
      // blocking the whole session from resuming.
    }
  }
  return map;
}

// ── Sync queue (durable outbox) ──────────────────────────────────────

export async function enqueueSync(entityType: string, entityId: string, payload: unknown): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO sync_queue (entity_type, entity_id, payload_json, created_at, attempts) VALUES (?, ?, ?, ?, 0)',
    [entityType, entityId, JSON.stringify(payload), Date.now()],
  );
}

export interface SyncQueueRow {
  id: number;
  entity_type: string;
  entity_id: string;
  payload_json: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
}

export async function getPendingSync(limit = 50): Promise<SyncQueueRow[]> {
  const db = await getDb();
  return db.getAllAsync<SyncQueueRow>('SELECT * FROM sync_queue ORDER BY created_at ASC LIMIT ?', [limit]);
}

export async function removeSyncRow(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM sync_queue WHERE id = ?', [id]);
}

export async function markSyncAttempt(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE sync_queue SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE id = ?', [error, Date.now(), id]);
}

export async function getSyncQueueDepth(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) as n FROM sync_queue');
  return row?.n ?? 0;
}
