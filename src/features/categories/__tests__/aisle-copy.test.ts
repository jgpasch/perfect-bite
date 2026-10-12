import { describe, expect, it } from '@jest/globals';

import { aisleHouseholdLine, sharedAisleFootnote } from '../aisle-copy';

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

describe('aisleHouseholdLine', () => {
  const home = { id: 'h1', name: 'Home' };
  const cabin = { id: 'h2', name: 'Cabin' };

  it("shows a custom aisle's household when the user is in more than one", () => {
    expect(aisleHouseholdLine('h1', [home, cabin])).toBe('Home');
    expect(aisleHouseholdLine('h2', [home, cabin])).toBe('Cabin');
  });

  it('tells two same-named aisles apart by household', () => {
    const lines = ['h1', 'h2'].map((id) => aisleHouseholdLine(id, [home, cabin]));
    expect(lines).toEqual(['Home', 'Cabin']);
  });

  it('shows nothing with one household', () => {
    expect(aisleHouseholdLine('h1', [home])).toBeNull();
  });

  it('shows nothing with no households loaded yet', () => {
    expect(aisleHouseholdLine('h1', [])).toBeNull();
  });

  it('shows nothing for a system aisle', () => {
    expect(aisleHouseholdLine(null, [home, cabin])).toBeNull();
  });

  it("shows nothing for a household that isn't on the device", () => {
    expect(aisleHouseholdLine('gone', [home, cabin])).toBeNull();
  });
});
