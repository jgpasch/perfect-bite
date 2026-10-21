import { describe, expect, it } from "vitest";

import {
  AI_PHOTO_BLOCK_THRESHOLD,
  AI_PHOTO_BLOCK_WINDOW_DAYS,
  AI_PHOTOS_BLOCKED,
  blockedLine,
  refusalsHref,
  refusalsLine,
  showsBlockedBadge,
  unblockedMessage,
} from "./ai-photo-block";
import { parseAiCallsParams } from "./ai-calls";

const USER = "11111111-1111-1111-1111-111111111111";

describe("the rule", () => {
  it("matches the trigger's: 3 refusals in 30 days", () => {
    expect(AI_PHOTO_BLOCK_THRESHOLD).toBe(3);
    expect(AI_PHOTO_BLOCK_WINDOW_DAYS).toBe(30);
    expect(AI_PHOTOS_BLOCKED).toBe("AI photos blocked");
  });
});

describe("blockedLine", () => {
  // Noon UTC, so it's the 21st in any time zone the portal runs in.
  it("says since when and after how many", () => {
    expect(blockedLine({ blocked_at: "2026-10-21T12:00:00+00:00", refusals: 3 })).toBe(
      "Blocked since Oct 21, 2026 after 3 refused prompts",
    );
  });

  it("says prompt for one", () => {
    expect(blockedLine({ blocked_at: "2026-01-02T12:00:00+00:00", refusals: 1 })).toBe(
      "Blocked since Jan 2, 2026 after 1 refused prompt",
    );
  });
});

describe("refusalsLine", () => {
  it("is null with none", () => {
    expect(refusalsLine(0)).toBeNull();
    expect(refusalsLine(-1)).toBeNull();
  });

  it("counts toward the threshold", () => {
    expect(refusalsLine(1)).toBe("1 refused prompt in the last 30 days (blocks at 3)");
    expect(refusalsLine(2)).toBe("2 refused prompts in the last 30 days (blocks at 3)");
  });
});

describe("refusalsHref", () => {
  it("is the flagged calls, filtered by the user and refused", () => {
    expect(refusalsHref(USER)).toBe(`/ai-calls?kind=flagged&flag=refused&user=${USER}`);
  });

  it("reads back as both filters, with no task, so moderation and image rows both show", () => {
    const query = Object.fromEntries(new URLSearchParams(refusalsHref(USER).split("?")[1]));
    expect(parseAiCallsParams(query)).toMatchObject({ kind: "flagged", flag: "refused", user: USER, task: "", status: "" });
  });
});

describe("unblockedMessage", () => {
  it("names the user", () => {
    expect(unblockedMessage("ann@example.com")).toBe("Unblocked AI photos for ann@example.com");
    expect(unblockedMessage(null)).toBe("Unblocked AI photos for the user");
  });
});

describe("showsBlockedBadge", () => {
  it("only on a blocked user's refused calls", () => {
    expect(showsBlockedBadge({ flag: "refused", user_ai_photos_blocked: true })).toBe(true);
    expect(showsBlockedBadge({ flag: "refused", user_ai_photos_blocked: false })).toBe(false);
    expect(showsBlockedBadge({ flag: "not_food", user_ai_photos_blocked: true })).toBe(false);
    expect(showsBlockedBadge({ flag: null, user_ai_photos_blocked: true })).toBe(false);
  });
});
