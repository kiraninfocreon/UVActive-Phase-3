/**
 * UV Active Member App — environment config.
 *
 * There is no hub IP to discover or configure anymore — the app talks
 * to one fixed cloud API base URL. Swap this for your actual deployed
 * API domain (and ideally move it to an EAS build-time env var —
 * `process.env.EXPO_PUBLIC_API_BASE_URL` — so staging/prod builds don't
 * require a code change).
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://uvactive-cloud-api.vercel.app/api/v1';

// BLE connection concurrency — see bleScanMediator.ts for why this
// exists at all (Android's real GATT ceiling, not an arbitrary limit).
// Configurable per-gym from Settings; hard-capped here regardless of
// what a trainer sets, since hardware not software is what breaks
// above this.
export const DEFAULT_MAX_CONCURRENT_SENSORS = 6;
export const HARD_MAX_CONCURRENT_SENSORS = 10;

// A sensor with no valid HR packet for this long is flagged stale in
// the UI — matches the threshold already used inside ble.ts.
export const STALE_HR_MS = 15_000;

// How often the sync queue flusher wakes up to check for pending rows
// and network availability. Also triggered immediately on network
// state transitioning offline → online (see syncQueue.ts) — this
// interval is the fallback, not the primary trigger.
export const SYNC_POLL_INTERVAL_MS = 10_000;

// Batch size per flush — matches the cloud API's IngestSensorReadingsDto,
// which accepts an array of readings per call. Keep this well under any
// reasonable request-body size limit; ticks are tiny (memberId, ts, hr).
export const SYNC_BATCH_SIZE = 200;
