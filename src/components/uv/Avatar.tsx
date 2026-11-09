import React from 'react';
import Svg, { Circle, Path, Rect, Defs, ClipPath, G } from 'react-native-svg';

/**
 * Illustrated avatars — NO photos. A girl avatar for female members, a
 * boy avatar for everyone else. Skin / hair / shirt vary deterministically
 * by member id so two members rarely look identical, yet the same member
 * always gets the same face on every screen (trainer app, member app, TV).
 */
const SKIN = ['#F1C7A5', '#E3A982', '#C98B63', '#A96B46', '#7C4A2E'];
const HAIR = ['#1B1210', '#3B2417', '#5A3720', '#8A5A2B', '#B7793A'];
const SHIRT = ['#FB5061', '#66D6C0', '#6EA8FF', '#F5B13D', '#B28DFF', '#FF8FB0'];

function pick<T>(arr: T[], seed: string, salt: number): T {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return arr[Math.abs(h) % arr.length];
}

export type AvatarSex = 'male' | 'female' | 'other' | null | undefined;

export function Avatar({ sex, seed = '', size = 40, ring }: { sex?: AvatarSex; seed?: string; size?: number; ring?: string }) {
  const skin = pick(SKIN, seed, 1);
  const hair = pick(HAIR, seed, 2);
  const shirt = pick(SHIRT, seed, 3);
  const female = sex === 'female';
  const id = `av-${seed.replace(/[^a-z0-9]/gi, '').slice(0, 8)}-${size}`;

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <ClipPath id={id}><Circle cx="50" cy="50" r="50" /></ClipPath>
      </Defs>
      <G clipPath={`url(#${id})`}>
        <Rect width="100" height="100" fill="#1E1E26" />
        {/* long hair behind the head for the girl avatar */}
        {female && <Path d="M24 52c0-22 11-34 26-34s26 12 26 34v30H24z" fill={hair} />}
        {/* shoulders / shirt */}
        <Path d="M12 100c2-20 16-30 38-30s36 10 38 30z" fill={shirt} />
        {/* neck */}
        <Rect x="43" y="58" width="14" height="16" rx="6" fill={skin} />
        {/* head */}
        <Circle cx="50" cy="44" r="19" fill={skin} />
        {female ? (
          <>
            {/* side-swept fringe */}
            <Path d="M31 42c0-14 8-22 20-22 11 0 19 8 19 20-8-3-14-8-17-14-3 9-12 15-22 16z" fill={hair} />
            {/* earring */}
            <Circle cx="31.5" cy="52" r="2" fill="#FFD27A" />
          </>
        ) : (
          <>
            {/* short cropped hair */}
            <Path d="M31 42c-1-13 8-22 20-22s21 8 19 22c-2-6-6-9-10-10-7 3-17 3-24 0-3 2-4 6-5 10z" fill={hair} />
          </>
        )}
        {/* eyes + smile */}
        <Circle cx="43.5" cy="46" r="1.8" fill="#1B1210" />
        <Circle cx="56.5" cy="46" r="1.8" fill="#1B1210" />
        <Path d="M44 53c3 3 9 3 12 0" stroke="#1B1210" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      </G>
      {ring ? <Circle cx="50" cy="50" r="48" fill="none" stroke={ring} strokeWidth="3" /> : null}
    </Svg>
  );
}
