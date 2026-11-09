/**
 * UV Active — live athlete tile (zone-coloured block).
 *
 * Layout follows the trainer-approved reference: sharp-cornered block in
 * the member's current zone colour, illustrated avatar (girl / boy by
 * sex, never a photo) + first name top-left, giant %MHR top-right, then
 * a UV-points row and a calories row. States: live, reconnecting,
 * dropped (signal lost), away (silent >2 min, scoring frozen), left
 * (trainer ended their session early), waiting (pre-session) and
 * needsSensor (dead block).
 */
import React, { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import type { LiveTick } from '../lib/formula-engine';
import { ZONE_NAMES } from '../lib/formula-engine';
import { colors, fonts } from '../theme/tokens';
import { rssiToBars } from '../services/ble';
import { Avatar } from './uv/Avatar';

interface Props {
  tick: LiveTick;
  rank: number;
  tileWidth: number;
  /** Explicit height (TV mode fits the grid to the screen). Defaults to width * 0.92. */
  tileHeight?: number;
  onPress: (memberId: string) => void;
  preSession?: boolean;
  needsSensor?: boolean;
  /** Bigger type for the Cast-to-TV grid. */
  tv?: boolean;
}

function firstName(name: string): string {
  return (name || '').trim().split(/\s+/)[0] || name;
}

export function AthleteTile({ tick, rank, tileWidth, tileHeight, onPress, preSession = false, needsSensor = false, tv = false }: Props) {
  const h = tileHeight ?? Math.round(tileWidth * 0.92);
  const scale = tv ? Math.min(tileWidth / 190, h / 130) * 1.1 : Math.min(tileWidth / 150, 1.25);
  const s = (n: number) => Math.round(n * scale);

  const status = tick.memberStatus ?? 'active';
  const isLeft = status === 'left';
  const isAway = status === 'away';
  const isDropped = !!tick.isDropped && !preSession && !isAway && !isLeft;
  const isReconnecting = !!tick.isReconnecting && !preSession && !isDropped && !isAway && !isLeft;

  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!isReconnecting) { pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [isReconnecting]);
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] });

  const bgAnim = useRef(new Animated.Value(0)).current;
  const prevColor = useRef(tick.zoneColour || colors.zone[0]);
  const currColor = useRef(tick.zoneColour || colors.zone[0]);
  useEffect(() => {
    if (preSession || isDropped || isAway || isLeft) return;
    const next = tick.zoneColour || colors.zone[tick.currentZone ?? 0];
    if (next !== currColor.current) {
      prevColor.current = currColor.current;
      currColor.current = next;
      bgAnim.setValue(0);
      Animated.timing(bgAnim, { toValue: 1, duration: 500, useNativeDriver: false }).start();
    }
  }, [tick.currentZone, tick.zoneColour]);
  const animatedBg = bgAnim.interpolate({ inputRange: [0, 1], outputRange: [prevColor.current, currColor.current] });

  const name = firstName(tick.memberName);
  const avatarSize = s(34);

  if (needsSensor) {
    return (
      <TouchableOpacity activeOpacity={0.8} onPress={() => onPress(tick.memberId)} style={{ width: tileWidth, height: h }}>
        <View style={[styles.tile, styles.dead, { width: tileWidth, height: h }]}>
          <Avatar sex={tick.sex} seed={tick.memberId} size={avatarSize} />
          <Text style={[styles.deadName, { fontSize: s(12) }]} numberOfLines={1}>{name}</Text>
          <Text style={[styles.deadLabel, { fontSize: s(9) }]}>
            {isLeft ? 'TAP TO REJOIN' : 'TAP TO ASSIGN SENSOR'}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  const muted = preSession || isDropped || isAway || isLeft;
  const bg = isLeft ? '#16161B' : isAway ? '#22222A' : isDropped ? '#1B1B2E' : preSession ? '#17171C' : undefined;
  const textColor = muted ? 'rgba(255,255,255,0.45)' : '#FFFFFF';
  const calories = Math.round(tick.caloriesSoFar ?? 0);
  const pctText = preSession ? '--' : isDropped || isAway ? '--' : String(Math.round(tick.pctMHR));

  return (
    <TouchableOpacity activeOpacity={preSession ? 0.95 : 0.82} onPress={() => !preSession && onPress(tick.memberId)} style={{ width: tileWidth, height: h }}>
      <Animated.View style={[styles.tile, { width: tileWidth, height: h, padding: s(9), justifyContent: 'space-between' }, bg ? { backgroundColor: bg } : { backgroundColor: animatedBg }]}>
        {/* top: avatar + name  |  big % */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <View style={{ alignItems: 'center', maxWidth: '46%' }}>
            <View style={{ opacity: muted ? 0.55 : 1 }}>
              <Avatar sex={tick.sex} seed={tick.memberId} size={avatarSize} ring="rgba(255,255,255,0.55)" />
            </View>
            <Text style={[styles.name, { fontSize: s(12), color: textColor, marginTop: s(3) }]} numberOfLines={1}>{name}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <Text style={[styles.pct, { fontSize: s(46), lineHeight: s(48), color: textColor }]}>{pctText}</Text>
              {!muted && <Text style={[styles.pctSym, { fontSize: s(15), color: textColor }]}>%</Text>}
            </View>
            {!muted && <Text style={[styles.bpm, { fontSize: s(10) }]}>{Math.round(tick.currentBPM)} bpm · {ZONE_NAMES[tick.currentZone ?? 0]}</Text>}
          </View>
        </View>

        {/* status line for non-live states */}
        {(isDropped || isAway || isLeft || preSession) && (
          <Text style={[styles.status, { fontSize: s(9) }]}>
            {isLeft ? 'LEFT SESSION' : isAway ? 'AWAY · SCORE PAUSED' : isDropped ? 'SIGNAL LOST' : 'WAITING FOR SIGNAL'}
          </Text>
        )}
        {isReconnecting && (
          <Animated.View style={[styles.reconnect, { opacity: pulseOpacity }]}><Text style={styles.reconnectText}>RECONNECTING…</Text></Animated.View>
        )}

        {/* bottom: points + calories */}
        <View style={{ gap: s(3) }}>
          <View style={styles.row}>
            <Text style={{ fontSize: s(11), color: textColor }}>⚡</Text>
            <Text style={[styles.rowVal, { fontSize: s(15), color: textColor }]}>{preSession ? '--' : Math.round(tick.sweatPointsSoFar)}</Text>
            <Text style={[styles.rowLbl, { fontSize: s(9) }]}>UV PTS</Text>
          </View>
          <View style={styles.row}>
            <Text style={{ fontSize: s(11), color: textColor }}>🔥</Text>
            <Text style={[styles.rowVal, { fontSize: s(15), color: textColor }]}>{preSession ? '--' : calories}</Text>
            <Text style={[styles.rowLbl, { fontSize: s(9) }]}>KCAL</Text>
          </View>
        </View>

        {!muted && tick.rssi !== undefined && tick.rssi !== null && !isReconnecting && <Signal rssi={tick.rssi} />}
        {!preSession && rank > 0 && !isLeft && (
          <View style={styles.rank}><Text style={styles.rankText}>{rank}</Text></View>
        )}
      </Animated.View>
    </TouchableOpacity>
  );
}

function Signal({ rssi }: { rssi: number }) {
  const bars = rssiToBars(rssi);
  const c = bars <= 1 ? '#FF5E73' : bars === 2 ? '#F5C518' : 'rgba(255,255,255,0.85)';
  return (
    <View style={styles.signal}>
      {[1, 2, 3, 4].map((i) => <View key={i} style={{ width: 3, height: 3 + i * 2, borderRadius: 1, backgroundColor: i <= bars ? c : 'rgba(255,255,255,0.18)' }} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: 4, position: 'relative', overflow: 'hidden' },
  dead: { backgroundColor: 'rgba(251,80,97,0.06)', borderWidth: 1.5, borderColor: 'rgba(251,80,97,0.35)', borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 4 },
  deadName: { fontFamily: fonts.bodySemiBold, color: 'rgba(255,255,255,0.65)' },
  deadLabel: { fontFamily: fonts.bodySemiBold, color: colors.primary, letterSpacing: 0.8 },
  name: { fontFamily: fonts.bodySemiBold },
  pct: { fontFamily: fonts.metricBold, letterSpacing: -2 },
  pctSym: { fontFamily: fonts.metricBold, marginTop: 4, marginLeft: 1 },
  bpm: { fontFamily: fonts.metric, color: 'rgba(255,255,255,0.7)', marginTop: 1 },
  status: { fontFamily: fonts.bodySemiBold, color: 'rgba(255,255,255,0.55)', letterSpacing: 1, textAlign: 'right' },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  rowVal: { fontFamily: fonts.metricBold },
  rowLbl: { fontFamily: fonts.bodyMedium, color: 'rgba(255,255,255,0.6)', letterSpacing: 1 },
  rank: { position: 'absolute', right: 6, bottom: 5, backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 3, minWidth: 16, paddingHorizontal: 4, alignItems: 'center' },
  rankText: { fontFamily: fonts.metricBold, fontSize: 9, color: 'rgba(255,255,255,0.8)' },
  signal: { position: 'absolute', left: 8, bottom: 8, flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, display: 'none' },
  reconnect: { position: 'absolute', left: 8, bottom: 8, backgroundColor: 'rgba(245,197,24,0.2)', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1.5 },
  reconnectText: { fontFamily: fonts.bodySemiBold, color: '#F5C518', fontSize: 8 },
});
