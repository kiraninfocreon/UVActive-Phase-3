/**
 * UV Active — Polar BLE Service v4.0 (multi-connectivity fix)
 *
 * Architecture:
 *  - Manages MULTIPLE concurrent Polar sensor connections, one per
 *    PolarDevice instance.
 *  - Discovery is mediated through bleScanMediator: a single physical scan
 *    runs at a time and fans discovery events out to every sensor still
 *    looking for its target. Previously each PolarDevice called
 *    BleManager.startDeviceScan()/stopDeviceScan() directly, which only
 *    supports one active callback — with 2+ sensors this caused scan
 *    collisions that surfaced as random disconnects. See
 *    services/bleScanMediator.ts for the full explanation.
 *  - GATT connect() calls are staggered via connectSerialized() to avoid
 *    Android radio contention when several peripherals connect close
 *    together.
 *  - All HR data forwarded to sessionEngine via the existing global
 *    status-listener mechanism (addGlobalBLEListener) — no direct hub
 *    coupling. sessionEngine.ts is the consumer that turns these events
 *    into formula-engine ticks + SQLite writes + cloud sync entries.
 *  - Tracks per-device packet stats and a "stale" flag — no valid HR
 *    packet for 15s while still BLE-connected — so the Sensors tab can
 *    show this distinctly from a full disconnect.
 *
 * Polar GATT standard services:
 *  Heart Rate Service    : 0000180d-0000-1000-8000-00805f9b34fb
 *  HR Measurement Char   : 00002a37-0000-1000-8000-00805f9b34fb  (notify)
 *  Battery Service       : 0000180f-0000-1000-8000-00805f9b34fb
 *  Battery Level Char    : 00002a19-0000-1000-8000-00805f9b34fb  (read)
 */

import { MIN_PLAUSIBLE_BPM, MAX_PLAUSIBLE_BPM } from '../lib/formula-engine/hrGuard';
import { State, type Device, type Subscription } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import { bleScanMediator, getSharedManager, destroySharedManager } from './bleScanMediator';

// ── Polar Standard GATT UUIDs ─────────────────────────────────────────
const HR_SERVICE      = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_CHAR         = '00002a37-0000-1000-8000-00805f9b34fb';
const BAT_SERVICE     = '0000180f-0000-1000-8000-00805f9b34fb';
const BAT_CHAR        = '00002a19-0000-1000-8000-00805f9b34fb';

const SCAN_TIMEOUT_MS     = 30_000;
// Reconnect backoff — was a flat 5s retry forever, which meant a sensor
// that's genuinely out of range (or dead battery) hammered scan/connect
// every 5s indefinitely. That churn adds radio contention that can affect
// OTHER already-connected sensors, and shows up to the trainer as "keeps
// disconnecting" even for a single sensor. Capped at 10s per the field
// review — short enough that a real reconnect (sensor back in range) still
// feels fast, long enough that a persistently-missing sensor backs off.
const RECONNECT_BACKOFF_MS = [2_000, 4_000, 8_000, 10_000];
const BATTERY_POLL_MS     = 60_000;
const RSSI_POLL_MS        =  4_000;  // live signal-strength refresh while connected
const CONNECT_TIMEOUT_MS  = 15_000;
const STALE_HR_MS         = 15_000;  // no valid packet for this long while connected → "stale"
const STALE_CHECK_MS      =  2_000;  // how often to re-check staleness

// ── Types ─────────────────────────────────────────────────────────────

export type DeviceConnectionState =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'discovering'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface PolarDeviceStatus {
  deviceId:        string;       // user-entered ID from sensor label
  bleAddress:      string;       // actual BT MAC/UUID discovered
  deviceName:      string;       // e.g. "Polar H10 XXXXXXXX"
  state:           DeviceConnectionState;
  hr:              number;       // latest HR bpm, 0 if none
  battery:         number;       // 0-100, -1 if unknown
  rrIntervals:     number[];     // last RR intervals in ms
  error:           string | null;
  lastHeardMs:     number;       // Date.now() of last HR packet
  totalReadings:   number;       // packet count since connect
  isStale:         boolean;      // connected, but no packet for STALE_HR_MS
  reconnectCount:  number;
  rssi:            number | null; // live signal strength in dBm, polled while connected; null if unknown/not yet read
  /**
   * Skin-contact flag from the HR Measurement packet (bits 1-2 of the
   * flags byte). true = strap reports contact, false = strap says it is
   * OFF the body (its HR value is meaningless — often a stale or wild
   * number), null = this sensor doesn't report contact. The session
   * engine ignores readings while this is false so a strap sitting on a
   * bench can't keep feeding a departed member's tile.
   */
  contact:         boolean | null;
}

/**
 * Convert a BLE RSSI reading (dBm) to a 0-4 bar signal strength for display.
 * Thresholds per the gym-floor field review: stronger than -60 dBm is a
 * clean link, -60 to -75 is usable but worth watching, weaker than -75 is
 * at real risk of dropping before the 15s stale threshold triggers.
 *   null/unknown → 0 bars ("--")
 *   <= -85        → 1 bar  (weak)
 *   <= -75        → 2 bars (weak-fair)
 *   <= -60        → 3 bars (fair-good)
 *   >  -60        → 4 bars (strong)
 */
export function rssiToBars(rssi: number | null | undefined): 0 | 1 | 2 | 3 | 4 {
  if (rssi === null || rssi === undefined) return 0;
  if (rssi <= -85) return 1;
  if (rssi <= -75) return 2;
  if (rssi <= -60) return 3;
  return 4;
}

export function rssiToLabel(rssi: number | null | undefined): 'unknown' | 'weak' | 'fair' | 'strong' {
  const bars = rssiToBars(rssi);
  if (bars === 0) return 'unknown';
  if (bars === 1) return 'weak';
  if (bars <= 3) return 'fair';
  return 'strong';
}

export type PolarStatusListener = (deviceId: string, status: PolarDeviceStatus) => void;

// ── BT power state ───────────────────────────────────────────────────
let _bleReady = false;
let _permissionsGranted = false;
let _lastPermissionError: string | null = null;

export function getLastPermissionError(): string | null {
  return _lastPermissionError;
}

// ── Per-device connection instances ──────────────────────────────────

class PolarDevice {
  readonly targetId: string;          // user-entered device ID
  private _bleDevice: Device | null = null;
  // The physical device id this target currently holds an exclusive claim
  // on in bleScanMediator (see requestScan's onFound below). Tracked
  // separately from _bleDevice because the claim needs releasing even at
  // points where _bleDevice was never set (e.g. connect() itself timed
  // out) or has already been nulled out (post-disconnect cleanup).
  private _claimedDeviceId: string | null = null;
  private _hrSub: Subscription | null = null;
  private _disconnectSub: Subscription | null = null;
  private _batteryTimer: ReturnType<typeof setInterval>  | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _scanTimer: ReturnType<typeof setTimeout>      | null = null;
  private _connectTimer: ReturnType<typeof setTimeout>   | null = null;
  private _staleTimer: ReturnType<typeof setInterval>    | null = null;
  private _connectedAtMs = 0;
  // Backoff step for reconnect scheduling (separate from status.reconnectCount,
  // which is a lifetime counter shown to the trainer and must keep counting up
  // across successful reconnects). Reset to 0 whenever a connection succeeds.
  private _backoffAttempt = 0;
  private _shouldRun = false;
  private _listeners = new Set<PolarStatusListener>();
  private _rssiTimer: ReturnType<typeof setInterval> | null = null;
  // Connect attempt-token. Every _connect() entry, reconnect schedule and
  // stop() bumps this. Each async continuation inside _connect() captures
  // the token at entry and re-checks it before touching state — so a
  // connect that resolves AFTER a newer attempt (or a stop) already took
  // over can never clobber it. Previously a late-resolving connect could
  // call connect() on a device a second scan had already claimed, which
  // caused GATT double-connect instability that read as random errors /
  // "keeps disconnecting" with a real sensor.
  private _connectAttempt = 0;

  status: PolarDeviceStatus;

  constructor(deviceId: string) {
    this.targetId = deviceId;
    this.status = {
      deviceId, bleAddress: '', deviceName: '',
      state: 'idle', hr: 0, battery: -1,
      rrIntervals: [], error: null, lastHeardMs: 0,
      totalReadings: 0, isStale: false, reconnectCount: 0, rssi: null, contact: null,
    };
  }

  addListener(fn: PolarStatusListener) {
    this._listeners.add(fn);
    fn(this.targetId, { ...this.status });
    return () => this._listeners.delete(fn);
  }

  /**
   * Broadcast a status change to this device's listeners AND the global
   * listeners (sessionEngine + screens). Each listener is invoked inside
   * its own try/catch: a throwing consumer (a screen, sessionEngine, a
   * stale subscription) must never be able to (a) escape into the native
   * BLE callback stack — the exact class of uncaught-error crash behind
   * "Something went wrong" appearing right after a real sensor connects —
   * or (b) starve the other listeners of this update.
   */
  private _emit(patch: Partial<PolarDeviceStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of Array.from(this._listeners)) {
      try { fn(this.targetId, { ...this.status }); }
      catch (e) { console.warn(`[BLE][${this.targetId}] listener threw:`, e); }
    }
    for (const fn of Array.from(_globalListeners)) {
      try { fn(this.targetId, { ...this.status }); }
      catch (e) { console.warn(`[BLE][${this.targetId}] global listener threw:`, e); }
    }
  }

  async start() {
    this._shouldRun = true;
    this._backoffAttempt = 0;
    this._emit({ state: 'idle', error: null, hr: 0, totalReadings: 0, isStale: false });
    await this._startScan();
  }

  stop(notifyHub = true) {
    this._shouldRun = false;
    this._connectAttempt++; // invalidate any in-flight connect continuation
    this._clearTimers();
    bleScanMediator.cancelScan(this.targetId);
    bleScanMediator.releaseConnectionSlot(this.targetId);
    bleScanMediator.releaseDeviceClaim(this._claimedDeviceId, this.targetId);
    this._claimedDeviceId = null;
    if (this._hrSub)        { try { this._hrSub.remove();        } catch {} this._hrSub = null; }
    if (this._disconnectSub){ try { this._disconnectSub.remove();} catch {} this._disconnectSub = null; }
    if (this._bleDevice) {
      // notifyHub kept as a param name for minimal diff — there's no hub
      // to notify anymore, this is a no-op branch retained for callers
      // that still pass it.
      try { this._bleDevice.cancelConnection(); } catch {}
      this._bleDevice = null;
    }
    this._connectedAtMs = 0;
    this._emit({ state: 'disconnected', hr: 0, rrIntervals: [], isStale: false, rssi: null });
  }

  private async _startScan() {
    if (!this._shouldRun) return;
    if (!_bleReady) {
      this._emit({ state: 'error', error: 'Bluetooth is off — enable Bluetooth and try again.' });
      return;
    }

    this._emit({ state: 'scanning', error: null });
    console.log(`[BLE][${this.targetId}] Scanning (mediated)…`);

    // Scan timeout — auto retry. This only unsubscribes THIS target from
    // the shared scan; it never touches the native scan call directly, so
    // it can't disrupt other sensors that are still looking.
    this._scanTimer = setTimeout(() => {
      if (!bleScanMediator.isWaiting(this.targetId)) return; // already found
      bleScanMediator.cancelScan(this.targetId);
      if (this.status.state !== 'connected') {
        this._emit({ state: 'error', error: `Sensor ${this.targetId} not found. Ensure device is worn and in range.` });
        if (this._shouldRun) {
          this._scheduleReconnect();
        }
      }
    }, SCAN_TIMEOUT_MS);

    bleScanMediator.requestScan(
      this.targetId,
      (device) => this._isTargetDevice(device),
      async (device) => {
        if (!this._shouldRun) return;
        console.log(`[BLE][${this.targetId}] Found: ${device.name || device.id}`);
        bleScanMediator.cancelScan(this.targetId); // stop looking — found ours
        this._claimedDeviceId = device.id; // now exclusively ours until released — see field comment
        this._clearScanTimer();
        this._emit({ bleAddress: device.id, deviceName: device.name || device.localName || device.id });
        await this._connect(device);
      },
    );
  }

  /**
   * Match device to user-entered ID.
   * Polar devices advertise as "Polar H10 XXXXXXXX" where XXXXXXXX is the 8-char serial.
   * The ID printed on the sensor is typically the last 6-8 chars of serial or MAC.
   *
   * NOTE: bleScanMediator now enforces an exclusive claim per physical
   * device (see its file header) — that's the structural guarantee
   * against two targets landing on the same sensor. The thresholds below
   * still matter on top of that: with several sensors advertising at once,
   * whichever target's matcher fires FIRST for a given device wins the
   * claim, so a too-loose match here can still steal the correct device
   * away from the right target before it gets a chance, even though it
   * can no longer ALSO let a second target read the same packets.
   * Tightened from a 4-char minimum to 6 for substring matches, and exact
   * ID / suffix matches are checked first since they're unambiguous.
   */
  private _isTargetDevice(device: Device): boolean {
    const targetClean  = this.targetId.replace(/[:\s-]/g, '').toUpperCase();
    const idClean      = (device.id || '').replace(/[:\s-]/g, '').toUpperCase();
    const nameUpper    = (device.name || device.localName || '').toUpperCase();
    const localUpper   = (device.localName || '').toUpperCase();

    // Unambiguous matches first.
    if (idClean === targetClean) return true;
    if (targetClean.length >= 6 && idClean.endsWith(targetClean)) return true;

    // Substring-in-name fallback — only for target strings long enough
    // that an accidental match against a DIFFERENT sensor's name is
    // implausible (a 4-char substring is common enough in an 8-char hex
    // serial to collide across 3 sensors; 6+ chars is a ~1-in-16M draw).
    if (targetClean.length >= 6) {
      if (nameUpper.includes(targetClean)) return true;
      if (localUpper.includes(targetClean)) return true;
    }
    if (/^\d{6,10}$/.test(targetClean) && nameUpper.includes(targetClean.slice(-6))) return true;

    return false;
  }

  private async _connect(device: Device) {
    if (!this._shouldRun) return;
    const attempt = ++this._connectAttempt;
    this._emit({ state: 'connecting' });
    console.log(`[BLE][${this.targetId}] Connecting to ${device.name || device.id}… (queued)`);

    // Wait for a live-connection slot before even entering the stagger
    // queue — see bleScanMediator's MAX_CONCURRENT_CONNECTIONS comment.
    // If the phone already has a full radio's worth of sensors connected,
    // this target waits here (shown as "connecting…" to the trainer,
    // never as an error) instead of adding a 7th/8th/9th GATT link that
    // would just destabilize the ones already up.
    await bleScanMediator.waitForConnectionSlot(this.targetId);
    if (!this._shouldRun || attempt !== this._connectAttempt) {
      bleScanMediator.releaseConnectionSlot(this.targetId);
      bleScanMediator.releaseDeviceClaim(this._claimedDeviceId, this.targetId);
      this._claimedDeviceId = null;
      return;
    }

    let timedOut = false;
    this._connectTimer = setTimeout(() => {
      if (attempt !== this._connectAttempt) return; // stale — a newer attempt owns this device now
      timedOut = true;
      this._connectAttempt++; // invalidate this attempt's in-flight continuation
      this._emit({ state: 'error', error: 'Connection timed out. Moving closer may help.' });
      try { device.cancelConnection(); } catch {}
      bleScanMediator.releaseConnectionSlot(this.targetId);
      bleScanMediator.releaseDeviceClaim(this._claimedDeviceId, this.targetId);
      this._claimedDeviceId = null;
      if (this._shouldRun) {
        const rc = this.status.reconnectCount + 1;
        this._emit({ reconnectCount: rc });
        this._scheduleReconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    try {
      // Serialized + staggered so multiple sensors don't call connect()
      // in the same tick — a major source of Android GATT instability.
      const conn = await bleScanMediator.connectSerialized(() =>
        device.connect({ autoConnect: false, requestMTU: 512 })
      );
      if (timedOut || attempt !== this._connectAttempt) { try { conn.cancelConnection(); } catch {} return; }
      this._clearConnectTimer();

      this._emit({ state: 'discovering' });
      console.log(`[BLE][${this.targetId}] Discovering services…`);
      await conn.discoverAllServicesAndCharacteristics();

      if (!this._shouldRun || attempt !== this._connectAttempt) { try { conn.cancelConnection(); } catch {} return; }

      this._bleDevice = conn;
      this._connectedAtMs = Date.now();
      this._backoffAttempt = 0; // reset backoff — this was a successful connection
      this._emit({
        state: 'connected',
        bleAddress: conn.id,
        deviceName: conn.name || conn.localName || device.id,
        isStale: false,
      });

      // Android: request high-priority connection for lower latency/jitter —
      // matters most when several sensors are streaming at once and sharing
      // the radio. No-op/throws harmlessly on iOS or older Android, ignored.
      try { await conn.requestConnectionPriority(1); } catch {}

      console.log(`[BLE][${this.targetId}] ✓ Connected — subscribing to HR`);

      this._subscribeHR(conn);
      this._startStaleWatch();

      await this._readBattery(conn);
      this._batteryTimer = setInterval(() => {
        if (this._bleDevice) this._readBattery(this._bleDevice);
      }, BATTERY_POLL_MS);

      // Live signal strength — polled independently of the HR notification
      // stream so a weakening link shows up on the trainer's tile *before*
      // packets actually stop (which is what isStale/disconnect already
      // cover). See rssiToBars() for the bar thresholds.
      await this._readRSSI(conn);
      this._rssiTimer = setInterval(() => {
        if (this._bleDevice) this._readRSSI(this._bleDevice);
      }, RSSI_POLL_MS);

      this._disconnectSub = conn.onDisconnected((err) => {
        console.warn(`[BLE][${this.targetId}] Disconnected:`, err?.message);
        this._clearTimers();
        this._hrSub = null;
        this._bleDevice = null;
        this._connectedAtMs = 0;
        bleScanMediator.releaseConnectionSlot(this.targetId);
        bleScanMediator.releaseDeviceClaim(this._claimedDeviceId, this.targetId);
        this._claimedDeviceId = null;
        this._emit({ state: 'disconnected', hr: 0, rrIntervals: [], isStale: false, rssi: null });
        if (this._shouldRun) {
          const rc = this.status.reconnectCount + 1;
          this._emit({ reconnectCount: rc });
          this._scheduleReconnect();
        }
      });

    } catch (e: any) {
      this._clearConnectTimer();
      bleScanMediator.releaseConnectionSlot(this.targetId);
      bleScanMediator.releaseDeviceClaim(this._claimedDeviceId, this.targetId);
      this._claimedDeviceId = null;
      if (timedOut) return;
      if (attempt !== this._connectAttempt) return; // stale attempt error — a newer attempt is already running
      console.warn(`[BLE][${this.targetId}] Connect error:`, e.message);
      this._emit({ state: 'error', error: e.message || 'Connection failed' });
      if (this._shouldRun) {
        const rc = this.status.reconnectCount + 1;
        this._emit({ reconnectCount: rc });
        this._scheduleReconnect();
      }
    }
  }

  private _subscribeHR(conn: Device) {
    try {
      this._hrSub = conn.monitorCharacteristicForService(
        HR_SERVICE, HR_CHAR,
        (err, char) => {
          if (err) {
            if (!this._shouldRun) return;
            console.warn(`[BLE][${this.targetId}] HR monitor error:`, err.message);
            this._emit({ state: 'error', error: err.message });
            this._clearTimers();
            this._bleDevice = null;
            bleScanMediator.releaseConnectionSlot(this.targetId);
            bleScanMediator.releaseDeviceClaim(this._claimedDeviceId, this.targetId);
            this._claimedDeviceId = null;
            if (this._shouldRun) {
              this._scheduleReconnect();
            }
            return;
          }
          if (!char?.value) return;

          const { hr, rrMs, contact } = _parseHRPacket(char.value);
          if (contact === false) {
            // Strap reports NO skin contact: don't treat this as a fresh
            // reading (no lastHeardMs bump) — so isStale/the watchdog
            // see the silence — but publish the contact flag so the UI
            // can say "strap off" instead of looking merely quiet.
            if (this.status.contact !== false) this._emit({ contact: false });
            return;
          }
          if (hr >= MIN_PLAUSIBLE_BPM && hr <= MAX_PLAUSIBLE_BPM) {
            // _emit() is the ONLY place a fresh reading is broadcast now —
            // sessionEngine.ts subscribes via addGlobalBLEListener and
            // turns this into a formula-engine tick + SQLite write + sync
            // queue entry. This file has no opinion on what happens next.
            this._emit({
              hr, rrIntervals: rrMs, lastHeardMs: Date.now(),
              totalReadings: this.status.totalReadings + 1,
              isStale: false,
              contact,
            });
          }
        }
      );
    } catch (e: any) {
      console.warn(`[BLE][${this.targetId}] monitorCharacteristic error:`, e.message);
    }
  }

  /** Flags isStale=true if BLE is still connected but no packet arrived for
   *  STALE_HR_MS — measured either since the last good packet, or (if none
   *  has ever arrived) since the moment the connection was established. */
  private _startStaleWatch() {
    if (this._staleTimer) clearInterval(this._staleTimer);
    this._staleTimer = setInterval(() => {
      if (this.status.state !== 'connected') return;
      const baseline    = this.status.lastHeardMs > 0 ? this.status.lastHeardMs : this._connectedAtMs;
      const sinceLastMs = Date.now() - baseline;
      const stale = baseline > 0 && sinceLastMs > STALE_HR_MS;
      if (stale !== this.status.isStale) {
        this._emit({ isStale: stale });
      }
    }, STALE_CHECK_MS);
  }

  private async _readBattery(conn: Device) {
    try {
      const char = await conn.readCharacteristicForService(BAT_SERVICE, BAT_CHAR);
      if (char?.value) {
        const bytes   = _base64ToBytes(char.value);
        const battery = bytes[0];
        this._emit({ battery });
      }
    } catch {
      // Battery service optional — some older Polar models omit it
    }
  }

  private async _readRSSI(conn: Device) {
    try {
      const updated = await conn.readRSSI();
      const rssi = updated?.rssi ?? null;
      if (rssi !== this.status.rssi) this._emit({ rssi });
    } catch {
      // readRSSI() can throw transiently mid-connection-churn (e.g. right
      // after a reconnect) — not fatal, just skip this cycle and try again
      // on the next poll rather than surfacing an error state for it.
    }
  }

  /** Schedule the next _startScan() attempt with capped exponential backoff. */
  private _scheduleReconnect() {
    if (!this._shouldRun) return;
    this._connectAttempt++; // invalidate any connect still in flight so the new scan is the sole owner
    const idx   = Math.min(this._backoffAttempt, RECONNECT_BACKOFF_MS.length - 1);
    const delay = RECONNECT_BACKOFF_MS[idx];
    this._backoffAttempt++;
    this._reconnectTimer = setTimeout(() => this._startScan(), delay);
  }

  private _clearScanTimer() {
    if (this._scanTimer) { clearTimeout(this._scanTimer); this._scanTimer = null; }
  }
  private _clearConnectTimer() {
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
  }
  private _clearTimers() {
    this._clearScanTimer();
    this._clearConnectTimer();
    if (this._batteryTimer)   { clearInterval(this._batteryTimer);  this._batteryTimer = null; }
    if (this._rssiTimer)      { clearInterval(this._rssiTimer);     this._rssiTimer = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._staleTimer)     { clearInterval(this._staleTimer);    this._staleTimer = null; }
  }
}

// ── Global device registry ────────────────────────────────────────────

const _devices    = new Map<string, PolarDevice>();
const _globalListeners = new Set<PolarStatusListener>();

// ── Public API ────────────────────────────────────────────────────────

/**
 * Call once at app start. Requests BLE permissions + waits for BT power on.
 * Returns true if ready to scan.
 */
export async function initBLE(): Promise<boolean> {
  if (_bleReady && _permissionsGranted) return true;

  _lastPermissionError = null;
  _permissionsGranted = await _requestPermissions();
  if (!_permissionsGranted) {
    console.warn('[BLE] Permissions denied:', _lastPermissionError);
    return false;
  }

  // getSharedManager() constructs the native BleManager on first call,
  // which can throw synchronously (seen right after launch, and on
  // reconnect-heavy paths like the Sensors tab bringing several
  // previously-registered sensors back up at once). Every caller of
  // initBLE() treats it as "resolves true/false", never as "can reject" —
  // letting that throw escape turned into an unhandled rejection with no
  // catch anywhere in the chain, which is what showed up as an error
  // screen instead of the normal "Bluetooth unavailable" state this
  // function already has a path for.
  let mgr;
  try {
    mgr = getSharedManager();
  } catch (e: any) {
    _bleReady = false;
    _lastPermissionError = e?.message || 'Bluetooth is unavailable on this device.';
    return false;
  }
  return new Promise((resolve) => {
    const sub = mgr.onStateChange((state) => {
      if (state === State.PoweredOn) {
        _bleReady = true;
        sub.remove();
        resolve(true);
      } else if (state === State.PoweredOff || state === State.Unsupported) {
        _bleReady = false;
        sub.remove();
        resolve(false);
      }
    }, true);
  });
}

/** Get current BT power state */
export async function getBLEAdapterState(): Promise<State> {
  try { return await getSharedManager().state(); }
  catch { return State.Unknown; }
}

/**
 * Subscribe to LIVE BT adapter power state changes (on/off toggled by user
 * in system settings). Without this, the UI only ever reflects whatever
 * initBLE() saw once at boot — so turning Bluetooth on after the app
 * already gave up (or off while connected) never updates the on-screen
 * status until the screen is remounted. This keeps it accurate for the
 * lifetime of the subscription.
 */
export function addBLEAdapterStateListener(fn: (state: State) => void): () => void {
  // getSharedManager() can throw if the native BLE stack is unavailable
  // (e.g. BleManager constructor throws right after launch). Every caller
  // of this function is inside a useEffect — if the throw escapes, React
  // surfaces it through the nearest ErrorBoundary, showing the error
  // screen instead of gracefully degrading (showing 'Bluetooth Off' in
  // the Sensors tab). Wrapping here makes the subscription a no-op when
  // BLE is structurally unavailable; the screen will still reflect the
  // 'off' state via getBLEAdapterState() called during boot().
  let mgr;
  try {
    mgr = getSharedManager();
  } catch {
    // Return a no-op unsubscribe — nothing to clean up.
    return () => {};
  }
  const sub = mgr.onStateChange((state) => {
    const justPoweredOn = state === State.PoweredOn && !_bleReady;
    _bleReady = state === State.PoweredOn;
    fn(state);
    // If BT just came back on, kick any sensor stuck in 'error' (e.g. it
    // gave up because BT was off) to re-scan immediately instead of
    // waiting out its own retry timer. Goes through connectPolarSensor()
    // (same path the "Retry" button uses) so the existing instance — and
    // any reconnect timer it already has pending — is torn down cleanly
    // first, rather than starting a second overlapping scan on top of it.
    if (justPoweredOn) {
      for (const [id, dev] of Array.from(_devices.entries())) {
        if (dev.status.state === 'error') {
          connectPolarSensor(id).catch(() => {});
        }
      }
    }
  }, true);
  return () => { try { sub.remove(); } catch {} };
}

/**
 * Connect to a Polar sensor by device ID.
 *
 * Idempotent: if a PolarDevice for this id already exists AND is alive
 * (connected, or mid scan/connect/discover), this is a no-op instead of
 * the previous stop()+restart. Restarting unconditionally was a real
 * connection-stability bug — the Sensors tab reconnects every registered
 * sensor on every mount, and the BT-power listener reconnects on every
 * power-on, so a healthy sensor got torn down and re-paired repeatedly
 * (visible as "keeps disconnecting"). Only a sensor that has actually
 * given up (error/disconnected) is torn down and retried.
 */
export async function connectPolarSensor(deviceId: string): Promise<void> {
  const id = deviceId.trim().toUpperCase();
  if (!id) return;

  const existing = _devices.get(id);
  if (existing) {
    const st = existing.status.state;
    if (st === 'connected' || st === 'connecting' || st === 'discovering' || st === 'scanning') {
      return;
    }
    existing.stop(false);
    _devices.delete(id);
  }

  if (!_bleReady) {
    const ready = await initBLE();
    if (!ready) return;
  }

  const dev = new PolarDevice(id);
  _devices.set(id, dev);
  await dev.start();
}

/** Disconnect a specific sensor */
export function disconnectPolarSensor(deviceId: string) {
  const id = deviceId.trim().toUpperCase();
  const dev = _devices.get(id);
  if (dev) { dev.stop(true); _devices.delete(id); }
}

/** Disconnect all sensors and destroy BLE manager */
export function destroyBLE() {
  for (const [, dev] of _devices) dev.stop(true);
  _devices.clear();
  bleScanMediator.reset();
  destroySharedManager();
  _bleReady   = false;
}

/** Get current status of a specific sensor */
export function getPolarSensorStatus(deviceId: string): PolarDeviceStatus | null {
  const id = deviceId.trim().toUpperCase();
  return _devices.get(id)?.status ?? null;
}

/** Get all active sensor statuses */
export function getAllSensorStatuses(): PolarDeviceStatus[] {
  return Array.from(_devices.values()).map(d => ({ ...d.status }));
}

/** Subscribe to status updates for ALL sensors */
export function addGlobalBLEListener(fn: PolarStatusListener): () => void {
  _globalListeners.add(fn);
  for (const [id, dev] of _devices) fn(id, { ...dev.status });
  return () => _globalListeners.delete(fn);
}

/** Subscribe to status updates for a SPECIFIC sensor */
export function addSensorListener(deviceId: string, fn: PolarStatusListener): () => void {
  const id  = deviceId.trim().toUpperCase();
  const dev = _devices.get(id);
  if (dev) return dev.addListener(fn);
  return () => {};
}

/** Returns true if any sensor is in 'connected' state */
export function isAnyPolarConnected(): boolean {
  for (const [, dev] of _devices) {
    if (dev.status.state === 'connected') return true;
  }
  return false;
}

/**
 * Browse nearby Polar BLE sensors (not just a specific target ID).
 * Used by the Sensors screen's "Scan Nearby" feature so trainers can see
 * every Polar sensor in range — including ones never registered in this
 * app yet — and register/connect them on the spot.
 *
 * IMPORTANT — Polar-only by design:
 *   The underlying native scan (see bleScanMediator.ts) is already filtered
 *   to the Bluetooth Heart Rate Service, which every Polar sensor
 *   advertises, so phones/earbuds/watches/other gym equipment never reach
 *   this callback in the first place. The name check below is a second,
 *   belt-and-braces filter in case some other brand of HR strap in the
 *   room also happens to advertise the same standard service — we only
 *   want to surface devices that identify themselves as Polar. Previously
 *   this matched literally every advertising BLE device (`() => true`),
 *   which is what caused "every surrounding Bluetooth device" to show up
 *   and the list to flicker/rescan constantly as unrelated ads poured in.
 *
 * Reuses the shared scan mediator (does not start a second native scan),
 * so it can safely run at the same time as targeted per-sensor scans.
 */
export interface NearbyBLEDevice {
  id:        string;   // BLE address / UUID
  name:      string;   // advertised name, or id if unnamed
  rssi:      number | null;
  isPolar:   boolean;  // name contains "Polar" — always true now, kept for UI badge
  lastSeenMs:number;
}

const BROWSE_SUB_ID = '__browse_all__';
const NEARBY_UPDATE_THROTTLE_MS = 900; // min gap between RSSI-only re-emits per device

function _isPolarName(device: Device): boolean {
  const name = device.name || device.localName || '';
  return /polar/i.test(name);
}

export async function startNearbyScan(
  onUpdate: (devices: NearbyBLEDevice[]) => void
): Promise<() => void> {
  if (!_bleReady) {
    const ready = await initBLE();
    if (!ready) { onUpdate([]); return () => {}; }
  }

  const found = new Map<string, NearbyBLEDevice>();
  // Sort by name (stable) rather than lastSeenMs — sorting by "most
  // recently heard" reorders the whole list on every single advertisement,
  // which is what made it visibly jump/flicker even once it was limited to
  // just a handful of sensors.
  const emit = () => onUpdate(
    Array.from(found.values()).sort((a, b) => a.name.localeCompare(b.name))
  );

  bleScanMediator.requestScan(
    BROWSE_SUB_ID,
    (device) => _isPolarName(device), // Polar sensors only
    (device) => {
      const name = device.name || device.localName || '';
      const prev = found.get(device.id);
      const now = Date.now();
      // A brand-new device always updates the list immediately. A device
      // we already know about only re-emits at most ~once/second (RSSI
      // refresh) instead of on every advertisement packet — Polar sensors
      // advertise several times a second, and re-rendering the list that
      // often is the other half of the flickering fix.
      if (prev && now - prev.lastSeenMs < NEARBY_UPDATE_THROTTLE_MS) return;
      found.set(device.id, {
        id: device.id,
        name: name || device.id,
        rssi: device.rssi ?? null,
        isPolar: true,
        lastSeenMs: now,
      });
      emit();
    },
    false, // exclusive=false — this is a passive observer, not a connector; see requestScan()'s doc comment in bleScanMediator.ts
  );

  return () => bleScanMediator.cancelScan(BROWSE_SUB_ID);
}

/**
 * Register a device discovered via startNearbyScan() as a tracked sensor
 * and immediately begin connecting to it. Equivalent to typing its ID into
 * the manual "Connect Polar Sensor" field, but skips the re-scan since we
 * already have the BLE address from the browse scan.
 */
export async function registerNearbyDevice(device: NearbyBLEDevice): Promise<string> {
  const id = device.id.trim().toUpperCase();
  await connectPolarSensor(id);
  return id;
}



export interface BLEStatus {
  scanning:   boolean;
  connected:  boolean;
  deviceId:   string;
  deviceName: string;
  lastHR:     number;
  battery:    number;
  error:      string | null;
  isMockMode: boolean;
}

export function getBLEState(): BLEStatus {
  const all = getAllSensorStatuses();
  if (all.length === 0) return _emptyLegacyStatus();
  const s = all[0];
  return _toLegacyStatus(s);
}

export function addBLEStatusListener(fn: (s: BLEStatus) => void): () => void {
  const wrapped: PolarStatusListener = (_, status) => fn(_toLegacyStatus(status));
  return addGlobalBLEListener(wrapped);
}

export async function startBLEScan(deviceId: string) {
  await connectPolarSensor(deviceId);
}

export function stopBLE() {
  for (const id of Array.from(_devices.keys())) {
    disconnectPolarSensor(id);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

async function _requestPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    if (Platform.Version >= 31) {
      // BLUETOOTH_ADVERTISE isn't strictly required for scanning/connecting,
      // but several OEM BLE stacks (Samsung One UI, MIUI) gate the whole
      // Bluetooth runtime-permission group together — requesting all three
      // at once avoids a class of "SCAN granted but stack still refuses"
      // reports seen on those devices.
      const perms = [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ];
      if ((PermissionsAndroid.PERMISSIONS as any).BLUETOOTH_ADVERTISE) {
        perms.push((PermissionsAndroid.PERMISSIONS as any).BLUETOOTH_ADVERTISE);
      }
      const results = await PermissionsAndroid.requestMultiple(perms);
      const scanOk    = results['android.permission.BLUETOOTH_SCAN']    === PermissionsAndroid.RESULTS.GRANTED;
      const connectOk = results['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED;
      if (!scanOk || !connectOk) {
        const blocked = Object.entries(results).some(([, v]) => v === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
        _lastPermissionError = blocked
          ? 'Bluetooth permission was permanently denied. Open App Settings → Permissions → Nearby devices and enable it.'
          : 'Bluetooth permission denied. Tap "Connect" again to re-request, or grant it in App Settings.';
        return false;
      }
      return true;
    } else {
      const r = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      if (r !== PermissionsAndroid.RESULTS.GRANTED) {
        _lastPermissionError = 'Location permission is required for Bluetooth scanning on this Android version.';
        return false;
      }
      return true;
    }
  } catch (e: any) {
    _lastPermissionError = e?.message || 'Permission request failed.';
    return false;
  }
}

/**
 * Parse GATT HR Measurement characteristic (Bluetooth spec 0x2A37)
 *  Byte 0: Flags bitfield
 *    bit 0 = HR format:       0=UINT8, 1=UINT16
 *    bit 1 = sensor contact:  detected if =1
 *    bit 3 = energy expended: present if =1  (next 2 bytes = kJ UINT16)
 *    bit 4 = RR interval:     present if =1  (each RR = UINT16, 1/1024 sec resolution)
 */
function _parseHRPacket(base64: string): { hr: number; rrMs: number[]; contact: boolean | null } {
  try {
    const b   = _base64ToBytes(base64);
    if (b.length < 2) return { hr: 0, rrMs: [], contact: null };

    const flags    = b[0];
    // bit 2 = "sensor contact feature supported", bit 1 = "contact detected".
    const contactSupported = (flags & 0x04) !== 0;
    const contact: boolean | null = contactSupported ? (flags & 0x02) !== 0 : null;
    const isUint16 = (flags & 0x01) !== 0;
    const hasEnergy= (flags & 0x08) !== 0;
    const hasRR    = (flags & 0x10) !== 0;

    let offset = 1;
    const hr = isUint16
      ? (b[offset++] | (b[offset++] << 8))
      : b[offset++];

    if (hasEnergy) offset += 2;

    const rrMs: number[] = [];
    if (hasRR) {
      while (offset + 1 < b.length) {
        const rrRaw = b[offset] | (b[offset + 1] << 8);
        rrMs.push(Math.round((rrRaw / 1024) * 1000));
        offset += 2;
      }
    }
    return { hr, rrMs, contact };
  } catch { return { hr: 0, rrMs: [], contact: null }; }
}

function _base64ToBytes(base64: string): Uint8Array {
  try {
    const bin   = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch { return new Uint8Array(0); }
}

function _toLegacyStatus(s: PolarDeviceStatus): BLEStatus {
  return {
    scanning:   s.state === 'scanning',
    connected:  s.state === 'connected',
    deviceId:   s.deviceId,
    deviceName: s.deviceName,
    lastHR:     s.hr,
    battery:    s.battery >= 0 ? s.battery : 0,
    error:      s.error,
    isMockMode: false,
  };
}

function _emptyLegacyStatus(): BLEStatus {
  return { scanning: false, connected: false, deviceId: '', deviceName: '', lastHR: 0, battery: 0, error: null, isMockMode: false };
}
