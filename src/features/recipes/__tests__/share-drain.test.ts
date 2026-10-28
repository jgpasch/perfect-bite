// The imports card's state (share-queue-status.ts). The share drain these tests used to cover is
// replaced by share-reconcile.ts (tested in share-reconcile.test.ts); rename this file to
// share-queue-status.test.ts (the session that replaced it couldn't rename files).
import { beforeEach, describe, expect, test } from '@jest/globals';

import { initI18n } from '@/i18n';

import {
  EMPTY_SHARE_QUEUE_STATUS,
  importName,
  importsBadgeCount,
  importsCardHeading,
  queuedShareDetail,
  shareFailureReason,
  waitReasonText,
  type FailedLinkShareImport,
  type QueuedLinkShare,
  type ShareQueueStatus,
} from '../share-queue-status';

const share = (id: string, over: Partial<QueuedLinkShare> = {}): QueuedLinkShare => ({
  id,
  url: `https://www.example.com/${id}`,
  title: null,
  listName: 'Groceries',
  onServer: false,
  ...over,
});
const failed = (id: string, over: Partial<FailedLinkShareImport> = {}): FailedLinkShareImport => ({
  id,
  url: `https://example.com/${id}`,
  title: null,
  errorCode: 'not_a_recipe',
  resetsAt: null,
  ...over,
});
const status = (over: Partial<ShareQueueStatus> = {}): ShareQueueStatus => ({ ...EMPTY_SHARE_QUEUE_STATUS, ...over });

beforeEach(() => {
  initI18n('en');
});

describe('shareFailureReason', () => {
  test("each server error code reads in the push's plain words", () => {
    expect(shareFailureReason('not_a_recipe', null)).toBe("That page doesn't look like a recipe");
    expect(shareFailureReason('invalid_url', null)).toBe("That doesn't look like a link");
    expect(shareFailureReason('not_entitled', null)).toBe("Recipe import isn't included in your plan.");
    expect(shareFailureReason('not_a_member', null)).toBe("You're no longer in that household.");
    expect(shareFailureReason('daily_limit', '2026-10-24T00:00:00.000Z')).toBe("You've reached today's limit. Try again tomorrow.");
    expect(shareFailureReason('fetch_failed', null)).toBe("Couldn't reach that site");
  });

  test('the monthly limit says when it resets, from resets_at, else the start of next month', () => {
    expect(shareFailureReason('limit_reached', '2026-11-01T00:00:00.000Z')).toBe(
      "You've used this month's recipe imports. They reset on Nov 1.",
    );
    expect(shareFailureReason('limit_reached', null, Date.parse('2026-12-15T10:00:00Z'))).toBe(
      "You've used this month's recipe imports. They reset on Jan 1.",
    );
  });

  test('anything else, or no code, is "Something went wrong."', () => {
    for (const code of ['internal', 'unavailable', 'lease_lost', 'plan_conflict', null]) {
      expect(shareFailureReason(code, null)).toBe('Something went wrong.');
    }
  });
});

describe('importsCardHeading', () => {
  test('nothing waiting or failed: no card', () => {
    expect(importsCardHeading(0, EMPTY_SHARE_QUEUE_STATUS)).toBeNull();
  });

  test('failed shares and failed in-app imports count together, with the waiting ones under', () => {
    expect(importsCardHeading(1, status({ failed: [failed('a')] }))).toEqual({
      tone: 'failed',
      title: "Couldn't import 2 recipes",
      subtitle: null,
    });
    expect(importsCardHeading(0, status({ failed: [failed('a')], queued: [share('b', { onServer: true })] }))).toEqual({
      tone: 'failed',
      title: "Couldn't import 1 recipe",
      subtitle: '1 more waiting',
    });
    expect(importsCardHeading(0, status({ failed: [failed('a')], queued: [share('b')], offline: true }))?.subtitle).toBe(
      "1 more waiting · You're offline. They'll import when you're back.",
    );
  });

  test('waiting: in the background, or offline only while the server lacks some of them', () => {
    const queued = [share('a', { onServer: true }), share('b')];
    expect(importsCardHeading(0, status({ queued }))).toEqual({
      tone: 'waiting',
      title: '2 recipes waiting',
      subtitle: "We'll prepare them in the background.",
    });
    expect(importsCardHeading(0, status({ queued, offline: true }))?.subtitle).toBe(
      "You're offline. They'll import when you're back.",
    );
    // All on the server: being offline changes nothing for them.
    expect(waitReasonText(status({ queued: [share('a', { onServer: true })], offline: true }))).toBe(
      "We'll prepare them in the background.",
    );
  });
});

describe('importsBadgeCount', () => {
  test('waiting shares, failed shares and failed in-app imports', () => {
    expect(importsBadgeCount(EMPTY_SHARE_QUEUE_STATUS, 0)).toBe(0);
    expect(importsBadgeCount(status({ queued: [share('a'), share('b', { onServer: true })], failed: [failed('c')] }), 2)).toBe(5);
  });
});

describe('rows', () => {
  test('a waiting row: the host, then where it goes (a list, or a recipe-only household)', () => {
    expect(queuedShareDetail(share('a'))).toBe('example.com · to Groceries');
    expect(queuedShareDetail(share('a', { listName: null, householdName: 'Smith home' }))).toBe('example.com · to Smith home');
    expect(queuedShareDetail(share('a', { listName: null }))).toBe('example.com');
    expect(queuedShareDetail(share('a', { url: 'not a link', listName: null }))).toBe('not a link');
  });

  test('a name: the title, else the host without www, else the link', () => {
    expect(importName({ url: 'https://www.example.com/x', title: '  Pho ' })).toBe('Pho');
    expect(importName({ url: 'https://www.example.com/x', title: '   ' })).toBe('example.com');
    expect(importName({ url: 'not a link', title: null })).toBe('not a link');
  });
});
