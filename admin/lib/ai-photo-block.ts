// The wording of AI photo blocks (spec 4.12, 6.11): the user page's AI photos card, the badge and
// the Unblock dialog's message, kept out of the components so they can be tested. A user with
// AI_PHOTO_BLOCK_THRESHOLD refused prompts in AI_PHOTO_BLOCK_WINDOW_DAYS days is blocked by a
// trigger (private.ai_photo_block_threshold and _window); keep these in step with it.
import { aiCallsHref } from "./ai-calls";
import { mediumDate } from "./format";
import type { AiPhotoBlock } from "./types";

export const AI_PHOTO_BLOCK_THRESHOLD = 3;
export const AI_PHOTO_BLOCK_WINDOW_DAYS = 30;

/** The badge on a blocked user, in the Users list, on their page and on their refused calls. */
export const AI_PHOTOS_BLOCKED = "AI photos blocked";

function refusedPrompts(count: number): string {
  return `${count.toLocaleString("en-US")} refused ${count === 1 ? "prompt" : "prompts"}`;
}

/** "Blocked since Oct 21, 2026 after 3 refused prompts". */
export function blockedLine(block: Pick<AiPhotoBlock, "blocked_at" | "refusals">): string {
  return `Blocked since ${mediumDate(block.blocked_at)} after ${refusedPrompts(block.refusals)}`;
}

/** "2 refused prompts in the last 30 days (blocks at 3)", or null with none. */
export function refusalsLine(count: number): string | null {
  if (count <= 0) return null;
  return `${refusedPrompts(count)} in the last ${AI_PHOTO_BLOCK_WINDOW_DAYS} days (blocks at ${AI_PHOTO_BLOCK_THRESHOLD})`;
}

/** The user's refusals: the AI calls page's flagged calls, filtered by them and `refused` (moderation and image rows alike). */
export function refusalsHref(userId: string): string {
  return aiCallsHref({ kind: "flagged", flag: "refused", user: userId });
}

/** "Unblocked AI photos for ann@example.com". */
export function unblockedMessage(email: string | null): string {
  return `Unblocked AI photos for ${email ?? "the user"}`;
}

/** Whether a call's row gets the badge: a refused call of a user who's blocked now. */
export function showsBlockedBadge(call: { flag: string | null; user_ai_photos_blocked: boolean }): boolean {
  return call.flag === "refused" && call.user_ai_photos_blocked;
}
