import { describe, expect, it } from "vitest";

import type { UserActivityEntry } from "./types";
import {
  actionArea,
  APP_ACTION_KEYS,
  areaCounts,
  dayLabel,
  entrySentence,
  foldEntries,
  groupByDay,
  hasFilters,
  householdSuffix,
  lineSentence,
  parseUserActivityParams,
  sentenceText,
  timeText,
  toggleArea,
  userActionLabel,
  userActionOptions,
  userActivityArgs,
  userActivityHref,
  userActivitySearch,
  type UserActivityParams,
} from "./user-activity";

const USER = "7d0c2f4e-1b3a-4c5d-8e9f-0a1b2c3d4e5f";
const HOUSEHOLD = "3f2e1d0c-9b8a-4765-a432-10fedcba9876";
const CALL = "0b9d6f4e-2c1a-4e8b-9f3d-5a7c1e2b3d4f";

function entry(action: string, data: Record<string, unknown>, overrides: Partial<UserActivityEntry> = {}): UserActivityEntry {
  const area = actionArea(action) ?? "lists";
  return {
    at: "2026-10-21T14:05:00Z",
    source: area === "ai" ? "ai" : area === "admin" ? "admin" : "app",
    area,
    action,
    entity_id: "e1",
    household_id: HOUSEHOLD,
    household: "Home",
    txid: null,
    data,
    ...overrides,
  };
}

const say = (action: string, data: Record<string, unknown>, overrides: Partial<UserActivityEntry> = {}) =>
  sentenceText(entrySentence(entry(action, data, overrides)));

// Every catalog action with the `data` its trigger writes (20261204120000_user_activity.sql).
const CATALOG: [string, Record<string, unknown>, string][] = [
  ["list.created", { list: "Groceries" }, "Created list *Groceries*"],
  ["list.renamed", { list: "Groceries", from: "Shopping" }, "Renamed list *Shopping* to *Groceries*"],
  ["list.edited", { list: "Groceries", fields: ["color", "emoji"] }, "Edited list *Groceries*: colour, emoji"],
  ["list.reordered", { list: "Groceries" }, "Reordered list *Groceries*"],
  ["list.archived", { list: "Groceries" }, "Archived list *Groceries*"],
  ["list.unarchived", { list: "Groceries" }, "Unarchived list *Groceries*"],
  ["list.deleted", { list: "Groceries" }, "Deleted list *Groceries*"],
  ["list.restored", { list: "Groceries" }, "Restored list *Groceries*"],
  [
    "item.added",
    { list: "Groceries", list_id: "l1", item: "Flour", item_id: "i1", source: "recipe", quantity: 2, unit: "cups", recipe: "Banana bread", recipe_id: "r1" },
    "Added 2 cups *Flour* to *Groceries* from *Banana bread*",
  ],
  ["item.add_undone", { list: "Groceries", item: "Flour" }, "Undid adding *Flour* to *Groceries*"],
  ["item.checked", { list: "Groceries", item: "Cucumber" }, "Checked *Cucumber* on *Groceries*"],
  ["item.unchecked", { list: "Groceries", item: "Cucumber" }, "Unchecked *Cucumber* on *Groceries*"],
  ["item.moved", { item: "Cucumber", from: "Groceries", to: "Market" }, "Moved *Cucumber* from *Groceries* to *Market*"],
  ["item.renamed", { item: "Cucumbers", from: "Cucumber" }, "Renamed item *Cucumber* to *Cucumbers*"],
  ["item.edited", { list: "Groceries", item: "Flour", fields: ["quantity", "unit"] }, "Edited *Flour* on *Groceries*: quantity, unit"],
  ["item.photo_added", { list: "Groceries", item: "Flour" }, "Added a photo to *Flour* on *Groceries*"],
  ["item.photo_removed", { list: "Groceries", item: "Flour" }, "Removed the photo from *Flour* on *Groceries*"],
  ["item.merged", { list: "Groceries", item: "Tomatoes", into: "Tomato" }, "Combined *Tomatoes* into *Tomato* on *Groceries*"],
  ["item.deleted", { list: "Groceries", item: "Flour" }, "Deleted *Flour* from *Groceries*"],
  ["item.restored", { list: "Groceries", item: "Flour" }, "Restored *Flour* to *Groceries*"],
  ["recipe.created", { recipe: "Lasagna", source: "nytimes.com" }, "Added recipe *Lasagna* from nytimes.com"],
  ["recipe.renamed", { recipe: "Lasagna", from: "Lasagne" }, "Renamed recipe *Lasagne* to *Lasagna*"],
  ["recipe.edited", { recipe: "Lasagna", fields: ["servings", "notes"] }, "Edited recipe *Lasagna*: servings, notes"],
  ["recipe.tagged", { recipe: "Lasagna" }, "Changed the tags on *Lasagna*"],
  ["recipe.favorited", { recipe: "Tacos" }, "Favorited *Tacos*"],
  ["recipe.unfavorited", { recipe: "Tacos" }, "Unfavorited *Tacos*"],
  ["recipe.photo_added", { recipe: "Lasagna" }, "Added a photo to *Lasagna*"],
  ["recipe.photo_removed", { recipe: "Lasagna" }, "Removed the photo from *Lasagna*"],
  ["recipe.deleted", { recipe: "Lasagna" }, "Deleted recipe *Lasagna*"],
  ["recipe.restored", { recipe: "Lasagna" }, "Restored recipe *Lasagna*"],
  ["ingredient.added", { recipe: "Lasagna", recipe_id: "r1", ingredient: "Ricotta" }, "Added *Ricotta* to *Lasagna*"],
  ["ingredient.removed", { recipe: "Lasagna", recipe_id: "r1", ingredient: "Ricotta" }, "Removed *Ricotta* from *Lasagna*"],
  ["ingredient.edited", { recipe: "Lasagna", recipe_id: "r1", ingredient: "Ricotta", fields: ["quantity_text"] }, "Edited *Ricotta* in *Lasagna*: quantity text"],
  ["ingredient.reordered", { recipe: "Lasagna", recipe_id: "r1", ingredient: "Ricotta" }, "Reordered *Ricotta* in *Lasagna*"],
  ["plan.added", { date: "2026-11-03", meal: "dinner", kind: "recipe", recipe: "Lasagna", recipe_id: "r1" }, "Planned *Lasagna* for Tue 3 Nov dinner"],
  [
    "plan.moved",
    { from: { date: "2026-11-03", meal: "dinner" }, to: { date: "2026-11-04", meal: "dinner" }, recipe: "Lasagna" },
    "Moved *Lasagna* from Tue dinner to Wed dinner",
  ],
  ["plan.reordered", { date: "2026-11-03", meal: "dinner", recipe: "Lasagna" }, "Reordered *Lasagna* in Tue 3 Nov dinner"],
  ["plan.removed", { date: "2026-11-03", meal: "dinner", kind: "recipe", recipe: "Lasagna", recipe_id: "r1" }, "Removed *Lasagna* from Tue 3 Nov dinner"],
  ["plan.restored", { date: "2026-11-03", meal: "lunch", kind: "recipe", recipe: "Lasagna", recipe_id: "r1" }, "Restored *Lasagna* to Tue 3 Nov lunch"],
  ["aisle.created", { aisle: "Deli" }, "Created aisle *Deli*"],
  ["aisle.renamed", { aisle: "Deli counter", from: "Deli" }, "Renamed aisle *Deli* to *Deli counter*"],
  ["aisle.deleted", { aisle: "Deli" }, "Deleted aisle *Deli*"],
  ["aisle.assigned", { ingredient: "tofu", aisle: "Deli" }, "Moved *tofu* to *Deli*"],
  ["aisle_order.saved", { household: "Home" }, "Saved the household aisle order"],
  ["staple.added", { ingredient: "salt" }, "Added staple *salt*"],
  ["staple.removed", { ingredient: "salt" }, "Removed staple *salt*"],
  ["household.created", { household: "Home" }, "Created household *Home*"],
  ["household.renamed", { household: "Home", from: "House" }, "Renamed household *House* to *Home*"],
  ["household.combine_languages", { household: "Home", on: true }, "Turned on combining languages in *Home*"],
  ["household.left", { household: "Home" }, "Left household *Home*"],
  ["household.deleted", { household: "Home" }, "Deleted household *Home*"],
  ["invite.created", { household: "Home", invite_id: "v1", invited_email: "a@b.com" }, "Invited *a@b.com* to *Home*"],
  ["invite.revoked", { household: "Home", invite_id: "v1" }, "Revoked an invite to *Home*"],
  ["invite.accepted", { household: "Home", invite_id: "v1" }, "Accepted an invite to *Home*"],
  ["invite.declined", { household: "Home", invite_id: "v1" }, "Declined an invite to *Home*"],
  ["member.removed", { household: "Home", member: "Sam", member_id: "u2", role: "member" }, "Removed *Sam* from *Home*"],
  ["member.role_changed", { household: "Home", member: "Sam", member_id: "u2", role: "owner" }, "Made *Sam* an owner of *Home*"],
  ["settings.default_list", { list: "Groceries" }, "Made *Groceries* the default list"],
  ["settings.aisle_order", { household: "Home", removed: false }, "Saved their own aisle order"],
  ["settings.notifications", { fields: ["items_added", "quiet_start"] }, "Changed notification settings: items added, quiet start"],
  ["device.registered", { platform: "ios" }, "Registered an iOS device for notifications"],
  ["device.unregistered", { platform: "android" }, "Unregistered an Android device"],
];

describe("entrySentence", () => {
  it("covers every catalog action", () => {
    expect(CATALOG.map(([action]) => action).sort()).toEqual([...APP_ACTION_KEYS].sort());
  });

  it.each(CATALOG)("words %s", (action, data, expected) => {
    expect(say(action, data)).toBe(expected);
  });

  it("words an item added by hand, and one added without a contribution", () => {
    expect(say("item.added", { list: "Groceries", item: "Eggs", source: "manual", quantity: 12, unit: null })).toBe(
      "Added 12 *Eggs* to *Groceries*",
    );
    expect(say("item.added", { list: "Groceries", item: "Eggs", source: "manual", quantity: 1.5, unit: "kg" })).toBe(
      "Added 1.5 kg *Eggs* to *Groceries*",
    );
    expect(say("item.added", { list: "Groceries", list_id: "l1", item: "Eggs", item_id: "i1" })).toBe("Added *Eggs* to *Groceries*");
  });

  it("words recipes made by hand and from a photo", () => {
    expect(say("recipe.created", { recipe: "Soup", source: "manual" })).toBe("Added recipe *Soup*");
    expect(say("recipe.created", { recipe: "Soup", source: "photo" })).toBe("Added recipe *Soup* from a photo");
  });

  it("words the other plan kinds, without a note's text", () => {
    expect(say("plan.added", { date: "2026-11-03", meal: "dinner", kind: "leftovers" })).toBe("Planned leftovers for Tue 3 Nov dinner");
    expect(say("plan.added", { date: "2026-11-03", meal: "lunch", kind: "eating-out" })).toBe("Planned eating out for Tue 3 Nov lunch");
    expect(say("plan.added", { date: "2026-11-03", meal: "breakfast", kind: "note" })).toBe("Added a note to Tue 3 Nov breakfast");
    expect(say("plan.removed", { date: "2026-11-03", meal: "dinner", kind: "note" })).toBe("Removed a note from Tue 3 Nov dinner");
  });

  it("gives full dates for a move more than six days away, and names a non-recipe entry", () => {
    expect(
      say("plan.moved", { from: { date: "2026-11-03", meal: "dinner" }, to: { date: "2026-11-17", meal: "lunch" }, recipe: "Lasagna" }),
    ).toBe("Moved *Lasagna* from Tue 3 Nov dinner to Tue 17 Nov lunch");
    expect(say("plan.moved", { from: { date: "2026-11-03", meal: "dinner" }, to: { date: "2026-11-03", meal: "lunch" }, recipe: null })).toBe(
      "Moved a meal from Tue dinner to Tue lunch",
    );
  });

  it("says Reset to default for an aisle cleared", () => {
    expect(say("aisle.assigned", { ingredient: "tofu", aisle: null })).toBe("Reset *tofu* to its default aisle");
  });

  it("says Use household order for an own aisle order removed", () => {
    expect(say("settings.aisle_order", { household: "Home", removed: true })).toBe("Went back to the household aisle order");
    // Entries logged before orders were per household have no `removed`.
    expect(say("settings.aisle_order", {})).toBe("Saved their own aisle order");
  });

  it("says Invited someone once the invite is gone", () => {
    expect(say("invite.created", { household: "Home", invite_id: "v1", invited_email: null })).toBe("Invited someone to *Home*");
    expect(say("invite.created", { household: "Home", invite_id: "v1" })).toBe("Invited someone to *Home*");
  });

  it("says Removed a member for a scrubbed entry", () => {
    expect(say("member.removed", { household: "Home", role: "member" })).toBe("Removed a member from *Home*");
    expect(say("member.role_changed", { household: "Home", role: "owner" })).toBe("Changed a member's role in *Home*");
    expect(say("member.role_changed", { household: "Home", member: "Sam", member_id: "u2", role: "member" })).toBe(
      "Made *Sam* a member of *Home*",
    );
  });

  it("falls back to the entry's household when `data` has none", () => {
    expect(say("invite.revoked", { invite_id: "v1" }, { household: "Cabin" })).toBe("Revoked an invite to *Cabin*");
  });

  it("words the rest of settings", () => {
    expect(say("settings.default_list", { list: null })).toBe("Cleared the default list");
    expect(say("household.combine_languages", { household: "Home", on: false })).toBe("Turned off combining languages in *Home*");
    expect(say("device.registered", {})).toBe("Registered a device for notifications");
  });

  it("shows ? for a missing name rather than failing", () => {
    expect(say("item.checked", { item: "Cucumber", list: null })).toBe("Checked *Cucumber* on *?*");
    expect(say("list.created", {})).toBe("Created list *?*");
    expect(say("list.created", null as unknown as Record<string, unknown>)).toBe("Created list *?*");
  });

  it("shows an unknown action's name and data", () => {
    const sentence = entrySentence(entry("list.teleported", { list: "Groceries", to: "Mars" }));
    expect(sentence.parts).toEqual(["list.teleported"]);
    expect(sentence.raw).toBe('{"list":"Groceries","to":"Mars"}');
    expect(entrySentence(entry("thing.happened", {})).raw).toBe("");
  });

  it("says an AI call's outcome and links to it", () => {
    const failed = entrySentence(entry("ai.extractRecipe", { id: CALL, status: "timeout", flag: null, recipe_id: null }));
    expect(sentenceText(failed)).toBe("Import recipe failed");
    expect(failed.href).toBe(`/ai-calls/${CALL}`);
    expect(sentenceText(entrySentence(entry("ai.categorize", { id: CALL, status: "ok", flag: null })))).toBe("Categorize ingredients");
    expect(sentenceText(entrySentence(entry("ai.recipePhotoModeration", { id: CALL, status: "refused", flag: "refused" })))).toBe(
      "Check AI photo prompt refused · Refused",
    );
    expect(sentenceText(entrySentence(entry("ai.recipePhotoDescription", { id: CALL, status: "ok", flag: "not_food" })))).toBe(
      "Describe AI photo · Not food",
    );
    expect(sentenceText(entrySentence(entry("ai.someNewTask", { id: CALL, status: "ok" })))).toBe("someNewTask");
    expect(entrySentence(entry("ai.categorize", { status: "ok" })).href).toBeUndefined();
  });

  it("says what an admin did, with their email and the note", () => {
    const plan = entrySentence(
      entry("admin.set_user_plan", { details: { from: "founding", to: "unlimited" }, note: "Asked by support", performed_by_email: "admin@x.com" }),
    );
    expect(sentenceText(plan)).toBe("Admin changed plan: founding → unlimited (admin@x.com)");
    expect(plan.note).toBe("Asked by support");
    const unblock = entrySentence(
      entry("admin.unblock_ai_photos", { details: { refusals: 3, blocked_at: "2026-10-21T12:00:00Z" }, note: "False alarm", performed_by_email: null }),
    );
    expect(sentenceText(unblock)).toMatch(/^Admin: Unblocked AI photos: Blocked Oct 2[01], 2026 after 3 refusals$/);
    expect(unblock.note).toBe("False alarm");
    const revoke = entrySentence(
      entry("admin.revoke_device_credentials", { details: { revoked: 2 }, note: "Lost phone", performed_by_email: "admin@x.com" }),
    );
    expect(sentenceText(revoke)).toBe("Admin: Revoked device credentials: 2 credentials (admin@x.com)");
    expect(revoke.note).toBe("Lost phone");
    expect(sentenceText(entrySentence(entry("admin.view_user_activity", { details: {}, note: null, performed_by_email: "admin@x.com" })))).toBe(
      "Admin: Viewed a user's activity: No filters (admin@x.com)",
    );
    expect(entrySentence(entry("admin.view_ai_call", { details: {}, note: null })).note).toBeUndefined();
  });
});

describe("householdSuffix", () => {
  it("shows the household except where the sentence names it", () => {
    expect(householdSuffix({ area: "lists", household: "Home" })).toBe("Home");
    expect(householdSuffix({ area: "household", household: "Home" })).toBeNull();
    expect(householdSuffix({ area: "settings", household: null })).toBeNull();
  });
});

describe("foldEntries and lineSentence", () => {
  const ingredient = (name: string, txid: number | null, recipe = "Lasagna") =>
    entry("ingredient.added", { recipe, recipe_id: "r1", ingredient: name }, { txid, area: "recipes" });

  it("folds one action of one transaction into one line where the first one was", () => {
    const created = entry("recipe.created", { recipe: "Lasagna", source: "manual" }, { txid: 9, area: "recipes" });
    const lines = foldEntries([
      created,
      ...Array.from({ length: 12 }, (_, i) => ingredient(`Ingredient ${i}`, 9)),
      ingredient("Salt", 10),
    ]);
    expect(lines.map((line) => line.entries.length)).toEqual([1, 12, 1]);
    expect(lines.map((line) => sentenceText(lineSentence(line)))).toEqual([
      "Added recipe *Lasagna*",
      "Added 12 ingredients to *Lasagna*",
      "Added *Salt* to *Lasagna*",
    ]);
  });

  it("folds interleaved actions by action, keeping order", () => {
    const check = (item: string) => entry("item.checked", { list: "Groceries", item }, { txid: 5 });
    const add = (item: string) => entry("item.added", { list: "Groceries", item }, { txid: 5 });
    const lines = foldEntries([check("A"), add("B"), check("C"), add("D")]);
    expect(lines.map((line) => line.entries.map((e) => e.data.item))).toEqual([["A", "C"], ["B", "D"]]);
    expect(sentenceText(lineSentence(lines[0]))).toBe("Checked 2 items on *Groceries*");
  });

  it("never folds entries without a txid", () => {
    const lines = foldEntries([
      entry("ai.categorize", { status: "ok" }),
      entry("ai.categorize", { status: "ok" }),
    ]);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.key)).size).toBe(2);
  });

  it("leaves out the context the entries don't share", () => {
    const lines = foldEntries([
      entry("item.checked", { list: "Groceries", item: "A" }, { txid: 1 }),
      entry("item.checked", { list: "Market", item: "B" }, { txid: 1 }),
    ]);
    expect(sentenceText(lineSentence(lines[0]))).toBe("Checked 2 items");
  });

  it("names the recipe items came from when they all came from one", () => {
    const add = (item: string, recipe: string | null) =>
      entry("item.added", recipe === null
        ? { list: "Groceries", item, source: "manual" }
        : { list: "Groceries", item, source: "recipe", recipe }, { txid: 3 });
    expect(sentenceText(lineSentence(foldEntries([add("Flour", "Banana bread"), add("Eggs", "Banana bread")])[0]))).toBe(
      "Added 2 items to *Groceries* from *Banana bread*",
    );
    expect(sentenceText(lineSentence(foldEntries([add("Flour", "Banana bread"), add("Eggs", null)])[0]))).toBe(
      "Added 2 items to *Groceries*",
    );
  });

  it("says 'and N more' for an action without a folded wording, and for unknown actions", () => {
    const lines = foldEntries([
      entry("list.renamed", { list: "B", from: "A" }, { txid: 2 }),
      entry("list.renamed", { list: "D", from: "C" }, { txid: 2 }),
      entry("list.renamed", { list: "F", from: "E" }, { txid: 2 }),
    ]);
    expect(sentenceText(lineSentence(lines[0]))).toBe("Renamed list *A* to *B* and 2 more");
    const unknown = lineSentence(foldEntries([entry("x.y", { a: 1 }, { txid: 4 }), entry("x.y", { a: 2 }, { txid: 4 })])[0]);
    expect(sentenceText(unknown)).toBe("x.y and 1 more");
    expect(unknown.raw).toBe('{"a":1}');
  });
});

describe("days", () => {
  const now = new Date("2026-10-21T15:00:00Z");

  it("labels Today, Yesterday, then the date", () => {
    expect(dayLabel("2026-10-21T01:00:00Z", now, "UTC")).toBe("Today");
    expect(dayLabel("2026-10-20T23:59:00Z", now, "UTC")).toBe("Yesterday");
    expect(dayLabel("2026-10-19T12:00:00Z", now, "UTC")).toBe("Monday, Oct 19, 2026");
    expect(dayLabel("not a date", now, "UTC")).toBe("");
  });

  it("reads days in the time zone", () => {
    // 01:00 UTC on the 21st is still the 20th in New York.
    expect(dayLabel("2026-10-21T01:00:00Z", now, "America/New_York")).toBe("Yesterday");
  });

  it("formats the time", () => {
    expect(timeText("2026-10-21T14:05:00Z", "UTC")).toBe("2:05 PM");
    expect(timeText("nope", "UTC")).toBe("");
  });

  it("groups lines by day, in order", () => {
    const at = (iso: string) => entry("list.created", { list: "L" }, { at: iso });
    const days = groupByDay(
      foldEntries([at("2026-10-21T10:00:00Z"), at("2026-10-21T09:00:00Z"), at("2026-10-20T09:00:00Z"), at("2026-10-01T09:00:00Z")]),
      now,
      "UTC",
    );
    expect(days.map((day) => [day.label, day.lines.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["Thursday, Oct 1, 2026", 1],
    ]);
  });
});

describe("the filters' URL", () => {
  const filters: UserActivityParams = {
    areas: ["lists", "ai"],
    action: "item.checked",
    household: HOUSEHOLD,
    from: "2026-10-01",
    to: "2026-10-20",
  };

  it("round-trips through the URL", () => {
    const href = userActivityHref(USER, filters);
    expect(href).toBe(
      `/users/${USER}?areas=lists%2Cai&action=item.checked&household=${HOUSEHOLD}&from=2026-10-01&to=2026-10-20`,
    );
    const search = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(parseUserActivityParams(search)).toEqual(filters);
  });

  it("is the bare user page with no filters", () => {
    const none = parseUserActivityParams({});
    expect(none).toEqual({ areas: [], action: "", household: "", from: "", to: "" });
    expect(userActivityHref(USER, none)).toBe(`/users/${USER}`);
    expect(userActivitySearch(none)).toBe("");
    expect(hasFilters(none)).toBe(false);
    expect(hasFilters({ ...none, from: "2026-10-01" })).toBe(true);
  });

  it("puts areas in the chips' order, without duplicates or unknown ones", () => {
    expect(parseUserActivityParams({ areas: "admin,lists,bogus,lists" }).areas).toEqual(["lists", "admin"]);
    expect(userActivitySearch({ areas: ["ai", "lists"] })).toBe("areas=lists%2Cai");
  });

  it("drops bad households and dates, and an action outside the areas", () => {
    const parsed = parseUserActivityParams({
      areas: "recipes",
      action: "item.checked",
      household: "not-a-uuid",
      from: "2026-02-30",
      to: "yesterday",
    });
    expect(parsed).toEqual({ areas: ["recipes"], action: "", household: "", from: "", to: "" });
    expect(parseUserActivityParams({ areas: "ai", action: "ai.extractRecipe" }).action).toBe("ai.extractRecipe");
    expect(parseUserActivityParams({ action: "item.checked" }).action).toBe("item.checked");
    // An unknown action is kept: it may be one the portal doesn't know yet.
    expect(parseUserActivityParams({ areas: "lists", action: "list.teleported" }).action).toBe("list.teleported");
    expect(parseUserActivityParams({ household: HOUSEHOLD.toUpperCase() }).household).toBe(HOUSEHOLD);
    expect(parseUserActivityParams({ areas: ["lists", "ai"] }).areas).toEqual(["lists"]);
  });

  it("toggles an area chip, dropping the action it no longer fits", () => {
    const none = parseUserActivityParams({});
    expect(toggleArea(none, "recipes").areas).toEqual(["recipes"]);
    expect(toggleArea({ ...none, areas: ["recipes"] }, "lists").areas).toEqual(["lists", "recipes"]);
    expect(toggleArea({ ...none, areas: ["lists", "recipes"] }, "lists").areas).toEqual(["recipes"]);
    expect(toggleArea({ ...none, action: "item.checked" }, "recipes").action).toBe("");
    expect(toggleArea({ ...none, action: "item.checked" }, "lists").action).toBe("item.checked");
    expect(toggleArea({ ...none, areas: ["recipes"], action: "recipe.tagged" }, "recipes")).toEqual({ ...none, action: "recipe.tagged" });
  });

  it("makes the function's arguments, the end day inclusive", () => {
    expect(userActivityArgs(USER, filters)).toEqual({
      p_user_id: USER,
      p_areas: ["lists", "ai"],
      p_actions: ["item.checked"],
      p_household_id: HOUSEHOLD,
      p_from: "2026-10-01T00:00:00.000Z",
      p_to: "2026-10-21T00:00:00.000Z",
      p_before: null,
      p_limit: 100,
    });
    expect(userActivityArgs(USER, { ...filters, to: "2026-12-31" }, "2026-10-10T08:00:00Z")).toMatchObject({
      p_to: "2027-01-01T00:00:00.000Z",
      p_before: "2026-10-10T08:00:00Z",
    });
    expect(userActivityArgs(USER, parseUserActivityParams({}))).toEqual({
      p_user_id: USER,
      p_areas: null,
      p_actions: null,
      p_household_id: null,
      p_from: null,
      p_to: null,
      p_before: null,
      p_limit: 100,
    });
  });
});

describe("the action filter", () => {
  it("lists every action for All, in areas' order", () => {
    const values = userActionOptions([], "").map((option) => option.value);
    expect(values.slice(0, APP_ACTION_KEYS.length)).toEqual(APP_ACTION_KEYS);
    expect(values).toContain("ai.extractRecipe");
    expect(values).toContain("admin.unblock_ai_photos");
    expect(values).toContain("admin.revoke_device_credentials");
    expect(values).toContain("admin.view_user_activity");
  });

  it("lists only the chosen areas' actions", () => {
    const options = userActionOptions(["plan", "ai"], "");
    expect(options.map((option) => option.value)).toEqual([
      "plan.added",
      "plan.moved",
      "plan.reordered",
      "plan.removed",
      "plan.restored",
      "ai.categorize",
      "ai.extractRecipe",
      "ai.extractRecipePhoto",
      "ai.suggestRecipeTags",
      "ai.matchRecipeSteps",
      "ai.recipePhotoDescription",
      "ai.recipePhotoModeration",
      "ai.recipePhotoImage",
    ]);
    expect(options[0].label).toBe("Planned a meal");
    expect(options[6].label).toBe("AI: Import recipe");
  });

  it("keeps the current action when it isn't listed", () => {
    expect(userActionOptions(["devices"], "device.teleported").at(-1)).toEqual({ value: "device.teleported", label: "device.teleported" });
    expect(userActionOptions(["devices"], "device.registered")).toHaveLength(2);
  });

  it("labels and places actions", () => {
    expect(userActionLabel("item.checked")).toBe("Checked an item");
    expect(userActionLabel("admin.unblock_ai_photos")).toBe("Admin: Unblocked AI photos");
    expect(userActionLabel("whatever")).toBe("whatever");
    expect(actionArea("staple.added")).toBe("aisles");
    expect(actionArea("ai.x")).toBe("ai");
    expect(actionArea("admin.x")).toBe("admin");
    expect(actionArea("whatever")).toBeNull();
  });
});

describe("areaCounts", () => {
  it("fills every area and sums them for All", () => {
    const { all, byArea } = areaCounts({ lists: 4, ai: 2, admin: 1, bogus: 100 });
    expect(all).toBe(7);
    expect(byArea).toEqual({ lists: 4, recipes: 0, plan: 0, aisles: 0, household: 0, settings: 0, devices: 0, ai: 2, admin: 1 });
    expect(areaCounts(null).all).toBe(0);
  });
});
