import { describe, expect, it } from "vitest";

import {
  AI_CALL_KINDS,
  AI_CALL_KIND_KEYS,
  aiCallsHref,
  aiFlagsLine,
  callBadge,
  callUser,
  durationText,
  errorFirstLine,
  filterOptions,
  FLAG_KEYS,
  flagLabel,
  linkLabel,
  listArgs,
  parseAiCallsParams,
  parseKind,
  prettyBody,
  signedUrlsByPath,
  STATUS_KEYS,
  STATUS_LABELS,
  statusLabel,
  TASK_KEYS,
  taskLabel,
  tokensText,
} from "./ai-calls";

const USER = "0b9d6f4e-2c1a-4e8b-9f3d-5a7c1e2b3d4f";

describe("errorFirstLine", () => {
  it("keeps the first line of a multi-line error", () => {
    expect(errorFirstLine("AI_APICallError: Overloaded\n    at fetch (x.ts:1)\n    at run")).toBe("AI_APICallError: Overloaded");
    expect(errorFirstLine("one\r\ntwo")).toBe("one");
  });

  it("skips blank leading lines and trims", () => {
    expect(errorFirstLine("\n  \n  TimeoutError: took 20000 ms  \nmore")).toBe("TimeoutError: took 20000 ms");
  });

  it("is empty for no error or only whitespace", () => {
    expect(errorFirstLine(null)).toBe("");
    expect(errorFirstLine("")).toBe("");
    expect(errorFirstLine(" \n\t\n")).toBe("");
  });

  it("returns a one-line error as it is", () => {
    expect(errorFirstLine("error: boom")).toBe("error: boom");
  });
});

describe("prettyBody", () => {
  it("pretty-prints a JSON object or array", () => {
    expect(prettyBody('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe(
      '{\n  "type": "error",\n  "error": {\n    "type": "overloaded_error",\n    "message": "Overloaded"\n  }\n}',
    );
    expect(prettyBody("[1,2]")).toBe("[\n  1,\n  2\n]");
  });

  it("leaves plain text alone", () => {
    expect(prettyBody("Bad Gateway")).toBe("Bad Gateway");
    expect(prettyBody('{"cut off at 4000 characters')).toBe('{"cut off at 4000 characters');
  });

  it("leaves JSON scalars alone, so a number or string reads as sent", () => {
    expect(prettyBody("42")).toBe("42");
    expect(prettyBody('"quoted"')).toBe('"quoted"');
    expect(prettyBody("null")).toBe("null");
  });

  it("says (none) for nothing", () => {
    expect(prettyBody(null)).toBe("(none)");
    expect(prettyBody("")).toBe("(none)");
    expect(prettyBody("   \n")).toBe("(none)");
  });
});

describe("parseKind and parseAiCallsParams", () => {
  it("reads each tab, and anything else as Flagged", () => {
    expect(AI_CALL_KIND_KEYS).toEqual(["flagged", "failed", "photos"]);
    expect(parseKind("failed")).toBe("failed");
    expect(parseKind("photos")).toBe("photos");
    expect(parseKind(" flagged ")).toBe("flagged");
    expect(parseKind(undefined)).toBe("flagged");
    expect(parseKind("")).toBe("flagged");
    expect(parseKind("all")).toBe("flagged");
    expect(parseKind("toString")).toBe("flagged");
    expect(parseKind(["failed", "photos"])).toBe("failed");
  });

  it("reads every filter and the page on Flagged", () => {
    expect(
      parseAiCallsParams({ kind: "flagged", task: "recipePhotoDescription", status: "ok", flag: "not_food", user: USER, page: "3" }),
    ).toEqual({ kind: "flagged", task: "recipePhotoDescription", status: "ok", flag: "not_food", user: USER, page: 3 });
  });

  it("defaults to Flagged, page 1, no filters", () => {
    expect(parseAiCallsParams({})).toEqual({ kind: "flagged", task: "", status: "", flag: "", user: "", page: 1 });
  });

  it("drops the flag off Flagged, and task and status on AI photos", () => {
    expect(parseAiCallsParams({ kind: "failed", task: "extractRecipe", status: "api_error", flag: "refused" })).toEqual({
      kind: "failed",
      task: "extractRecipe",
      status: "api_error",
      flag: "",
      user: "",
      page: 1,
    });
    expect(parseAiCallsParams({ kind: "photos", task: "categorize", status: "timeout", flag: "refused", user: USER })).toEqual({
      kind: "photos",
      task: "",
      status: "",
      flag: "",
      user: USER,
      page: 1,
    });
  });

  it("drops a user that isn't a uuid and lower-cases one that is", () => {
    expect(parseAiCallsParams({ user: "someone@example.com" }).user).toBe("");
    expect(parseAiCallsParams({ user: USER.toUpperCase() }).user).toBe(USER);
  });

  it("trims filters and reads a bad page as 1", () => {
    const params = parseAiCallsParams({ kind: "failed", task: "  extractRecipe ", page: "-2" });
    expect(params.task).toBe("extractRecipe");
    expect(params.page).toBe(1);
    expect(parseAiCallsParams({ page: "abc" }).page).toBe(1);
  });
});

describe("aiCallsHref", () => {
  it("always names the tab", () => {
    expect(aiCallsHref({ kind: "flagged" })).toBe("/ai-calls?kind=flagged");
    expect(aiCallsHref({ kind: "photos", page: 1 })).toBe("/ai-calls?kind=photos");
  });

  it("puts the filters and the page in a fixed order, leaving blanks out", () => {
    expect(aiCallsHref({ kind: "failed", task: "extractRecipe" })).toBe("/ai-calls?kind=failed&task=extractRecipe");
    expect(aiCallsHref({ kind: "flagged", user: USER })).toBe(`/ai-calls?kind=flagged&user=${USER}`);
    expect(
      aiCallsHref({ kind: "flagged", task: "recipePhotoImage", status: "refused", flag: "refused", user: USER, page: 2 }),
    ).toBe(`/ai-calls?kind=flagged&task=recipePhotoImage&status=refused&flag=refused&user=${USER}&page=2`);
    expect(aiCallsHref({ kind: "failed", task: " ", status: "", flag: "", user: "", page: 1 })).toBe("/ai-calls?kind=failed");
  });

  it("round-trips through parseAiCallsParams", () => {
    const params = { kind: "failed", task: "matchRecipeSteps", status: "timeout", flag: "", user: USER, page: 4 } as const;
    const search = Object.fromEntries(new URL(aiCallsHref(params), "http://x").searchParams);
    expect(parseAiCallsParams(search)).toEqual(params);
  });
});

describe("listArgs", () => {
  it("sends blank filters as null and pages by 50", () => {
    expect(listArgs({ kind: "failed", task: "", status: "", flag: "", user: "", page: 1 })).toEqual({
      p_kind: "failed",
      p_task: null,
      p_status: null,
      p_flag: null,
      p_user_id: null,
      p_limit: 50,
      p_offset: 0,
    });
    expect(listArgs({ kind: "flagged", task: "categorize", status: "ok", flag: "content_filter", user: USER, page: 3 })).toEqual({
      p_kind: "flagged",
      p_task: "categorize",
      p_status: "ok",
      p_flag: "content_filter",
      p_user_id: USER,
      p_limit: 50,
      p_offset: 100,
    });
  });
});

describe("labels", () => {
  it("names every task readably", () => {
    expect(TASK_KEYS.map(taskLabel)).toEqual([
      "Categorize",
      "Recipe import",
      "Photo import",
      "Tag suggestions",
      "Step matching",
      "AI photo: description",
      "AI photo: moderation",
      "AI photo: image",
    ]);
    expect(taskLabel("recipePhotoModeration")).toBe("AI photo: moderation");
  });

  it("names every status and flag", () => {
    expect(STATUS_KEYS.map(statusLabel)).toEqual(["OK", "API error", "Invalid output", "Timed out", "Refused", "Error"]);
    expect(FLAG_KEYS.map(flagLabel)).toEqual(["Not food", "Refused", "Content filter"]);
  });

  it("shows an unknown one raw, not fooled by Object.prototype", () => {
    expect(taskLabel("summarizeRecipe")).toBe("summarizeRecipe");
    expect(statusLabel("cancelled")).toBe("cancelled");
    expect(flagLabel("toString")).toBe("toString");
    expect(taskLabel("constructor")).toBe("constructor");
  });

  it("has an empty state per tab", () => {
    expect(AI_CALL_KIND_KEYS.map((kind) => AI_CALL_KINDS[kind].label)).toEqual(["Flagged", "Failed", "AI photos"]);
    expect(AI_CALL_KINDS.flagged.empty).toBe("No flagged AI calls in the last 180 days.");
    expect(AI_CALL_KINDS.failed.empty).toBe("No failed AI calls in the last 30 days.");
    expect(AI_CALL_KINDS.photos.empty).toBe("No AI photos in the last 30 days.");
  });
});

describe("callBadge", () => {
  it("shows the flag over the status", () => {
    expect(callBadge({ status: "ok", flag: "not_food" })).toEqual({ label: "Not food", tone: "danger" });
    expect(callBadge({ status: "refused", flag: "refused" })).toEqual({ label: "Refused", tone: "danger" });
    expect(callBadge({ status: "ok", flag: "content_filter" })).toEqual({ label: "Content filter", tone: "danger" });
  });

  it("shows the status without a flag", () => {
    expect(callBadge({ status: "api_error", flag: null })).toEqual({ label: "API error", tone: "danger" });
    expect(callBadge({ status: "ok", flag: null })).toEqual({ label: "OK", tone: "ok" });
    expect(callBadge({ status: "weird", flag: null })).toEqual({ label: "weird", tone: "danger" });
  });
});

describe("filterOptions", () => {
  it("lists the known values, minus the excluded ones", () => {
    expect(filterOptions(STATUS_LABELS, "").map((o) => o.value)).toEqual(STATUS_KEYS);
    expect(filterOptions(STATUS_LABELS, "", ["ok"]).map((o) => o.value)).toEqual(STATUS_KEYS.filter((s) => s !== "ok"));
  });

  it("adds an unknown current value last, once", () => {
    expect(filterOptions(STATUS_LABELS, "cancelled").at(-1)).toEqual({ value: "cancelled", label: "cancelled" });
    expect(filterOptions(STATUS_LABELS, "timeout")).toHaveLength(STATUS_KEYS.length);
    // An excluded value that's current stays choosable.
    expect(filterOptions(STATUS_LABELS, "ok", ["ok"]).at(-1)).toEqual({ value: "ok", label: "ok" });
  });
});

describe("callUser", () => {
  it("links the email to the user", () => {
    expect(callUser({ user_id: USER, user_email: "ann@example.com" })).toEqual({
      kind: "user",
      label: "ann@example.com",
      href: `/users/${USER}`,
    });
  });

  it("says Deleted user when the email is gone, Dev script with no user id", () => {
    expect(callUser({ user_id: USER, user_email: null })).toEqual({ kind: "deleted", label: "Deleted user" });
    expect(callUser({ user_id: null, user_email: null })).toEqual({ kind: "script", label: "Dev script" });
  });
});

describe("durationText and tokensText", () => {
  it("reads milliseconds and seconds", () => {
    expect(durationText(0)).toBe("0 ms");
    expect(durationText(850)).toBe("850 ms");
    expect(durationText(1000)).toBe("1 s");
    expect(durationText(12_449)).toBe("12.4 s");
  });

  it("lists the token counts it has", () => {
    expect(tokensText({ input_tokens: 1234, output_tokens: 56, cached_input_tokens: 1000, reasoning_tokens: 0 })).toBe(
      "1,234 in · 56 out · 1,000 cached · 0 reasoning",
    );
    expect(tokensText({ input_tokens: 10, output_tokens: null, cached_input_tokens: null, reasoning_tokens: null })).toBe("10 in");
    expect(tokensText({ input_tokens: null, output_tokens: null, cached_input_tokens: null, reasoning_tokens: null })).toBe("—");
  });
});

describe("linkLabel", () => {
  it("reads fallbacks as fallbacks", () => {
    expect(linkLabel("fallback", "extractRecipe", "extractRecipe")).toBe("Fallback");
    expect(linkLabel("primary", "extractRecipe", "extractRecipe")).toBe("Primary");
    expect(linkLabel("fallback", "recipePhotoDescription", "recipePhotoDescription")).toBe("Fallback");
  });

  it("links an AI photo's description and image call to each other", () => {
    expect(linkLabel("fallback", "recipePhotoDescription", "recipePhotoImage")).toBe("Image call");
    expect(linkLabel("primary", "recipePhotoImage", "recipePhotoDescription")).toBe("Description");
  });

  it("links an AI photo's moderation check to its description", () => {
    expect(linkLabel("fallback", "recipePhotoDescription", "recipePhotoModeration")).toBe("Moderation");
    expect(linkLabel("primary", "recipePhotoModeration", "recipePhotoDescription")).toBe("Description");
    expect(linkLabel("fallback", "recipePhotoModeration", "recipePhotoModeration")).toBe("Fallback");
    expect(linkLabel("primary", "recipePhotoModeration", "recipePhotoImage")).toBe("Primary");
  });
});

describe("signedUrlsByPath", () => {
  const paths = ["h1/r1/a.jpg", "h1/r2/b.jpg", "h2/r3/c.jpg"];

  it("maps each path to its URL, null for a gone object or a missing entry", () => {
    const urls = signedUrlsByPath(paths, [
      { path: "h1/r1/a.jpg", signedUrl: "https://x/sign/a?token=1", error: null },
      { path: "h1/r2/b.jpg", signedUrl: null, error: "Either the object does not exist or you do not have access to it" },
    ]);
    expect([...urls]).toEqual([
      ["h1/r1/a.jpg", "https://x/sign/a?token=1"],
      ["h1/r2/b.jpg", null],
      ["h2/r3/c.jpg", null],
    ]);
  });

  it("ignores entries for paths it didn't ask for, and a failed answer", () => {
    expect(signedUrlsByPath(["a"], [{ path: "b", signedUrl: "https://x/b", error: null }]).get("a")).toBeNull();
    expect([...signedUrlsByPath(["a"], null)]).toEqual([["a", null]]);
    expect(signedUrlsByPath([], null).size).toBe(0);
  });
});

describe("aiFlagsLine", () => {
  it("counts each flag in the fixed order", () => {
    expect(aiFlagsLine({ refused: 1, not_food: 2 })).toBe("2 not food, 1 refused in the last 30 days");
    expect(aiFlagsLine({ content_filter: 1 })).toBe("1 content filter in the last 30 days");
    expect(aiFlagsLine({ content_filter: 3, refused: 1, not_food: 1200 })).toBe(
      "1,200 not food, 1 refused, 3 content filter in the last 30 days",
    );
  });

  it("puts an unknown flag last, raw", () => {
    expect(aiFlagsLine({ jailbreak: 1, refused: 2 })).toBe("2 refused, 1 jailbreak in the last 30 days");
  });

  it("says None with no flags", () => {
    expect(aiFlagsLine({})).toBe("None");
    expect(aiFlagsLine(null)).toBe("None");
    expect(aiFlagsLine(undefined)).toBe("None");
    expect(aiFlagsLine({ not_food: 0 })).toBe("None");
  });
});
