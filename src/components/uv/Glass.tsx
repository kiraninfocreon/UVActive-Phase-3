import React from 'react';
import { View, type ViewStyle, type StyleProp } from 'react-native';
import { colors, radius } from '../../theme/tokens';

interface Props {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** soft = quieter surface, strong = raised panel. Default is the standard glass card. */
  tone?: 'soft' | 'default' | 'strong';
  rounded?: number;
}

/** Lovable `.glass` — translucent surface, hairline top highlight, no heavy border. */
export function Glass({ children, style, tone = 'default', rounded = radius.xl }: Props) {
  const bg = tone === 'soft' ? colors.glassSoft : tone === 'strong' ? colors.glassStrong : colors.glass;
  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderRadius: rounded,
          borderWidth: 1,
          borderColor: colors.glassBorder,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
