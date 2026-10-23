import { describe, expect, it } from '@jest/globals';

import { sharedAisleFootnote } from '../aisle-copy';

describe('sharedAisleFootnote', () => {
  it("names the list's household", () => {
    expect(sharedAisleFootnote('Test home')).toBe('Changes it for everyone in Test home.');
  });

  it('says "your household" with no name', () => {
    expect(sharedAisleFootnote(null)).toBe('Changes it for everyone in your household.');
  });

  it('treats a blank name as no name and trims a padded one', () => {
    expect(sharedAisleFootnote('   ')).toBe('Changes it for everyone in your household.');
    expect(sharedAisleFootnote('')).toBe('Changes it for everyone in your household.');
    expect(sharedAisleFootnote('  Cabin ')).toBe('Changes it for everyone in Cabin.');
  });

  it('no longer says the change is just for you', () => {
    expect(sharedAisleFootnote('Test home')).not.toMatch(/just for you/i);
  });
});
