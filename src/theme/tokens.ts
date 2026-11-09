// ── UV Active design tokens ──────────────────────────────────────────
// Ported 1:1 from the Lovable reference design (src/index.css, the
// `.dark` OLED theme): near-black base, ONE coral accent, a mint
// "recovery" counterpart, glass surfaces instead of bordered boxes,
// Space Grotesk for text and JetBrains Mono for every number.
// HSL values from the Lovable CSS are converted to hex here because
// React Native has no CSS variables. The trainer AND member apps share
// this file's values so the whole product reads as one system.

export const colors = {
  background: '#09090B', // hsl(240 12% 4%)
  foreground: '#EEEEF1', // hsl(240 8% 94%)
  card: '#101014', //       hsl(240 10% 7%)
  cardForeground: '#EEEEF1',

  primary: '#FB5061', //    hsl(354 96% 65%)  — UVActive coral
  primaryForeground: '#FFFFFF',
  primaryLight: '#FD8793', // hsl(354 96% 76%)

  recovery: '#66D6C0', //   hsl(168 58% 62%)  — cool counterpart accent
  recoveryForeground: '#09090B',

  secondary: '#1C1C21',
  secondaryForeground: '#B2B2BD',

  muted: '#1A1A1F',
  mutedForeground: '#7E7E8B', // hsl(240 5% 52%)

  destructive: '#E04B52',
  destructiveForeground: '#FFFFFF',

  border: '#1E1E24',
  input: '#1E1E24',
  ring: '#FB5061',

  shark: '#09090B',
  sharkLight: '#16161B',

  // Glass system — translucent white over the OLED base (Lovable
  // `--glass-a` family). Use these instead of solid card fills.
  glass: 'rgba(255,255,255,0.045)',
  glassStrong: 'rgba(255,255,255,0.075)',
  glassSoft: 'rgba(255,255,255,0.028)',
  glassBorder: 'rgba(255,255,255,0.07)',
  track: 'rgba(255,255,255,0.08)',

  // Heart-rate zone scale shared across the whole product (Formula
  // Engine, Admin Panel session leaderboard, Branch Portal, Lovable TV
  // dashboard). Never redefine these locally.
  zone: {
    0: '#39FF14', // Standby
    1: '#669FFF', // Recovery
    2: '#4263CF', // Aerobic
    3: '#1E2C7C', // Fitness
    4: '#FF5E73', // Burn
    5: '#FF0000', // Peak
  },

  success: '#4ADE80',
  warning: '#F5B13D',
  info: '#6EA8FF',
};

export const fonts = {
  heading: 'SpaceGrotesk_700Bold',
  headingMedium: 'SpaceGrotesk_500Medium',
  body: 'SpaceGrotesk_400Regular',
  bodyMedium: 'SpaceGrotesk_500Medium',
  bodySemiBold: 'SpaceGrotesk_600SemiBold',
  // Every numeral is technical — Lovable's `.metric` utility.
  metric: 'JetBrainsMono_500Medium',
  metricBold: 'JetBrainsMono_700Bold',
};

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28, // Lovable card radius (1.75rem)
  full: 999,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const shadow = {
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 4,
  },
  glowPrimary: {
    shadowColor: '#FB5061',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 16,
    elevation: 8,
  },
};

/** Lovable `.section-title` / `.metric-label` text treatments. */
export const type = {
  sectionTitle: {
    fontFamily: fonts.bodySemiBold,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase' as const,
    color: colors.mutedForeground,
  },
  metricLabel: {
    fontFamily: fonts.body,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase' as const,
    color: colors.mutedForeground,
  },
};
