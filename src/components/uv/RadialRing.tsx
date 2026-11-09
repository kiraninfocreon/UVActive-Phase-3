import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors } from '../../theme/tokens';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export interface RingSegment {
  /** 0-1 portion of the full ring this segment fills. */
  value: number;
  color: string;
}

interface Props {
  size?: number;
  thickness?: number;
  /** Single value 0-1; ignored when `segments` is given. */
  value?: number;
  segments?: RingSegment[];
  color?: string;
  children?: React.ReactNode;
}

/**
 * Lovable `RadialRing` — circular progress, the primary metric display.
 * Supports stacked segments (e.g. Sweat + Recovery) and animates in.
 */
export function RadialRing({ size = 220, thickness = 10, value = 0, segments, color = colors.primary, children }: Props) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const parts = segments ?? [{ value, color }];

  let acc = 0;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={radius} stroke={colors.track} strokeWidth={thickness} fill="none" />
        {parts.map((seg, i) => {
          const clamped = Math.max(0, Math.min(1, seg.value));
          const rotation = acc * 360;
          acc += clamped;
          return (
            <RingArc
              key={i}
              size={size}
              radius={radius}
              thickness={thickness}
              circumference={circumference}
              fraction={clamped}
              color={seg.color}
              rotation={rotation}
            />
          );
        })}
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center', justifyContent: 'center' }}>{children}</View>
    </View>
  );
}

function RingArc({ size, radius, thickness, circumference, fraction, color, rotation }: {
  size: number; radius: number; thickness: number; circumference: number; fraction: number; color: string; rotation: number;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, { toValue: fraction, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [fraction]);
  const dashOffset = progress.interpolate({ inputRange: [0, 1], outputRange: [circumference, 0] });
  if (fraction <= 0) return null;
  return (
    <AnimatedCircle
      cx={size / 2}
      cy={size / 2}
      r={radius}
      stroke={color}
      strokeWidth={thickness}
      strokeLinecap="round"
      fill="none"
      strokeDasharray={`${circumference} ${circumference}`}
      strokeDashoffset={dashOffset as unknown as number}
      originX={size / 2}
      originY={size / 2}
      rotation={rotation}
    />
  );
}
