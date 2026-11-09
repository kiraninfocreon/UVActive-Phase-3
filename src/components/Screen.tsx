/**
 * Shared safe-area-aware screen wrapper.
 *
 * App.tsx sets up SafeAreaProvider, but nothing previously consumed it —
 * every screen renders with headers hidden, so content sat flush under
 * the status bar / notch and could crowd the bottom home-indicator /
 * gesture bar. Notch geometry differs per phone, so this read as
 * inconsistent "enlargement / misalignment" depending on the device.
 *
 * Usage: wrap each screen's root in <Screen edges={[...]}>. Tab screens
 * only need edges={['top']} since @react-navigation/bottom-tabs (v7)
 * already insets its own bottom bar. Stack-only screens (no tab bar
 * beneath them) need edges={['top', 'bottom']}.
 */
import React from 'react';
import type { ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { colors } from '../theme/tokens';
import { AmbientBackground } from './uv/AmbientBackground';

interface Props {
  children: React.ReactNode;
  edges?: Edge[];
  style?: ViewStyle;
  /** Background colour — defaults to the app's standard dark background. */
  backgroundColor?: string;
  /** Lovable ambient aura behind the content. On by default; the live grid turns it off for flat OLED black. */
  ambient?: boolean;
}

export function Screen({ children, edges = ['top', 'bottom'], style, backgroundColor = colors.background, ambient = true }: Props) {
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor }, style]}>
      {ambient ? <AmbientBackground /> : null}
      {children}
    </SafeAreaView>
  );
}
