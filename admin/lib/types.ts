// What the `public.admin_*` functions return (spec 4.12), written by hand from their migrations in
// supabase/migrations/ (2026111[5-8]*_admin_*.sql, 20261202120000_admin_households.sql). Timestamps
// are ISO 8601 strings, dates `YYYY-MM-DD`, and a feature is its key as stored (see `Feature` and
// `UsageFeature` in ./features for the known ones). Keep in step with the SQL.

/** A limit from `private.monthly_limit`: a number, or null for no limit. */
export type MonthlyLimit = number | null;

// --- Users: admin_list_users, admin_user_detail ----------------------------------------------
// A user has no plan of their own: plans belong to households.

/** One row of `admin_list_users(p_search, p_limit, p_offset, p_blocked)`, which returns a table. */
export type AdminUserRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  /** Their AI photos are blocked (`private.ai_photo_blocks` has a row). */
  ai_photos_blocked: boolean;
  /** The matches before paging (a bigint, which PostgREST sends as a number). */
  total_count: number;
};

export type AdminUserHousehold = {
  id: string;
  name: string;
  role: "owner" | "member";
  member_count: number;
  /** The household's plan; both null when it has no `household_plans` row. */
  plan_id: string | null;
  plan_name: string | null;
};

/** `admin_user_detail(p_user_id)`. Raises `user not found` (P0002) for an unknown id. */
export type AdminUserDetail = Omit<AdminUserRow, "total_count" | "ai_photos_blocked"> & {
  /** In their household order. */
  households: AdminUserHousehold[];
  /** Their flagged AI calls in the last 30 days, a count per flag (`{}` when none). */
  ai_flags: Record<string, number>;
  /** Their AI photo block, or null when they aren't blocked. */
  ai_photo_block: AiPhotoBlock | null;
  /** `private.ai_photo_refusals` over the block window: refused prompts in the last 30 days, since their last unblock. */
  ai_photo_refusals_30d: number;
  /** Their newest activity entry or AI call (20261205120000_admin_user_activity.sql); null with neither. */
  last_active_at: string | null;
};

/** A row of `private.ai_photo_blocks`, as `admin_user_detail` sends it (20261128120000_admin_ai_photo_blocks.sql). */
export type AiPhotoBlock = {
  blocked_at: string;
  /** The refusals that blocked them. */
  refusals: number;
  /** The refusal that blocked them; null once that call is deleted. */
  last_call_id: string | null;
};

/**
 * `admin_unblock_ai_photos(p_user_id, p_note)` returns its audit row's details, the block's.
 * Raises `note required` (22023) or `not blocked` (P0002).
 */
export type AdminUnblockAiPhotosResult = Pick<AiPhotoBlock, "refusals" | "blocked_at">;

/**
 * `admin_revoke_device_credentials(p_user_id, p_note)` returns its audit row's details: how many
 * valid credentials it revoked, 0 with none (20261209100000_device_credentials.sql). Raises
 * `note required` (22023).
 */
export type AdminRevokeDeviceCredentialsResult = { revoked: number };

// --- Households: admin_list_households, admin_household_detail, admin_set_household_plan ------

/** One row of `admin_list_households(p_search, p_limit, p_offset)`, which returns a table. */
export type AdminHouseholdRow = {
  household_id: string;
  name: string;
  created_at: string;
  member_count: number;
  /** Its plan; both null when it has no `household_plans` row (which shouldn't happen). */
  plan_id: string | null;
  plan_name: string | null;
  /** The matches before paging. */
  total_count: number;
};

export type AdminHouseholdMember = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: "owner" | "member";
  joined_at: string;
};

export type AdminFeatureUsage = {
  feature: string;
  /** The household's plan has it. */
  in_plan: boolean;
  /** This calendar month (UTC), in the limit's unit. */
  used: number;
  /** Already doubled in the household's first month; 0 when not in the plan. */
  limit: MonthlyLimit;
  /** The first instant of next month, UTC. */
  resets_at: string;
};

/** `details` of a `set_household_plan` audit row: plan ids (`from` null for a household that had no row). */
export type SetHouseholdPlanDetails = {
  from: string | null;
  to: string;
};

export type AdminPlanHistoryEntry = {
  id: string;
  created_at: string;
  details: SetHouseholdPlanDetails;
  note: string | null;
  /** The admin's user id, `postgres` from the dashboard, or another role name. */
  performed_by: string;
  /** The admin's email while `performed_by` is a user id that still exists; else null. */
  performed_by_email: string | null;
};

/** `admin_household_detail(p_household_id)`. Raises `household not found` (P0002). */
export type AdminHouseholdDetail = {
  household_id: string;
  name: string;
  created_at: string;
  first_month: {
    /** Whether limits are doubled now (a household younger than 30 days). */
    doubled: boolean;
    ends_at: string | null;
  };
  /** Earliest joined first. */
  members: AdminHouseholdMember[];
  /** Null when it has no `household_plans` row. */
  plan: { id: string; name: string; assigned_at: string } | null;
  /** One per plan feature, in the fixed order. */
  usage: AdminFeatureUsage[];
  /** Its `set_household_plan` rows, newest first. */
  plan_history: AdminPlanHistoryEntry[];
};

/**
 * `admin_set_household_plan(p_household_id, p_plan_id, p_note)` returns its audit row's details.
 * Raises `household not found` or `plan not found` (P0002), `plan required` or `note required` (22023).
 */
export type AdminSetHouseholdPlanResult = SetHouseholdPlanDetails;

// --- AI usage: admin_ai_usage ----------------------------------------------------------------

/** A plan feature's heavy household this month. */
export type AdminTopHousehold = {
  household_id: string;
  name: string;
  /** Null when it has no `household_plans` row. */
  plan_id: string | null;
  used: number;
  limit: MonthlyLimit;
};

/** A heavy user of a feature every plan has (no monthly limit). */
export type AdminTopUser = {
  user_id: string;
  email: string | null;
  used: number;
};

export type AdminFeatureUsageSummary = {
  feature: string;
  /** This calendar month (UTC) across everyone, in the limit's unit. */
  used: number;
  /** How many users used any this month. */
  users: number;
  /** The last 40 UTC days, oldest first, zeros included. */
  daily: { day: string; used: number }[];
  /** The plan features only: the 10 heaviest households this month, heaviest first. */
  top_households?: AdminTopHousehold[];
  /** Categorize, step matching and tags only: the 10 heaviest users this month, heaviest first. */
  top_users?: AdminTopUser[];
};

export type AiCallStatus = "ok" | "api_error" | "invalid_output" | "timeout" | "refused" | "error";

export type AiCallStats = {
  total: number;
  /** Every status, zeros included. */
  statuses: Record<AiCallStatus, number>;
  /** Calls made as a fallback (`fallback_of` set). */
  fallbacks: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  reasoning_tokens: number;
};

/** One `ai_calls.task` as stored (tasks aren't features one-to-one). */
export type AiTaskCalls = AiCallStats & {
  task: string;
  /** By model name. */
  models: (AiCallStats & { model: string })[];
};

/** `admin_ai_usage()`. */
export type AdminAiUsage = {
  /** The first day of this month, UTC. */
  month_start: string;
  /** One per AI usage key (`private.ai_usage_keys()`), in order. */
  features: AdminFeatureUsageSummary[];
  /** The start of `calls`' window: the last 30 days. */
  calls_since: string;
  /** By task. */
  calls: AiTaskCalls[];
};

// --- Plans: admin_list_plans and the plan edits ----------------------------------------------

/** A plan as the portal shows it (`private.plan_snapshot`). */
export type AdminPlan = {
  id: string;
  name: string;
  is_default: boolean;
  /** Households on it (its `household_plans` rows). */
  households: number;
  /** The features it has, in the fixed order. */
  features: { feature: string; monthly_limit: MonthlyLimit }[];
};

/** `admin_list_plans()`: every plan, by id. */
export type AdminPlanList = AdminPlan[];

/**
 * What every plan edit returns (`admin_create_plan`, `admin_rename_plan`, `admin_set_default_plan`,
 * `admin_set_plan_feature`, `admin_set_plan_limit`, `admin_delete_plan`): its audit row's details.
 * `before` is null for a create, `after` null for a delete.
 */
export type AdminPlanChange = {
  before: AdminPlan | null;
  after: AdminPlan | null;
  /** How many households are on the plan. */
  households: number;
  /** `admin_set_default_plan` only: the old default's id, or null. */
  previous_default?: string | null;
};

// --- Safety limits: admin_list_safety_limits, admin_set_safety_limit ------------------------
// From 20261130120000_ai_safety_limits.sql.

/** A row of `public.ai_safety_limits`: a key's per-user limits, null for none. */
export type AdminSafetyLimit = {
  /** `categorize`, `step_match`, `recipe_tags`, `recipe_import_link`, `recipe_import_photo`, `recipe_import`, `recipe_photo_ai` or `share_ingest`. */
  key: string;
  /** Requests a minute. */
  per_minute: number | null;
  /** A UTC day, in the key's unit (names for categorize, link and photo imports together for recipe_import, else requests). */
  per_day: number | null;
};

/** `admin_list_safety_limits()`: every key, in the fixed order. */
export type AdminSafetyLimitList = AdminSafetyLimit[];

/**
 * `admin_set_safety_limit(p_key, p_per_minute, p_per_day, p_note)` returns its audit row's details
 * (`set_safety_limit`). Raises `unknown key` (P0002), `note required` (22023) or, for a negative
 * number, the table's check (23514).
 */
export type AdminSetSafetyLimitResult = {
  before: AdminSafetyLimit;
  after: AdminSafetyLimit;
};

// --- Activity: admin_list_actions ------------------------------------------------------------

export type AdminAction = {
  id: string;
  /** `set_household_plan`, `set_user_plan` (older rows), a plan edit (`create_plan`, …), `set_safety_limit`, `delete_user`, `delete_account`, `view_ai_call`, `view_user_activity`, `block_ai_photos`, `unblock_ai_photos` or `revoke_device_credentials`. */
  action: string;
  target_user_id: string | null;
  /** While that user still exists. */
  target_user_email: string | null;
  target_household_id: string | null;
  target_plan_id: string | null;
  details: Record<string, unknown>;
  note: string | null;
  /** As in `AdminPlanHistoryEntry`; null for the automatic `block_ai_photos`. */
  performed_by: string | null;
  /** As in `AdminPlanHistoryEntry`: null for `postgres` and the app's rows. */
  performed_by_email: string | null;
  created_at: string;
};

/** `admin_list_actions(p_action, p_limit, p_offset)`. */
export type AdminActionList = {
  /** Newest first. */
  actions: AdminAction[];
  /** The matches before paging. */
  total_count: number;
};

// --- User activity: admin_user_activity -----------------------------------------------------
// From 20261204120000_user_activity.sql (what's logged) and 20261205120000_admin_user_activity.sql.

/** Where an entry comes from: the user's writes, their AI calls, or an admin action about them. */
export type UserActivitySource = "app" | "ai" | "admin";

/** One entry of `admin_user_activity`. Area and action are strings so an unknown one still shows. */
export type UserActivityEntry = {
  at: string;
  source: UserActivitySource;
  /** `lists`, `recipes`, `plan`, `aisles`, `household`, `settings`, `devices`, `ai` or `admin`. */
  area: string;
  /** A catalog action (`item.checked`, …), `ai.<task>` or `admin.<action>`. */
  action: string;
  /** The row the entry is about (an AI call's or admin action's id for those sources); null for settings and devices. */
  entity_id: string | null;
  household_id: string | null;
  /** The household's name then (the snapshot), else its name now; null with no household. */
  household: string | null;
  /** The writing transaction (`app` only); entries sharing one fold together. */
  txid: number | null;
  /**
   * `app`: the catalog's names (spec 4.12), plus `invited_email` on `invite.created` while the invite
   * exists. `ai`: `{ id, status, flag, recipe_id }`. `admin`: `{ details, note, performed_by_email }`.
   */
  data: Record<string, unknown>;
};

/** `admin_user_activity(p_user_id, p_areas, p_actions, p_household_id, p_from, p_to, p_before, p_limit)`. */
export type AdminUserActivity = {
  /** Newest first; a page never splits one timestamp. */
  entries: UserActivityEntry[];
  /** `p_before` for the next page; null at the end. */
  next_before: string | null;
  /** Per area (all nine, zeros included) over the user, household and dates, ignoring the area and action filters. */
  counts: Record<string, number>;
};

// --- AI calls: admin_list_ai_calls, admin_ai_call, admin_ai_call_flag_count -----------------
// From 20261123120000_admin_ai_calls.sql.

/** `private.ai_call_flag`: why a call is flagged, or null. */
export type AiCallFlag = "not_food" | "refused" | "content_filter";

/** Which calls `admin_list_ai_calls` lists. */
export type AiCallKind = "flagged" | "failed" | "photos";

/** One call in `admin_list_ai_calls`. Status and flag are strings so an unknown one still shows. */
export type AdminAiCallRow = {
  id: string;
  created_at: string;
  /** As stored: an `AiTaskName`, `recipePhotoModeration` or `recipePhotoImage`. */
  task: string;
  /** `provider:model`. */
  model: string;
  prompt_version: string;
  status: string;
  flag: string | null;
  error: string | null;
  http_status: number | null;
  finish_reason: string | null;
  duration_ms: number;
  fallback_of: string | null;
  /** A fallback of this call ended `ok`. */
  recovered: boolean;
  /** Null for calls with no signed-in caller (the `yarn ai:*` scripts) and once the user is deleted. */
  user_id: string | null;
  /** While the user exists. */
  user_email: string | null;
  /** The user's AI photos are blocked now. */
  user_ai_photos_blocked: boolean;
  household_id: string | null;
  recipe_id: string | null;
  /** Image rows only: the `recipe-photos` object. */
  photo_path: string | null;
};

/** `admin_list_ai_calls(p_kind, p_task, p_status, p_flag, p_user_id, p_limit, p_offset)`. */
export type AdminAiCallList = {
  /** Newest first. */
  calls: AdminAiCallRow[];
  /** The matches before paging. */
  total_count: number;
};

/** `admin_ai_call`'s `fallback` and `primary`. */
export type AdminAiCallLink = {
  id: string;
  task: string;
  model: string;
  status: string;
  error: string | null;
};

/** `admin_ai_call(p_id)`: every column, plus the flag, the email, the photo and the linked attempts. Raises `not found` (P0002). */
export type AdminAiCall = Omit<AdminAiCallRow, "recovered" | "user_ai_photos_blocked"> & {
  instructions: string;
  prompt: string;
  output: unknown;
  response_text: string | null;
  error_body: string | null;
  /** The provider's own finish reason, e.g. Gemini's `RECITATION`; null on image rows and older rows. */
  raw_finish_reason: string | null;
  /** A failed call's block details per provider (safetyRatings, promptFeedback, finishMessage); null otherwise. */
  provider_metadata: Record<string, Record<string, unknown>> | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  /** The attempt that followed it: its fallback, or a description's image call. */
  fallback: AdminAiCallLink | null;
  /** The attempt it followed. */
  primary: AdminAiCallLink | null;
};
