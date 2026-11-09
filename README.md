# UV Active — Trainer App

React Native (Expo) app for gym trainers: run live heart-rate sessions off
BLE sensors, schedule/manage sessions, and view member history — all
talking directly to the UV Active Cloud API. No local hub, no WebSocket
bridge, no WiFi discovery — removed entirely in this rebuild in favor of
direct HTTPS to the cloud API plus a real local SQLite offline queue so a
session never loses data to a dropped connection.

See `WINDOWS_BUILD_GUIDE.md` for the full Android build walkthrough
(EAS cloud build and local Gradle build, both covered) and a production
readiness checklist. This file covers day-to-day development.

## Prerequisites

- Node.js 20 LTS (or 22)
- An Android device or emulator, or a physical Android phone with USB
  debugging enabled (BLE doesn't work in most emulators — a real phone
  is strongly recommended for any BLE-related testing)
- A UV Active Cloud API instance to point at (see Configuration below)

This app uses native modules (`expo-sqlite`, `react-native-ble-plx`) that
**do not work in plain Expo Go**. You need a development build (a dev
client) — see "Running the app" below.

## Install

```bash
npm install
```

## Configuration

The cloud API base URL is read from an environment variable at build
time:

```bash
# .env (not committed — create this yourself)
EXPO_PUBLIC_API_BASE_URL=https://api.uvactive.in/api/v1
```

Falls back to the hardcoded default in `src/config.ts` if unset — fine
for quick local testing, but set this explicitly for anything real.
Per-build-profile overrides also live in `eas.json` for EAS builds.

## Running the app (development)

Because of the native modules mentioned above, `expo start` alone won't
give you a working app in Expo Go. Build a development client once,
then iterate against it:

```bash
# One-time: build and install a dev client on a connected Android device
npx expo prebuild --platform android
npx expo run:android

# Day to day after that: just start the JS bundler and reload in the
# already-installed dev client
npm start
```

Or build the dev client via EAS instead of locally:
```bash
eas build --platform android --profile development
# install the resulting APK on your device, then:
npm start
```

## Type checking

```bash
npm run typecheck
```
Runs `tsc --noEmit`. No native build required — safe to run anywhere,
including CI, and the fastest way to catch a broken import or a DTO/API
mismatch before it reaches a device.

## Building for Android (production)

Short version — see `WINDOWS_BUILD_GUIDE.md` for the full walkthrough:

```bash
npm install -g eas-cli
eas login
eas build --platform android --profile production
```
Produces a Play-Store-ready `.aab`. Use `--profile preview` instead for a
directly-installable test APK.

## Project structure

```
App.tsx                    Root component — providers, error boundary, sync-queue lifecycle
src/
  config.ts                 Environment config (API base URL, BLE concurrency limits)
  theme/tokens.ts            Design tokens (colors, fonts, spacing) — ported from the web
                              product's design system, same palette as the Admin Panel /
                              Branch Portal
  lib/formula-engine/        Vendored @uvactive/formula-engine — pure-TS zero-dep MHR/zone/
                              calorie/score calculations, shared logic (see its own README-
                              equivalent comments in index.ts). Do not hand-edit generated
                              output here; if the upstream formula engine changes, re-vendor
                              the whole directory rather than patching individual files.
  services/
    ble.ts                   BLE sensor connectivity (react-native-ble-plx). Connection
                              slot queuing, reconnect backoff, exclusive device claims.
    bleScanMediator.ts        Backing coordinator for ble.ts's connection-slot limits.
    sessionEngine.ts          THE core piece: BLE ticks -> formula engine -> SQLite write-
                              through -> cloud sync queue. No hub involved anywhere.
    api.ts                    Cloud API HTTP client (auth, token refresh, request envelope).
    sessionsApi.ts             Typed calls for sessions/members/sensors endpoints.
    syncQueue.ts               Drains the local SQLite outbox to the cloud API whenever
                              online. Runs independently of whether a session is live.
    networkStatus.ts           Lightweight connectivity polling — no hub-rediscovery logic.
  db/database.ts             Real SQLite (expo-sqlite, WAL mode) — sessions, session
                              members, raw ticks, accumulator state, sync outbox.
  screens/                   One file per screen (see WINDOWS_BUILD_GUIDE.md's checklist
                              for what's been tested where).
  components/                Shared UI: AthleteTile, BpmLineGraph, SessionControlBar,
                              CountdownOverlay, ConnectionStatus, ErrorBoundary.
  navigation/                React Navigation stack + bottom tabs.
  hooks/useAuth.tsx           Staff auth/session context.
plugins/                    Two custom Expo config plugins, applied at `expo prebuild`
                              time: ABI filtering (smaller APK) and a foreground-service
                              manifest patch (keeps BLE alive against Android Doze during
                              a long session). Do not edit android/ directly if you plan to
                              run prebuild again — these plugins are the source of truth.
```

## What changed from the previous (hub-based) app

If you're comparing against the old codebase: `hubDiscovery.ts`,
`udpDiscovery.ts`, `websocket.ts`, and the hub-relative parts of the old
`connectionManager.ts` are gone, not refactored. `ble.ts` itself is
almost unchanged — it already had a clean internal event/listener
pattern, and the hub was just one consumer of it (via 7 specific calls
to `WSService.sendToBridge()`); `sessionEngine.ts` is the new consumer,
attached the same way. Local storage moved from an AsyncStorage
workaround to real SQLite. See `WINDOWS_BUILD_GUIDE.md`'s production
checklist for what to verify on real hardware before shipping.
