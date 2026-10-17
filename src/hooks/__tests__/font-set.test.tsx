// The font trial's in-memory store (DESIGN.md Fonts): what `useTheme()` reads, so a switch re-renders
// every screen in the new fonts at once.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ThemedText } from '@/components/themed-text';
import { applyFontSet, getFontSet, readFontSet, subscribeFontSet } from '@/hooks/font-set';

jest.mock('@/global.css', () => ({}));

let tree: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  applyFontSet('bricolage');
});

describe('readFontSet', () => {
  it('reads each saved set', () => {
    for (const set of ['bricolage', 'fraunces', 'youngSerif', 'jakarta', 'nunito'] as const) expect(readFontSet(set)).toBe(set);
  });

  it('falls back to bricolage for anything unknown', () => {
    for (const value of [null, undefined, '', 'Fraunces', 'young-serif', 'comic', 3, true, {}, ['nunito']]) {
      expect(readFontSet(value)).toBe('bricolage');
    }
  });
});

describe('the store', () => {
  it('starts on bricolage', () => {
    expect(getFontSet()).toBe('bricolage');
  });

  it('tells its subscribers about a switch, once, and not after they leave', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeFontSet(listener);
    applyFontSet('nunito');
    expect(getFontSet()).toBe('nunito');
    expect(listener).toHaveBeenCalledTimes(1);
    // The same set again is no change.
    applyFontSet('nunito');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    applyFontSet('jakarta');
    expect(getFontSet()).toBe('jakarta');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('useTheme', () => {
  const style = () => StyleSheet.flatten(tree!.root.findByType(Text).props.style);

  it('re-renders a ThemedText in the new set at once', () => {
    act(() => {
      tree = create(<ThemedText variant="largeTitle">Recipes</ThemedText>);
    });
    expect(style()).toMatchObject({ fontFamily: 'Bricolage Grotesque', fontWeight: '800', fontSize: 40, letterSpacing: -1 });

    act(() => applyFontSet('fraunces'));
    expect(style()).toMatchObject({ fontFamily: 'Fraunces', fontWeight: '700', fontSize: 40, letterSpacing: -0.4 });

    act(() => applyFontSet('youngSerif'));
    expect(style()).toMatchObject({ fontFamily: 'Young Serif', fontWeight: '400', fontSize: 40, letterSpacing: -0.4 });

    act(() => applyFontSet('bricolage'));
    expect(style()).toMatchObject({ fontFamily: 'Bricolage Grotesque', fontWeight: '800' });
  });

  it("switches body text to the set's body face", () => {
    act(() => {
      tree = create(<ThemedText variant="body">Limes</ThemedText>);
    });
    expect(style()).toMatchObject({ fontFamily: 'Figtree', fontWeight: '500', fontSize: 17 });
    act(() => applyFontSet('nunito'));
    expect(style()).toMatchObject({ fontFamily: 'Nunito Sans', fontWeight: '500', fontSize: 17 });
    act(() => applyFontSet('jakarta'));
    expect(style()).toMatchObject({ fontFamily: 'Plus Jakarta Sans', fontWeight: '500' });
  });
});
