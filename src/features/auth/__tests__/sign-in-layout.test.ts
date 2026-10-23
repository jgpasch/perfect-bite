import { describe, expect, it } from '@jest/globals';

import { signInOverflows, signInHeroSize } from '../sign-in-layout';

const sizes = { max: 200, min: 100 };

describe('signInHeroSize', () => {
  it('uses the full size when there is more than enough room', () => {
    expect(signInHeroSize(400, sizes)).toBe(200);
  });

  it('uses the full size at an exact fit', () => {
    expect(signInHeroSize(200, sizes)).toBe(200);
  });

  it('shrinks the bruschetta to fit a shorter space, rounding down', () => {
    expect(signInHeroSize(150.6, sizes)).toBe(150);
  });

  it('keeps the bruschetta at exactly the minimum', () => {
    expect(signInHeroSize(100, sizes)).toBe(100);
  });

  it('drops the bruschetta once it would be smaller than the minimum', () => {
    expect(signInHeroSize(99, sizes)).toBe(0);
    expect(signInHeroSize(20, sizes)).toBe(0);
  });

  it('has no bruschetta when there is no space, or before layout', () => {
    expect(signInHeroSize(0, sizes)).toBe(0);
    expect(signInHeroSize(-30, sizes)).toBe(0);
    expect(signInHeroSize(Number.NaN, sizes)).toBe(0);
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
