// The wording of Activity (spec 4.12): each audit row's action label, target, one-line summary of
// `details` and who did it, and the page's filter and paging URLs, kept out of the page so they can
// be tested. `details` is whatever the writing function stored (see the migrations), so everything
// here reads it defensively.
import { flagLabel, taskLabel } from "./ai-calls";
import { mediumDate } from "./format";
import type { AdminAction, MonthlyLimit } from "./types";

/** Rows a page on /activity. */
export const ACTIVITY_PAGE_SIZE = 50;

/** The actions the portal knows, in the filter's order, with their labels. */
export const ACTION_LABELS = {
  set_user_plan: "Changed plan",
  set_plan_limit: "Changed a limit",
  set_plan_feature: "Changed a feature",
  create_plan: "Created a plan",
  rename_plan: "Renamed a plan",
  set_default_plan: "Changed the default plan",
  delete_plan: "Deleted a plan",
  delete_user: "Deleted user",
  delete_account: "Deleted own account",
  view_ai_call: "Viewed an AI call",
  block_ai_photos: "Blocked AI photos",
  unblock_ai_photos: "Unblocked AI photos",
} as const satisfies Record<string, string>;

export type KnownAction = keyof typeof ACTION_LABELS;

export const ACTION_KEYS = Object.keys(ACTION_LABELS) as KnownAction[];

function isKnownAction(action: string): action is KnownAction {
  return Object.hasOwn(ACTION_LABELS, action);
}

/** The action's label, or the raw name for one the portal doesn't know. */
export function actionLabel(action: string): string {
  return isKnownAction(action) ? ACTION_LABELS[action] : action;
}

/** The filter's choices: every known action, plus the current one when it isn't known. */
export function actionOptions(current: string): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = ACTION_KEYS.map((key) => ({ value: key, label: ACTION_LABELS[key] }));
  if (current !== "" && !isKnownAction(current)) options.push({ value: current, label: current });
  return options;
}

/** The page's URL: `/activity`, `/activity?action=set_user_plan`, `/activity?action=…&page=2`. */
export function activityHref(action: string, page: number): string {
  const params = new URLSearchParams();
  if (action.trim() !== "") params.set("action", action.trim());
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search === "" ? "/activity" : `/activity?${search}`;
}

export type ActionTarget =
  | { kind: "user"; label: string; href: string }
  | { kind: "plan" | "household" | "user_id"; label: string }
  | { kind: "none"; label: string };

/** The user's email linking to their page, else the plan id, else the household id (else the gone user's id). */
export function actionTarget(
  row: Pick<AdminAction, "target_user_id" | "target_user_email" | "target_plan_id" | "target_household_id">,
): ActionTarget {
  if (row.target_user_id && row.target_user_email) {
    return { kind: "user", label: row.target_user_email, href: `/users/${row.target_user_id}` };
  }
  if (row.target_plan_id) return { kind: "plan", label: row.target_plan_id };
  if (row.target_household_id) return { kind: "household", label: row.target_household_id };
  if (row.target_user_id) return { kind: "user_id", label: row.target_user_id };
  return { kind: "none", label: "—" };
}

/**
 * Who did it: the admin's email, "Dashboard" for `postgres`, "The user" for the app's own deletion,
 * "Automatic" for a row nobody did by hand (the AI photo block's trigger), else the raw value.
 */
export function actionWho(row: Pick<AdminAction, "action" | "performed_by" | "performed_by_email">): string {
  if (row.performed_by_email) return row.performed_by_email;
  if (row.performed_by === "postgres") return "Dashboard";
  if (row.action === "delete_account") return "The user";
  if (row.performed_by === null) return "Automatic";
  return row.performed_by;
}

/** The page a row's summary links to: the call, for `view_ai_call`; else null. */
export function actionHref(row: Pick<AdminAction, "action" | "details">): string | null {
  if (row.action !== "view_ai_call") return null;
  const id = text(record(row.details)?.ai_call_id);
  return id === null ? null : `/ai-calls/${encodeURIComponent(id)}`;
}

// --- Summaries -------------------------------------------------------------------------------

type Snapshot = { id?: unknown; name?: unknown; features?: unknown };
type FeatureLimit = { feature: string; monthly_limit: MonthlyLimit };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function planRef(value: unknown): string {
  return text(value) ?? "default";
}

function limitText(limit: MonthlyLimit | undefined): string {
  return typeof limit === "number" ? limit.toLocaleString("en-US") : "no limit";
}

function features(snapshot: unknown): Map<string, MonthlyLimit> {
  const list = record(snapshot)?.features;
  const map = new Map<string, MonthlyLimit>();
  if (!Array.isArray(list)) return map;
  for (const item of list as Partial<FeatureLimit>[]) {
    if (typeof item?.feature === "string") {
      map.set(item.feature, typeof item.monthly_limit === "number" ? item.monthly_limit : null);
    }
  }
  return map;
}

function plural(count: number, one: string, other: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : other}`;
}

// What changed between two snapshots' features, one clause each, in the after/before order.
function featureChanges(before: unknown, after: unknown): string[] {
  const was = features(before);
  const now = features(after);
  const changes: string[] = [];
  for (const [feature, limit] of now) {
    if (!was.has(feature)) changes.push(`${feature} added, limit ${limitText(limit)}`);
    else if (was.get(feature) !== limit) changes.push(`${feature} limit ${limitText(was.get(feature))} → ${limitText(limit)}`);
  }
  for (const feature of was.keys()) {
    if (!now.has(feature)) changes.push(`${feature} removed`);
  }
  return changes;
}

// "2 households: 1 promoted, 1 deleted", from `delete_user`/`delete_account`'s households.
function householdsSummary(households: unknown): string {
  if (!Array.isArray(households) || households.length === 0) return "No households";
  const counts = new Map<string, number>();
  for (const household of households) {
    const outcome = text(record(household)?.outcome) ?? "unknown";
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  const parts = [...counts].map(([outcome, count]) => `${count} ${outcome}`);
  return `${plural(households.length, "household", "households")}: ${parts.join(", ")}`;
}

function quoted(name: unknown): string {
  return `“${text(name) ?? "?"}”`;
}

// For an action the portal doesn't know: the details as compact JSON, cut to 80 characters.
function rawSummary(details: Record<string, unknown>): string {
  if (Object.keys(details).length === 0) return "";
  const json = JSON.stringify(details);
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}

/** One line from the row's `details`: "plus → unlimited", "recipe_import limit 40 → 60", …. */
export function actionSummary(row: Pick<AdminAction, "action" | "details">): string {
  const details = record(row.details) ?? {};
  const before = record(details.before) as Snapshot | null;
  const after = record(details.after) as Snapshot | null;

  switch (row.action) {
    case "set_user_plan":
      return `${planRef(details.from)} → ${planRef(details.to)}`;
    case "set_plan_limit":
    case "set_plan_feature": {
      const changes = featureChanges(before, after);
      return changes.length === 0 ? "No change" : changes.join("; ");
    }
    case "create_plan": {
      const count = features(after).size;
      return `${quoted(after?.name)} · ${count === 0 ? "no features" : plural(count, "feature", "features")}`;
    }
    case "rename_plan":
      return `${quoted(before?.name)} → ${quoted(after?.name)}`;
    case "set_default_plan":
      return `${text(details.previous_default) ?? "none"} → ${text(after?.id) ?? "?"}`;
    case "delete_plan":
      return `${quoted(before?.name)} · ${plural(typeof details.users === "number" ? details.users : 0, "user", "users")}`;
    case "delete_user": {
      const households = householdsSummary(details.households);
      const email = text(details.email);
      return email === null ? households : `${email} · ${households}`;
    }
    case "delete_account":
      return householdsSummary(details.households);
    case "view_ai_call": {
      const task = text(details.task);
      const flag = text(details.flag);
      const parts = [task === null ? "AI call" : taskLabel(task)];
      if (flag !== null) parts.push(flagLabel(flag));
      return parts.join(" · ");
    }
    case "block_ai_photos":
      return typeof details.refusals === "number" ? plural(details.refusals, "refusal", "refusals") : "";
    case "unblock_ai_photos": {
      const blockedAt = text(details.blocked_at);
      const parts: string[] = [];
      if (blockedAt !== null) parts.push(`Blocked ${mediumDate(blockedAt)}`);
      if (typeof details.refusals === "number") parts.push(`after ${plural(details.refusals, "refusal", "refusals")}`);
      return parts.join(" ");
    }
    default:
      return rawSummary(details);
  }
}
