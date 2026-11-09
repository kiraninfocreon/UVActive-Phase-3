import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import { colors } from '../../theme/tokens';

/**
 * Lovable `AmbientBackground`: OLED base with a coral aura top-left and
 * a mint aura bottom-right. Radial gradients via SVG (RN has none).
 * Purely decorative, never intercepts touches.
 */
export function AmbientBackground() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={['#12090C', colors.background, '#05050A']} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="auraA" cx="12%" cy="0%" rx="85%" ry="55%" fx="12%" fy="0%">
            <Stop offset="0" stopColor={colors.primary} stopOpacity="0.16" />
            <Stop offset="1" stopColor={colors.primary} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="auraB" cx="95%" cy="100%" rx="80%" ry="55%" fx="95%" fy="100%">
            <Stop offset="0" stopColor={colors.recovery} stopOpacity="0.11" />
            <Stop offset="1" stopColor={colors.recovery} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#auraA)" />
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#auraB)" />
      </Svg>
    </View>
  );
}
