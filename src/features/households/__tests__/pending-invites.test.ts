import { describe, expect, it, jest } from '@jest/globals';

import type { HouseholdInvite } from '@/features/households/invites';
import {
  inviteDateLabel,
  pendingInviteAccessibilityLabel,
  pendingInviteActions,
  pendingInviteDetail,
  pendingInviteErrorTitle,
  pendingInviteTitle,
} from '@/features/households/pending-invites';

jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

// Built from local times so the expected day doesn't depend on the test machine's time zone.
const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
const NOW = new Date(2026, 9, 11, 9);

const invite = (overrides: Partial<HouseholdInvite> = {}): HouseholdInvite => ({
  id: 'inv-1',
  email: 'sam.lee@gmail.com',
  invitedBy: 'John',
  createdAt: local(2026, 10, 11),
  expiresAt: local(2026, 10, 18),
  ...overrides,
});

describe('inviteDateLabel', () => {
  it('gives the month and day in the current year', () => {
    expect(inviteDateLabel(local(2026, 10, 18), NOW)).toBe('Oct 18');
    expect(inviteDateLabel(local(2026, 1, 1), NOW)).toBe('Jan 1');
    expect(inviteDateLabel(local(2026, 12, 31), NOW)).toBe('Dec 31');
  });

  it('uses the local day, not the UTC one', () => {
    expect(inviteDateLabel(local(2026, 10, 18, 0), NOW)).toBe('Oct 18');
    expect(inviteDateLabel(local(2026, 10, 18, 23), NOW)).toBe('Oct 18');
  });

  it('adds the year when it isn’t this year', () => {
    expect(inviteDateLabel(local(2027, 1, 2), new Date(2026, 11, 28))).toBe('Jan 2, 2027');
    expect(inviteDateLabel(local(2025, 12, 30), NOW)).toBe('Dec 30, 2025');
  });

  it('is null for a timestamp that doesn’t parse', () => {
    expect(inviteDateLabel('not a date', NOW)).toBeNull();
    expect(inviteDateLabel('', NOW)).toBeNull();
  });
});

describe('pendingInviteTitle', () => {
  it('is the email for an email invite', () => {
    expect(pendingInviteTitle({ email: 'sam.lee@gmail.com' })).toBe('sam.lee@gmail.com');
  });

  it('is "Invite link" for a link-only invite', () => {
    expect(pendingInviteTitle({ email: null })).toBe('Invite link');
    expect(pendingInviteTitle({ email: '  ' })).toBe('Invite link');
  });
});

describe('pendingInviteDetail', () => {
  it('names the sender and the expiry date', () => {
    expect(pendingInviteDetail(invite(), NOW)).toBe('Sent by John · expires Oct 18');
  });

  it('trims the sender’s name', () => {
    expect(pendingInviteDetail(invite({ invitedBy: '  Alex ' }), NOW)).toBe('Sent by Alex · expires Oct 18');
  });

  it('says only "Sent" when the sender is unknown', () => {
    expect(pendingInviteDetail(invite({ invitedBy: null }), NOW)).toBe('Sent · expires Oct 18');
    expect(pendingInviteDetail(invite({ invitedBy: ' ' }), NOW)).toBe('Sent · expires Oct 18');
  });

  it('leaves out an expiry that doesn’t parse', () => {
    expect(pendingInviteDetail(invite({ expiresAt: 'garbage' }), NOW)).toBe('Sent by John');
  });

  it('shows the year for an expiry next year', () => {
    expect(pendingInviteDetail(invite({ expiresAt: local(2027, 1, 3) }), new Date(2026, 11, 29))).toBe(
      'Sent by John · expires Jan 3, 2027',
    );
  });

  it('is the same for a link-only invite', () => {
    expect(pendingInviteDetail(invite({ email: null }), NOW)).toBe('Sent by John · expires Oct 18');
  });
});

describe('pendingInviteAccessibilityLabel', () => {
  it('reads both lines and the badge', () => {
    expect(pendingInviteAccessibilityLabel(invite(), NOW)).toBe(
      'sam.lee@gmail.com, Sent by John · expires Oct 18, Pending',
    );
    expect(pendingInviteAccessibilityLabel(invite({ email: null, invitedBy: null }), NOW)).toBe(
      'Invite link, Sent · expires Oct 18, Pending',
    );
  });
});

describe('pendingInviteActions', () => {
  it('offers Send again, Cancel invite and Cancel for an email invite', () => {
    expect(pendingInviteActions({ email: 'sam@x.com' })).toEqual({
      options: ['Send again', 'Cancel invite', 'Cancel'],
      actions: ['send-again', 'revoke', null],
      destructiveButtonIndex: 1,
      cancelButtonIndex: 2,
    });
  });

  it('has no Send again for a link-only invite', () => {
    expect(pendingInviteActions({ email: null })).toEqual({
      options: ['Cancel invite', 'Cancel'],
      actions: ['revoke', null],
      destructiveButtonIndex: 0,
      cancelButtonIndex: 1,
    });
  });
});

describe('pendingInviteErrorTitle', () => {
  it('names the action that failed', () => {
    expect(pendingInviteErrorTitle('send-again')).toBe("Couldn't send the invite again");
    expect(pendingInviteErrorTitle('revoke')).toBe("Couldn't cancel the invite");
  });
});
