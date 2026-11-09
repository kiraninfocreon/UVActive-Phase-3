/**
 * UV Active — BPM Line Graph (pure React Native, zero extra native deps)
 * v2 — production redesign: gridlines, min/avg/max readout, zone-colored
 * line + dot, dashed average reference line. Still zero native deps: no
 * react-native-svg or charting lib, everything is plain <View> geometry.
 * (See original note below — still true, still the reason why.)
 *
 * We deliberately do NOT pull in react-native-svg or a charting library
 * here: this project already went through painful Android/CMake native
 * toolchain fights (see android-patches/), and every new native module is
 * another thing that can break `expo prebuild --clean`. A line graph is
 * simple enough to draw with plain <View> segments — each sample-to-sample
 * step becomes a short, rotated 2px-tall View, "connecting the dots".
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';

export interface GraphPoint { value: number; zone?: number; }

interface Props {
  points: GraphPoint[];
  height?: number;
  lineColor?: string;
  minValue?: number;   // fixed floor (e.g. 40 bpm) — omit to auto-scale
  maxValue?: number;   // fixed ceiling (e.g. 200 bpm) — omit to auto-scale
  emptyLabel?: string;
  showStats?: boolean; // min/avg/max readout strip above the plot (default true)
  /**
   * "Slider" mode — matches the Admin Panel / Branch Portal's
   * horizontally-scrollable full-session graph (one member's entire
   * second-by-second curve, not squeezed to fit the screen width).
   * When on, the plot gets a fixed content width (points.length *
   * pxPerPoint, floored at the container) and scrolls horizontally
   * instead of auto-fitting.
   */
  scrollable?: boolean;
  pxPerPoint?: number; // width per sample when scrollable (default 4px, like the web panels)
}

const ZONE_COLORS: Record<number, string> = {
  0: '#39FF14', 1: '#669FFF', 2: '#4263CF',
  3: '#1E2C7C', 4: '#FF5E73', 5: '#FF0000',
};
const ZONE_NAMES: Record<number, string> = {
  0: 'Standby', 1: 'Recovery', 2: 'Aerobic', 3: 'Fitness', 4: 'Burn', 5: 'Peak',
};

const GRID_LINES = 4; // horizontal gridlines, evenly spaced top→bottom

export function BpmLineGraph({
  points, height = 150, lineColor = '#EF4444', minValue, maxValue,
  emptyLabel = 'No data yet', showStats = true, scrollable = false, pxPerPoint = 4,
}: Props) {
  if (!points || points.length < 2) {
    return (
      <View style={[gs.wrap, gs.emptyWrap, { height }]}>
        <Text style={gs.emptyIcon}>📉</Text>
        <Text style={gs.emptyText}>{emptyLabel}</Text>
      </View>
    );
  }

  const values = points.map(p => p.value);
  const lo = minValue ?? Math.min(...values);
  const hi = maxValue ?? Math.max(...values);
  const range = Math.max(1, hi - lo);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const min = Math.round(Math.min(...values));
  const max = Math.round(Math.max(...values));

  // Which zone dominated this stretch of data — drives the "current zone"
  // chip so the reader gets an at-a-glance read, not just a squiggly line.
  const zoneCounts: Record<number, number> = {};
  points.forEach(p => { if (p.zone != null) zoneCounts[p.zone] = (zoneCounts[p.zone] || 0) + 1; });
  const dominantZone = Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

  const contentWidth = scrollable ? Math.max(points.length * pxPerPoint, 320) : undefined;

  const plot = (
    <View style={[gs.wrap, { height }, contentWidth ? { width: contentWidth } : null]}>
      {/* Gridlines + axis labels */}
      {Array.from({ length: GRID_LINES + 1 }).map((_, i) => {
        const frac = i / GRID_LINES;
        const val = Math.round(hi - frac * range);
        return (
          <View key={i} style={[gs.gridLine, { top: 6 + frac * (height - 12) }]} pointerEvents="none">
            <Text style={gs.gridLabel}>{val}</Text>
            <View style={gs.gridRule} />
          </View>
        );
      })}
      {/* Dashed average reference line */}
      <View
        style={[gs.avgLine, { top: 6 + (1 - (avg - lo) / range) * (height - 12) }]}
        pointerEvents="none"
      />
      <View style={gs.plotArea}>
        <GraphLines points={points} lo={lo} range={range} height={height} lineColor={lineColor} />
      </View>
    </View>
  );

  return (
    <View>
      {showStats && (
        <View style={gs.statsRow}>
          <StatChip label="MIN" value={`${min}`} color="#669FFF" />
          <StatChip label="AVG" value={`${avg}`} color="#F59E0B" />
          <StatChip label="MAX" value={`${max}`} color="#FF5E73" />
          {dominantZone != null && (
            <View style={[gs.zoneChip, { borderColor: (ZONE_COLORS[+dominantZone] || lineColor) + '55' }]}>
              <View style={[gs.zoneDot, { backgroundColor: ZONE_COLORS[+dominantZone] || lineColor }]} />
              <Text style={[gs.zoneChipTxt, { color: ZONE_COLORS[+dominantZone] || lineColor }]}>
                mostly {ZONE_NAMES[+dominantZone] || '—'}
              </Text>
            </View>
          )}
        </View>
      )}
      {scrollable ? (
        <ScrollView horizontal showsHorizontalScrollIndicator bounces={false} contentContainerStyle={gs.scrollContent}>
          {plot}
        </ScrollView>
      ) : (
        plot
      )}
      {scrollable && points.length > 1 && (
        <Text style={gs.scrollHint}>← scroll for the full session →</Text>
      )}
    </View>
  );
}

function StatChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={gs.statChip}>
      <Text style={[gs.statChipVal, { color }]}>{value}</Text>
      <Text style={gs.statChipLbl}>{label}</Text>
    </View>
  );
}

function GraphLines({ points, lo, range, height, lineColor }: { points: GraphPoint[]; lo: number; range: number; height: number; lineColor: string }) {
  const [width, setWidth] = React.useState(0);

  const n = points.length;
  const segW = width > 0 ? width / (n - 1) : 0;

  const toXY = (i: number) => {
    const x = i * segW;
    const y = height - ((points[i].value - lo) / range) * (height - 12) - 6;
    return { x, y };
  };

  const segments: React.ReactNode[] = [];
  if (width > 0) {
    for (let i = 0; i < n - 1; i++) {
      const a = toXY(i);
      const b = toXY(i + 1);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const angle = Math.atan2(dy, dx);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const color = points[i + 1].zone != null ? (ZONE_COLORS[points[i + 1].zone as number] || lineColor) : lineColor;
      segments.push(
        <View
          key={i}
          style={{
            position: 'absolute',
            left: midX - len / 2, top: midY - 1.25,
            width: len, height: 2.5,
            backgroundColor: color,
            borderRadius: 2,
            transform: [{ rotate: `${angle}rad` }], // rotates around the view's own center by default
          }}
        />
      );
    }
    // Latest-point dot, pulsing ring style (static ring for perf — no
    // Animated loop needed for a historical/completed-session graph).
    const last = toXY(n - 1);
    const lastColor = points[n - 1].zone != null ? (ZONE_COLORS[points[n - 1].zone as number] || lineColor) : lineColor;
    segments.push(
      <View key="dotRing" style={{
        position: 'absolute', left: last.x - 7, top: last.y - 7,
        width: 14, height: 14, borderRadius: 7, backgroundColor: lastColor + '33',
      }} />
    );
    segments.push(
      <View key="dot" style={{
        position: 'absolute', left: last.x - 4, top: last.y - 4,
        width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff', borderWidth: 2,
        borderColor: lastColor,
      }} />
    );
  }

  return (
    <View style={{ flex: 1 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {segments}
    </View>
  );
}

const gs = StyleSheet.create({
  statsRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  statChip:     { alignItems: 'center', backgroundColor: '#111', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: '#1a1a1a' },
  statChipVal:  { fontSize: 14, fontWeight: '900' },
  statChipLbl:  { color: '#555', fontSize: 8, fontWeight: '700', letterSpacing: 1, marginTop: 1 },
  zoneChip:     { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#111', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, marginLeft: 'auto' },
  zoneDot:      { width: 7, height: 7, borderRadius: 3.5 },
  zoneChipTxt:  { fontSize: 10, fontWeight: '800' },
  wrap:         { backgroundColor: '#0a0a0a', borderRadius: 10, borderWidth: 1, borderColor: '#1a1a1a', paddingHorizontal: 10, paddingVertical: 6, position: 'relative', overflow: 'hidden' },
  emptyWrap:    { alignItems: 'center', justifyContent: 'center' },
  emptyIcon:    { fontSize: 22, marginBottom: 6, opacity: 0.5 },
  plotArea:     { flex: 1, marginLeft: 30 },
  gridLine:     { position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center' },
  gridLabel:    { color: '#444', fontSize: 8, fontWeight: '700', width: 26 },
  gridRule:     { flex: 1, height: 1, backgroundColor: '#1a1a1a' },
  avgLine:      { position: 'absolute', left: 30, right: 0, height: 1, borderTopWidth: 1, borderStyle: 'dashed', borderColor: '#F59E0B66' },
  emptyText:    { color: '#444', fontSize: 12, textAlign: 'center', paddingHorizontal: 16 },
  scrollContent: { flexGrow: 1 },
  scrollHint:   { color: '#444', fontSize: 9, textAlign: 'center', marginTop: 4, fontWeight: '600', letterSpacing: 0.3 },
});
