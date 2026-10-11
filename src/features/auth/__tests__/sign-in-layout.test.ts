import { describe, expect, it } from '@jest/globals';

import { signInOverflows, signInShapeHeight } from '../sign-in-layout';

const sizes = { max: 92, min: 46, gap: 10 };

describe('signInShapeHeight', () => {
  it('uses the full size when there is more than enough room', () => {
    expect(signInShapeHeight(400, sizes)).toBe(92);
  });

  it('uses the full size when the two rows and the gap fit exactly', () => {
    expect(signInShapeHeight(92 * 2 + 10, sizes)).toBe(92);
  });

  it('shrinks the shapes to fit a shorter space', () => {
    // (150 - 10) / 2 = 70
    expect(signInShapeHeight(150, sizes)).toBe(70);
  });

  it('rounds down so the rows never overflow the space', () => {
    // (151 - 10) / 2 = 70.5
    expect(signInShapeHeight(151, sizes)).toBe(70);
  });

  it('keeps shapes at exactly the minimum', () => {
    expect(signInShapeHeight(46 * 2 + 10, sizes)).toBe(46);
  });

  it('drops the shapes once they would be shorter than the minimum', () => {
    expect(signInShapeHeight(46 * 2 + 9, sizes)).toBe(0);
    expect(signInShapeHeight(20, sizes)).toBe(0);
  });

  it('has no shapes when there is no space, or before layout', () => {
    expect(signInShapeHeight(0, sizes)).toBe(0);
    expect(signInShapeHeight(-30, sizes)).toBe(0);
    expect(signInShapeHeight(Number.NaN, sizes)).toBe(0);
  });

  it('accounts for the gap between the rows', () => {
    expect(signInShapeHeight(200, { max: 200, min: 0, gap: 0 })).toBe(100);
    expect(signInShapeHeight(200, { max: 200, min: 0, gap: 40 })).toBe(80);
  });
});

describe('signInOverflows', () => {
  it('does not scroll when the content is exactly the screen height', () => {
    expect(signInOverflows(844, 844)).toBe(false);
  });

  it('ignores sub-point rounding', () => {
    expect(signInOverflows(844.6, 844)).toBe(false);
    expect(signInOverflows(845, 844)).toBe(false);
  });

  it('scrolls when the content is genuinely taller', () => {
    expect(signInOverflows(845.5, 844)).toBe(true);
    expect(signInOverflows(900, 400)).toBe(true);
  });

  it('does not scroll when shorter, or before the frame is measured', () => {
    expect(signInOverflows(600, 844)).toBe(false);
    expect(signInOverflows(600, 0)).toBe(false);
  });
});
