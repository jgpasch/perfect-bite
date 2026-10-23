// The wording of a user's Activity card (spec 4.12 User activity): the areas and the catalog's
// actions with their labels, one sentence per entry from its action and `data`, entries of one
// transaction folded into one line, the day headings, and the filters' URL and the function's
// arguments, kept out of the components so they can be tested. The admin Activity page's wording is
// ./activity. `data` is whatever the triggers stored (20261204120000_user_activity.sql), so
// everything here reads it defensively.
import { actionLabel, actionSummary, rawSummary } from "./activity";
import { flagLabel, TASK_LABELS } from "./ai-calls";
import type { UserActivityEntry } from "./types";
import { isUuid, parseQuery } from "./users";

/** Entries a page (the function's default). */
export const USER_ACTIVITY_PAGE_SIZE = 100;

/** The areas, in the chips' order, with their labels. */
export const ACTIVITY_AREAS = {
  lists: "Lists",
  recipes: "Recipes",
  plan: "Plan",
  aisles: "Aisles",
  household: "Household",
  settings: "Settings",
  devices: "Devices",
  ai: "AI",
  admin: "Admin",
} as const satisfies Record<string, string>;

export type ActivityArea = keyof typeof ACTIVITY_AREAS;

export const AREA_KEYS = Object.keys(ACTIVITY_AREAS) as ActivityArea[];

export function isActivityArea(value: string): value is ActivityArea {
  return Object.hasOwn(ACTIVITY_AREAS, value);
}

/** "Lists" for `lists`; the raw name for an area the portal doesn't know. */
export function areaLabel(area: string): string {
  return isActivityArea(area) ? ACTIVITY_AREAS[area] : area;
}

type AppArea = Exclude<ActivityArea, "ai" | "admin">;

/** The app's actions (the catalog), in the action filter's order, with their area and label. */
export const APP_ACTIONS = {
  "list.created": { area: "lists", label: "Created a list" },
  "list.renamed": { area: "lists", label: "Renamed a list" },
  "list.edited": { area: "lists", label: "Edited a list" },
  "list.reordered": { area: "lists", label: "Reordered a list" },
  "list.archived": { area: "lists", label: "Archived a list" },
  "list.unarchived": { area: "lists", label: "Unarchived a list" },
  "list.deleted": { area: "lists", label: "Deleted a list" },
  "list.restored": { area: "lists", label: "Restored a list" },
  "item.added": { area: "lists", label: "Added an item" },
  "item.add_undone": { area: "lists", label: "Undid adding an item" },
  "item.checked": { area: "lists", label: "Checked an item" },
  "item.unchecked": { area: "lists", label: "Unchecked an item" },
  "item.moved": { area: "lists", label: "Moved an item" },
  "item.renamed": { area: "lists", label: "Renamed an item" },
  "item.edited": { area: "lists", label: "Edited an item" },
  "item.photo_added": { area: "lists", label: "Added an item photo" },
  "item.photo_removed": { area: "lists", label: "Removed an item photo" },
  "item.merged": { area: "lists", label: "Combined items" },
  "item.deleted": { area: "lists", label: "Deleted an item" },
  "item.restored": { area: "lists", label: "Restored an item" },
  "recipe.created": { area: "recipes", label: "Added a recipe" },
  "recipe.renamed": { area: "recipes", label: "Renamed a recipe" },
  "recipe.edited": { area: "recipes", label: "Edited a recipe" },
  "recipe.tagged": { area: "recipes", label: "Changed a recipe's tags" },
  "recipe.favorited": { area: "recipes", label: "Favorited a recipe" },
  "recipe.unfavorited": { area: "recipes", label: "Unfavorited a recipe" },
  "recipe.photo_added": { area: "recipes", label: "Added a recipe photo" },
  "recipe.photo_removed": { area: "recipes", label: "Removed a recipe photo" },
  "recipe.deleted": { area: "recipes", label: "Deleted a recipe" },
  "recipe.restored": { area: "recipes", label: "Restored a recipe" },
  "ingredient.added": { area: "recipes", label: "Added an ingredient" },
  "ingredient.removed": { area: "recipes", label: "Removed an ingredient" },
  "ingredient.edited": { area: "recipes", label: "Edited an ingredient" },
  "ingredient.reordered": { area: "recipes", label: "Reordered an ingredient" },
  "plan.added": { area: "plan", label: "Planned a meal" },
  "plan.moved": { area: "plan", label: "Moved a meal" },
  "plan.reordered": { area: "plan", label: "Reordered a meal" },
  "plan.removed": { area: "plan", label: "Removed a meal" },
  "plan.restored": { area: "plan", label: "Restored a meal" },
  "aisle.created": { area: "aisles", label: "Created an aisle" },
  "aisle.renamed": { area: "aisles", label: "Renamed an aisle" },
  "aisle.deleted": { area: "aisles", label: "Deleted an aisle" },
  "aisle.assigned": { area: "aisles", label: "Changed an ingredient's aisle" },
  "aisle_order.saved": { area: "aisles", label: "Saved the household aisle order" },
  "staple.added": { area: "aisles", label: "Added a staple" },
  "staple.removed": { area: "aisles", label: "Removed a staple" },
  "household.created": { area: "household", label: "Created a household" },
  "household.renamed": { area: "household", label: "Renamed a household" },
  "household.combine_languages": { area: "household", label: "Changed combining languages" },
  "household.left": { area: "household", label: "Left a household" },
  "household.deleted": { area: "household", label: "Deleted a household" },
  "invite.created": { area: "household", label: "Invited someone" },
  "invite.revoked": { area: "household", label: "Revoked an invite" },
  "invite.accepted": { area: "household", label: "Accepted an invite" },
  "invite.declined": { area: "household", label: "Declined an invite" },
  "member.removed": { area: "household", label: "Removed a member" },
  "member.role_changed": { area: "household", label: "Changed a member's role" },
  "settings.default_list": { area: "settings", label: "Changed the default list" },
  "settings.aisle_order": { area: "settings", label: "Reordered aisles" },
  "settings.notifications": { area: "settings", label: "Changed notifications" },
  "device.registered": { area: "devices", label: "Registered a device" },
  "device.unregistered": { area: "devices", label: "Unregistered a device" },
} as const satisfies Record<string, { area: AppArea; label: string }>;

export type AppAction = keyof typeof APP_ACTIONS;

export const APP_ACTION_KEYS = Object.keys(APP_ACTIONS) as AppAction[];

function isAppAction(action: string): action is AppAction {
  return Object.hasOwn(APP_ACTIONS, action);
}

/** An AI task as something the user did: "Import recipe" (`extractRecipe`), for "Import recipe failed". */
export const AI_TASK_VERBS = {
  categorize: "Categorize ingredients",
  extractRecipe: "Import recipe",
  extractRecipePhoto: "Import recipe from photo",
  suggestRecipeTags: "Suggest tags",
  matchRecipeSteps: "Match recipe steps",
  recipePhotoDescription: "Describe AI photo",
  recipePhotoModeration: "Check AI photo prompt",
  recipePhotoImage: "Make AI photo",
} as const satisfies Record<keyof typeof TASK_LABELS, string>;

function aiTaskVerb(task: string): string {
  return Object.hasOwn(AI_TASK_VERBS, task) ? AI_TASK_VERBS[task as keyof typeof AI_TASK_VERBS] : task;
}

/** The admin actions that can name a user, as `admin.<action>` (the rest name a household or a plan). */
const ADMIN_ACTIONS = [
  "view_ai_call",
  "view_user_activity",
  "block_ai_photos",
  "unblock_ai_photos",
  "revoke_device_credentials",
  "set_user_plan",
  "delete_user",
  "delete_account",
] as const;

/** An action's area: the catalog's, `ai`/`admin` by prefix, else null. */
export function actionArea(action: string): ActivityArea | null {
  if (isAppAction(action)) return APP_ACTIONS[action].area;
  if (action.startsWith("ai.")) return "ai";
  if (action.startsWith("admin.")) return "admin";
  return null;
}

/** "Checked an item", "AI: Import recipe", "Admin: Unblocked AI photos"; the raw name for an unknown action. */
export function userActionLabel(action: string): string {
  if (isAppAction(action)) return APP_ACTIONS[action].label;
  if (action.startsWith("ai.")) return `AI: ${aiTaskVerb(action.slice(3))}`;
  if (action.startsWith("admin.")) return `Admin: ${actionLabel(action.slice(6))}`;
  return action;
}

/**
 * The action filter's choices for the chosen areas (every area when none): the catalog's, then one
 * per AI task and the admin actions about a user, plus the current one when it isn't among them.
 */
export function userActionOptions(areas: readonly ActivityArea[], current: string): { value: string; label: string }[] {
  const shown = (area: ActivityArea) => areas.length === 0 || areas.includes(area);
  const values: string[] = [
    ...APP_ACTION_KEYS.filter((action) => shown(APP_ACTIONS[action].area)),
    ...(shown("ai") ? Object.keys(AI_TASK_VERBS).map((task) => `ai.${task}`) : []),
    ...(shown("admin") ? ADMIN_ACTIONS.map((action) => `admin.${action}`) : []),
  ];
  if (current !== "" && !values.includes(current)) values.push(current);
  return values.map((value) => ({ value, label: userActionLabel(value) }));
}

// --- Sentences -------------------------------------------------------------------------------

/** A piece of a sentence: plain text, or a name to emphasise (*Cucumber*). */
export type SentencePart = string | { em: string };

export type ActivitySentence = {
  parts: SentencePart[];
  /** Where the line links (an AI call). */
  href?: string;
  /** An admin action's note. */
  note?: string;
  /** An unknown action's `data`, as compact JSON. */
  raw?: string;
};

/** The sentence as plain text, *names* marked: for tests and titles. */
export function sentenceText(sentence: ActivitySentence): string {
  return sentence.parts.map((part) => (typeof part === "string" ? part : `*${part.em}*`)).join("");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A name from `data`, emphasised; "?" when it's missing (a parent deleted before the entry was made). */
function em(value: unknown): { em: string } {
  return { em: text(value) ?? "?" };
}

const FIELD_NAMES: Record<string, string> = { color: "colour" };

/** ": servings, notes" from `fields` (column names, underscores read as spaces); "" with none. */
function fieldsText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const names = value
    .filter((field): field is string => typeof field === "string" && field !== "")
    .map((field) => FIELD_NAMES[field] ?? field.replaceAll("_", " "));
  return names.length === 0 ? "" : `: ${names.join(", ")}`;
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** "2 cups " from a contribution's quantity and unit as stored; "" with no quantity. */
function amountText(quantity: unknown, unit: unknown): string {
  const amount = typeof quantity === "number" ? NUMBER.format(quantity) : text(quantity);
  if (amount === null) return "";
  const unitText = text(unit);
  return unitText === null ? `${amount} ` : `${amount} ${unitText} `;
}

const PLAN_DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function planDate(value: unknown): Date | null {
  const date = text(value);
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "Tue 3 Nov dinner" (or "Tue dinner" with `short`), from a plan date and meal. */
function slotText(date: unknown, meal: unknown, short = false): string {
  const parsed = planDate(date);
  let day = "?";
  if (parsed !== null) {
    const parts = Object.fromEntries(PLAN_DAY.formatToParts(parsed).map((part) => [part.type, part.value]));
    day = short ? parts.weekday : `${parts.weekday} ${parts.day} ${parts.month}`;
  }
  const mealText = text(meal);
  return mealText === null ? day : `${day} ${mealText}`;
}

/** What a plan entry is: the recipe, or leftovers, eating out or a note. */
function planWhat(data: Record<string, unknown>): SentencePart[] {
  switch (data.kind) {
    case "leftovers":
      return ["leftovers"];
    case "eating-out":
      return ["eating out"];
    case "note":
      return ["a note"];
    default:
      return text(data.recipe) === null && data.kind !== "recipe" ? ["a meal"] : [em(data.recipe)];
  }
}

const SIX_DAYS = 6 * 24 * 60 * 60 * 1000;

/** "Moved *Lasagna* from Tue dinner to Wed dinner"; full dates when the two are more than six days apart. */
function planMoved(data: Record<string, unknown>): SentencePart[] {
  const from = record(data.from) ?? {};
  const to = record(data.to) ?? {};
  const a = planDate(from.date);
  const b = planDate(to.date);
  const short = a !== null && b !== null && Math.abs(a.getTime() - b.getTime()) <= SIX_DAYS;
  const what = text(data.recipe) === null ? ["a meal"] : [em(data.recipe)];
  return ["Moved ", ...what, ` from ${slotText(from.date, from.meal, short)} to ${slotText(to.date, to.meal, short)}`];
}

const PLATFORMS: Record<string, string> = { ios: "iOS", android: "Android" };

function platformText(value: unknown): string {
  const platform = text(value);
  if (platform === null) return "a";
  const name = PLATFORMS[platform] ?? platform;
  return /^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`;
}

/** The household-area actions name the household themselves; the rest show it as a suffix. */
function inHousehold(data: Record<string, unknown>, entry: Pick<UserActivityEntry, "household">): { em: string } {
  return em(text(data.household) ?? entry.household);
}

function appSentence(entry: Pick<UserActivityEntry, "action" | "data" | "household">): SentencePart[] | null {
  const d = record(entry.data) ?? {};
  switch (entry.action) {
    case "list.created":
      return ["Created list ", em(d.list)];
    case "list.archived":
      return ["Archived list ", em(d.list)];
    case "list.unarchived":
      return ["Unarchived list ", em(d.list)];
    case "list.deleted":
      return ["Deleted list ", em(d.list)];
    case "list.restored":
      return ["Restored list ", em(d.list)];
    case "list.renamed":
      return ["Renamed list ", em(d.from), " to ", em(d.list)];
    case "list.edited":
      return ["Edited list ", em(d.list), fieldsText(d.fields)];
    case "list.reordered":
      return ["Reordered list ", em(d.list)];
    case "item.added": {
      const parts: SentencePart[] = ["Added ", amountText(d.quantity, d.unit), em(d.item), " to ", em(d.list)];
      if (d.source === "recipe") parts.push(" from ", em(d.recipe));
      return parts;
    }
    case "item.add_undone":
      return ["Undid adding ", em(d.item), " to ", em(d.list)];
    case "item.checked":
      return ["Checked ", em(d.item), " on ", em(d.list)];
    case "item.unchecked":
      return ["Unchecked ", em(d.item), " on ", em(d.list)];
    case "item.deleted":
      return ["Deleted ", em(d.item), " from ", em(d.list)];
    case "item.restored":
      return ["Restored ", em(d.item), " to ", em(d.list)];
    case "item.moved":
      return ["Moved ", em(d.item), " from ", em(d.from), " to ", em(d.to)];
    case "item.renamed":
      return ["Renamed item ", em(d.from), " to ", em(d.item)];
    case "item.edited":
      return ["Edited ", em(d.item), " on ", em(d.list), fieldsText(d.fields)];
    case "item.photo_added":
      return ["Added a photo to ", em(d.item), " on ", em(d.list)];
    case "item.photo_removed":
      return ["Removed the photo from ", em(d.item), " on ", em(d.list)];
    case "item.merged":
      return ["Combined ", em(d.item), " into ", em(d.into), " on ", em(d.list)];
    case "recipe.created": {
      const source = text(d.source);
      const from = source === null || source === "manual" ? "" : source === "photo" ? " from a photo" : ` from ${source}`;
      return ["Added recipe ", em(d.recipe), from];
    }
    case "recipe.renamed":
      return ["Renamed recipe ", em(d.from), " to ", em(d.recipe)];
    case "recipe.edited":
      return ["Edited recipe ", em(d.recipe), fieldsText(d.fields)];
    case "recipe.tagged":
      return ["Changed the tags on ", em(d.recipe)];
    case "recipe.favorited":
      return ["Favorited ", em(d.recipe)];
    case "recipe.unfavorited":
      return ["Unfavorited ", em(d.recipe)];
    case "recipe.photo_added":
      return ["Added a photo to ", em(d.recipe)];
    case "recipe.photo_removed":
      return ["Removed the photo from ", em(d.recipe)];
    case "recipe.deleted":
      return ["Deleted recipe ", em(d.recipe)];
    case "recipe.restored":
      return ["Restored recipe ", em(d.recipe)];
    case "ingredient.added":
      return ["Added ", em(d.ingredient), " to ", em(d.recipe)];
    case "ingredient.removed":
      return ["Removed ", em(d.ingredient), " from ", em(d.recipe)];
    case "ingredient.edited":
      return ["Edited ", em(d.ingredient), " in ", em(d.recipe), fieldsText(d.fields)];
    case "ingredient.reordered":
      return ["Reordered ", em(d.ingredient), " in ", em(d.recipe)];
    case "plan.added":
      return d.kind === "note"
        ? [`Added a note to ${slotText(d.date, d.meal)}`]
        : ["Planned ", ...planWhat(d), ` for ${slotText(d.date, d.meal)}`];
    case "plan.removed":
      return ["Removed ", ...planWhat(d), ` from ${slotText(d.date, d.meal)}`];
    case "plan.restored":
      return ["Restored ", ...planWhat(d), ` to ${slotText(d.date, d.meal)}`];
    case "plan.moved":
      return planMoved(d);
    case "plan.reordered":
      return ["Reordered ", ...(text(d.recipe) === null ? ["a meal"] : [em(d.recipe)]), ` in ${slotText(d.date, d.meal)}`];
    case "aisle.created":
      return ["Created aisle ", em(d.aisle)];
    case "aisle.deleted":
      return ["Deleted aisle ", em(d.aisle)];
    case "aisle.renamed":
      return ["Renamed aisle ", em(d.from), " to ", em(d.aisle)];
    case "aisle.assigned":
      return text(d.aisle) === null
        ? ["Reset ", em(d.ingredient), " to its default aisle"]
        : ["Moved ", em(d.ingredient), " to ", em(d.aisle)];
    case "aisle_order.saved":
      return ["Saved the household aisle order"];
    case "staple.added":
      return ["Added staple ", em(d.ingredient)];
    case "staple.removed":
      return ["Removed staple ", em(d.ingredient)];
    case "household.created":
      return ["Created household ", inHousehold(d, entry)];
    case "household.deleted":
      return ["Deleted household ", inHousehold(d, entry)];
    case "household.left":
      return ["Left household ", inHousehold(d, entry)];
    case "household.renamed":
      return ["Renamed household ", em(d.from), " to ", inHousehold(d, entry)];
    case "household.combine_languages":
      return [`Turned ${d.on === true ? "on" : "off"} combining languages in `, inHousehold(d, entry)];
    case "invite.created": {
      const email = text(d.invited_email);
      return email === null ? ["Invited someone to ", inHousehold(d, entry)] : ["Invited ", em(email), " to ", inHousehold(d, entry)];
    }
    case "invite.revoked":
      return ["Revoked an invite to ", inHousehold(d, entry)];
    case "invite.accepted":
      return ["Accepted an invite to ", inHousehold(d, entry)];
    case "invite.declined":
      return ["Declined an invite to ", inHousehold(d, entry)];
    case "member.removed":
      // A deleted member's entries are scrubbed of `member` and `member_id` (4.8).
      return text(d.member) === null
        ? ["Removed a member from ", inHousehold(d, entry)]
        : ["Removed ", em(d.member), " from ", inHousehold(d, entry)];
    case "member.role_changed": {
      if (text(d.member) === null) return ["Changed a member's role in ", inHousehold(d, entry)];
      const role = d.role === "owner" ? "an owner" : d.role === "member" ? "a member" : (text(d.role) ?? "?");
      return ["Made ", em(d.member), ` ${role} of `, inHousehold(d, entry)];
    }
    case "settings.default_list":
      return text(d.list) === null ? ["Cleared the default list"] : ["Made ", em(d.list), " the default list"];
    case "settings.aisle_order":
      return [d.removed === true ? "Went back to the household aisle order" : "Saved their own aisle order"];
    case "settings.notifications":
      return [`Changed notification settings${fieldsText(d.fields)}`];
    case "device.registered":
      return [`Registered ${platformText(d.platform)} device for notifications`];
    case "device.unregistered":
      return [`Unregistered ${platformText(d.platform)} device`];
    default:
      return null;
  }
}

function aiSentence(entry: Pick<UserActivityEntry, "action" | "data">): ActivitySentence {
  const d = record(entry.data) ?? {};
  const verb = aiTaskVerb(entry.action.slice(3));
  const status = text(d.status);
  let line = status === "ok" ? verb : status === "refused" ? `${verb} refused` : `${verb} failed`;
  const flag = text(d.flag);
  if (flag !== null) line += ` · ${flagLabel(flag)}`;
  const id = text(d.id);
  return id === null ? { parts: [line] } : { parts: [line], href: `/ai-calls/${encodeURIComponent(id)}` };
}

function adminSentence(entry: Pick<UserActivityEntry, "action" | "data">): ActivitySentence {
  const d = record(entry.data) ?? {};
  const action = entry.action.slice(6);
  const summary = actionSummary({ action, details: record(d.details) ?? {} });
  const head = action === "set_household_plan" || action === "set_user_plan" ? "Admin changed plan" : `Admin: ${actionLabel(action)}`;
  const by = text(d.performed_by_email);
  const parts: SentencePart[] = [summary === "" ? head : `${head}: ${summary}`];
  if (by !== null) parts.push(` (${by})`);
  const sentence: ActivitySentence = { parts };
  const note = text(d.note);
  if (note !== null) sentence.note = note;
  return sentence;
}

/** One entry's sentence; an unknown action shows its name and `data`. */
export function entrySentence(entry: Pick<UserActivityEntry, "source" | "action" | "data" | "household">): ActivitySentence {
  if (entry.source === "ai" && entry.action.startsWith("ai.")) return aiSentence(entry);
  if (entry.source === "admin" && entry.action.startsWith("admin.")) return adminSentence(entry);
  const parts = appSentence(entry);
  if (parts !== null) return { parts: parts.filter((part) => part !== "") };
  return { parts: [entry.action], raw: rawSummary(record(entry.data) ?? {}) };
}

/** The household as the line's muted suffix: none for the household area, which names it in the sentence. */
export function householdSuffix(entry: Pick<UserActivityEntry, "area" | "household">): string | null {
  return entry.area === "household" ? null : text(entry.household);
}

// --- Folding ---------------------------------------------------------------------------------

/** One line of the card: one entry, or the entries of one action in one transaction. */
export type ActivityLine = {
  key: string;
  entries: UserActivityEntry[];
};

/**
 * Entries with the same action in one `txid` fold into one line, where the first of them was; the
 * rest stay one line each. Order is kept.
 */
export function foldEntries(entries: readonly UserActivityEntry[]): ActivityLine[] {
  const lines: ActivityLine[] = [];
  const byGroup = new Map<string, ActivityLine>();
  entries.forEach((entry, index) => {
    if (entry.txid === null || entry.txid === undefined) {
      lines.push({ key: `${entry.source}:${entry.entity_id ?? ""}:${entry.at}:${index}`, entries: [entry] });
      return;
    }
    const group = `${entry.txid}:${entry.action}`;
    const line = byGroup.get(group);
    if (line) {
      line.entries.push(entry);
    } else {
      const created = { key: `tx:${group}`, entries: [entry] };
      byGroup.set(group, created);
      lines.push(created);
    }
  });
  return lines;
}

function plural(count: number, one: string, other: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : other}`;
}

/** The value of `key` shared by every entry's `data`, else undefined. */
function shared(entries: readonly UserActivityEntry[], key: string): string | undefined {
  const first = text(record(entries[0]?.data)?.[key]);
  if (first === null) return undefined;
  return entries.every((entry) => text(record(entry.data)?.[key]) === first) ? first : undefined;
}

// A folded line's wording: [verb, noun one/other, preposition, the `data` key the context is in].
const FOLDS: Partial<Record<AppAction, [string, string, string, string, string]>> = {
  "item.added": ["Added", "item", "items", "to", "list"],
  "item.add_undone": ["Undid adding", "item", "items", "to", "list"],
  "item.checked": ["Checked", "item", "items", "on", "list"],
  "item.unchecked": ["Unchecked", "item", "items", "on", "list"],
  "item.deleted": ["Deleted", "item", "items", "from", "list"],
  "item.restored": ["Restored", "item", "items", "to", "list"],
  "item.edited": ["Edited", "item", "items", "on", "list"],
  "item.renamed": ["Renamed", "item", "items", "", ""],
  "item.photo_added": ["Added photos to", "item", "items", "on", "list"],
  "item.photo_removed": ["Removed photos from", "item", "items", "on", "list"],
  "item.merged": ["Combined", "item", "items", "on", "list"],
  "list.reordered": ["Reordered", "list", "lists", "", ""],
  "ingredient.added": ["Added", "ingredient", "ingredients", "to", "recipe"],
  "ingredient.removed": ["Removed", "ingredient", "ingredients", "from", "recipe"],
  "ingredient.edited": ["Edited", "ingredient", "ingredients", "in", "recipe"],
  "ingredient.reordered": ["Reordered", "ingredient", "ingredients", "in", "recipe"],
  "plan.added": ["Planned", "meal", "meals", "", ""],
  "plan.removed": ["Removed", "meal", "meals", "", ""],
  "plan.restored": ["Restored", "meal", "meals", "", ""],
  "plan.moved": ["Moved", "meal", "meals", "", ""],
  "plan.reordered": ["Reordered", "meal", "meals", "", ""],
  "aisle.assigned": ["Changed the aisle of", "ingredient", "ingredients", "", ""],
  "staple.added": ["Added", "staple", "staples", "", ""],
  "staple.removed": ["Removed", "staple", "staples", "", ""],
  "recipe.created": ["Added", "recipe", "recipes", "", ""],
  "recipe.deleted": ["Deleted", "recipe", "recipes", "", ""],
};

/**
 * A line's sentence: the entry's own for one entry; for a fold, "Added 12 ingredients to *Lasagna*"
 * (the list or recipe when they all share it, and "from *Banana bread*" when every item came from
 * one recipe), else the first entry's sentence with "and N more".
 */
export function lineSentence(line: ActivityLine): ActivitySentence {
  const [first] = line.entries;
  if (line.entries.length === 1) return entrySentence(first);
  const count = line.entries.length;
  const fold = isAppAction(first.action) && first.source === "app" ? FOLDS[first.action] : undefined;
  if (fold === undefined) {
    const sentence = entrySentence(first);
    return { ...sentence, parts: [...sentence.parts, ` and ${plural(count - 1, "more", "more")}`] };
  }
  const [verb, one, other, preposition, contextKey] = fold;
  const parts: SentencePart[] = [`${verb} ${plural(count, one, other)}`];
  const context = contextKey === "" ? undefined : shared(line.entries, contextKey);
  if (context !== undefined) parts.push(` ${preposition} `, { em: context });
  if (first.action === "item.added" && line.entries.every((entry) => record(entry.data)?.source === "recipe")) {
    const recipe = shared(line.entries, "recipe");
    if (recipe !== undefined) parts.push(" from ", { em: recipe });
  }
  return { parts };
}

// --- Days ------------------------------------------------------------------------------------

function dayKey(date: Date, timeZone?: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(date);
}

function previousDay(key: string): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** "Today", "Yesterday", else "Monday, Oct 19, 2026", in `timeZone` (the portal's by default). */
export function dayLabel(iso: string, now: Date = new Date(), timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const key = dayKey(date, timeZone);
  const today = dayKey(now, timeZone);
  if (key === today) return "Today";
  if (key === previousDay(today)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric", timeZone }).format(date);
}

/** "2:05 PM", in `timeZone` (the portal's by default). */
export function timeText(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone }).format(date);
}

export type ActivityDay = { key: string; label: string; lines: ActivityLine[] };

/** The lines grouped by their first entry's day, newest first as given. */
export function groupByDay(lines: readonly ActivityLine[], now: Date = new Date(), timeZone?: string): ActivityDay[] {
  const days: ActivityDay[] = [];
  for (const line of lines) {
    const at = new Date(line.entries[0].at);
    const key = Number.isNaN(at.getTime()) ? "" : dayKey(at, timeZone);
    const last = days.at(-1);
    if (last && last.key === key) last.lines.push(line);
    else days.push({ key, label: dayLabel(line.entries[0].at, now, timeZone), lines: [line] });
  }
  return days;
}

// --- The filters' URL ------------------------------------------------------------------------

/** The card's filters, from the user page's search params. "" for none. */
export type UserActivityParams = {
  /** None: every area (All). In the chips' order. */
  areas: ActivityArea[];
  action: string;
  /** A household id. */
  household: string;
  /** `YYYY-MM-DD`, UTC days, both inclusive. */
  from: string;
  to: string;
};

type SearchParams = Record<string, string | string[] | undefined>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string | string[] | undefined): string {
  const raw = parseQuery(value);
  if (!DATE.test(raw)) return "";
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : "";
}

/**
 * The filters from `?areas=lists,ai&action=item.checked&household=<id>&from=2026-10-01&to=2026-10-20`.
 * Unknown areas, a household that isn't a uuid and dates that aren't real days are dropped, and so is
 * an action outside the chosen areas.
 */
export function parseUserActivityParams(params: SearchParams): UserActivityParams {
  const chosen = new Set(parseQuery(params.areas).split(",").map((area) => area.trim()));
  const areas = AREA_KEYS.filter((area) => chosen.has(area));
  let action = parseQuery(params.action);
  const area = actionArea(action);
  if (action !== "" && areas.length > 0 && area !== null && !areas.includes(area)) action = "";
  const household = parseQuery(params.household);
  return {
    areas,
    action,
    household: isUuid(household) ? household.toLowerCase() : "",
    from: parseDate(params.from),
    to: parseDate(params.to),
  };
}

/** The search string for the filters ("areas=lists%2Cai&action=…"), blank ones left out; "" for none. */
export function userActivitySearch(params: Partial<UserActivityParams>): string {
  const search = new URLSearchParams();
  if (params.areas && params.areas.length > 0) search.set("areas", AREA_KEYS.filter((a) => params.areas!.includes(a)).join(","));
  for (const key of ["action", "household", "from", "to"] as const) {
    const value = params[key]?.trim() ?? "";
    if (value !== "") search.set(key, value);
  }
  return search.toString();
}

/** The user page with the filters: `/users/<id>`, `/users/<id>?areas=lists&action=item.checked`. */
export function userActivityHref(userId: string, params: Partial<UserActivityParams>): string {
  const search = userActivitySearch(params);
  return search === "" ? `/users/${userId}` : `/users/${userId}?${search}`;
}

/** Whether any filter is set. */
export function hasFilters(params: UserActivityParams): boolean {
  return userActivitySearch(params) !== "";
}

/** Toggling an area chip: on or off, dropping the action when it falls outside the new areas. */
export function toggleArea(params: UserActivityParams, area: ActivityArea): UserActivityParams {
  const areas = params.areas.includes(area) ? params.areas.filter((a) => a !== area) : [...params.areas, area];
  const ordered = AREA_KEYS.filter((a) => areas.includes(a));
  const actionAreaOf = actionArea(params.action);
  const keep = params.action === "" || ordered.length === 0 || actionAreaOf === null || ordered.includes(actionAreaOf);
  return { ...params, areas: ordered, action: keep ? params.action : "" };
}

function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/**
 * `admin_user_activity`'s arguments for the filters and a page: `p_from` the start of the first day
 * (UTC), `p_to` the start of the day after the last (the function's end is exclusive), `p_before` the
 * previous page's `next_before` (none for a first page, which the function audits).
 */
export function userActivityArgs(userId: string, params: UserActivityParams, before: string | null = null) {
  return {
    p_user_id: userId,
    p_areas: params.areas.length === 0 ? null : params.areas,
    p_actions: params.action === "" ? null : [params.action],
    p_household_id: params.household === "" ? null : params.household,
    p_from: params.from === "" ? null : `${params.from}T00:00:00.000Z`,
    p_to: params.to === "" ? null : nextDay(params.to),
    p_before: before,
    p_limit: USER_ACTIVITY_PAGE_SIZE,
  };
}

/** "All" and each area's chip count; All is their sum. */
export function areaCounts(counts: Record<string, number> | null | undefined): { all: number; byArea: Record<ActivityArea, number> } {
  const byArea = Object.fromEntries(
    AREA_KEYS.map((area) => [area, typeof counts?.[area] === "number" ? counts[area] : 0]),
  ) as Record<ActivityArea, number>;
  return { all: AREA_KEYS.reduce((sum, area) => sum + byArea[area], 0), byArea };
}
