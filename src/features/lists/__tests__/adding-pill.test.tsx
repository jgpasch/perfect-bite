// The "Alex is adding" pill (spec 4.1, board 2 D): its look on the green, the 200 ms fade, and the
// dots that pulse, or keep still under Reduce Motion.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { avatarColors, listHeaderColors } from '@/components/appearance';
import { AisleColors, Motion, Palette, Sizes } from '@/constants/theme';
import { memberHue } from '@/domain/aisle-color';

import { AddingPill } from '../adding-pill';

jest.mock('@/global.css', () => ({}));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'me' }) }));

const mockMotion = { reduced: false, fades: [] as { kind: string; ms: number }[], repeats: 0 };
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const fade = (kind: string) => ({ duration: (ms: number) => (mockMotion.fades.push({ kind, ms }), { kind, ms }) });
  return {
    __esModule: true,
    default: { View },
    FadeIn: fade('in'),
    FadeOut: fade('out'),
    useReducedMotion: () => mockMotion.reduced,
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (value: unknown) => value,
    withDelay: (_delay: number, value: unknown) => value,
    withRepeat: (value: unknown) => {
      mockMotion.repeats += 1;
      return value;
    },
    withSequence: (...values: unknown[]) => values[0],
  };
});

const ME = 'me';
const ALEX = 'alex';
const SAM = 'sam';
const NAMES = new Map([
  [ALEX, 'Alex'],
  [SAM, 'Sam'],
]);

let tree: ReactTestRenderer | null = null;
function render(props: Partial<Parameters<typeof AddingPill>[0]> = {}) {
  act(() => {
    tree = create(<AddingPill userIds={[ALEX]} names={NAMES} currentUserId={ME} {...props} />);
  });
  return tree!;
}
const byTestId = (id: string) => tree!.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id);
const textOf = (n: ReactTestInstance): string => n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(() => {
  mockMotion.reduced = false;
  mockMotion.fades = [];
  mockMotion.repeats = 0;
});
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe('AddingPill', () => {
  test('a 32 pt header-wash pill with the 24 pt avatar, the text in onHeader and three dots', () => {
    render();
    const [pill] = byTestId('adding-pill');
    const style = StyleSheet.flatten(pill.props.style);
    const look = listHeaderColors(Palette.light).presencePill;
    expect(style.minHeight).toBe(Sizes.viewButton);
    expect(style.minHeight).toBe(32);
    expect(style.backgroundColor).toBe(look.fill);
    expect(look.fill).toBe(listHeaderColors(Palette.light).viewButton.fill);
    const [avatar] = byTestId(`adding-avatar-${ALEX}`);
    const avatarStyle = StyleSheet.flatten(avatar.props.style);
    expect(avatarStyle.width).toBe(24);
    expect(avatarStyle.backgroundColor).toBe(avatarColors(memberHue(ALEX), Palette.light, AisleColors.light).fill);
    const texts = pill.findAll((n) => n.type === ('Text' as never)).map(textOf);
    expect(texts).toEqual(['A', 'Alex is adding']);
    const label = pill.findAll((n) => n.type === ('Text' as never))[1];
    expect(StyleSheet.flatten(label.props.style).color).toBe(Palette.light.onHeader);
    expect(byTestId('adding-dot')).toHaveLength(3);
  });

  test('fades in and out over 200 ms', () => {
    render();
    expect(Motion.presenceFadeMs).toBe(200);
    const [pill] = byTestId('adding-pill');
    expect(pill.props.entering).toEqual({ kind: 'in', ms: 200 });
    expect(pill.props.exiting).toEqual({ kind: 'out', ms: 200 });
  });

  test('the dots pulse', () => {
    render();
    expect(mockMotion.repeats).toBe(3);
  });

  test('under Reduce Motion the dots keep still, at full strength', () => {
    mockMotion.reduced = true;
    render();
    expect(mockMotion.repeats).toBe(0);
    for (const dot of byTestId('adding-dot')) expect(StyleSheet.flatten(dot.props.style).opacity).toBe(1);
  });

  test('a static text element for VoiceOver, its label the text', () => {
    render({ userIds: [ALEX, SAM] });
    const [pill] = byTestId('adding-pill');
    expect(pill.props.accessible).toBe(true);
    expect(pill.props.accessibilityRole).toBe('text');
    expect(pill.props.accessibilityLabel).toBe('Alex and Sam are adding');
  });

  test('nothing for no one, or when hidden (add mode)', () => {
    render({ userIds: [] });
    expect(tree!.toJSON()).toBeNull();
    act(() => tree!.unmount());
    render({ hidden: true });
    expect(tree!.toJSON()).toBeNull();
  });
});
