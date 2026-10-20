// What the `public.admin_*` functions return (spec 4.12), written by hand from their migrations in
// supabase/migrations/ (2026111[5-8]*_admin_*.sql). Timestamps are ISO 8601 strings, dates
// `YYYY-MM-DD`, and a feature is its key as stored (see `Feature` in ./features for the known ones).
// Keep in step with the SQL.

/** A limit from `private.monthly_limit`: a number, or null for no limit. */
export type MonthlyLimit = number | null;

// --- Users: admin_list_users, admin_user_detail, admin_set_user_plan -------------------------

/** One row of `admin_list_users(p_search, p_limit, p_offset)`, which returns a table. */
export type AdminUserRow = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  /** Their plan: their `user_plans` row's, else the default's (null when no plan is the default). */
  plan_id: string | null;
  /** False when they're on the default. */
  plan_assigned: boolean;
  assigned_at: string | null;
  /** The matches before paging (a bigint, which PostgREST sends as a number). */
  total_count: number;
};

export type AdminUserHousehold = {
  id: string;
  name: string;
  role: "owner" | "member";
  member_count: number;
};

export type AdminFeatureUsage = {
  feature: string;
  in_plan: boolean;
  /** This calendar month (UTC), in the limit's unit. */
  used: number;
  limit: MonthlyLimit;
  /** The first instant of next month, UTC. */
  resets_at: string;
};

/** `details` of a `set_user_plan` audit row: plan ids, null for the default. */
export type SetUserPlanDetails = {
  from: string | null;
  to: string | null;
};

export type AdminPlanHistoryEntry = {
  id: string;
  created_at: string;
  details: SetUserPlanDetails;
  note: string | null;
  /** The admin's user id, `postgres` from the dashboard, or another role name. */
  performed_by: string;
  /** The admin's email while `performed_by` is a user id that still exists; else null. */
  performed_by_email: string | null;
};

/** `admin_user_detail(p_user_id)`. Raises `user not found` (P0002) for an unknown id. */
export type AdminUserDetail = Omit<AdminUserRow, "total_count"> & {
  plan: {
    id: string | null;
    name: string | null;
    assigned: boolean;
    assigned_at: string | null;
  };
  first_month: {
    /** Whether limits are doubled now (an account younger than 30 days). */
    doubled: boolean;
    ends_at: string | null;
  };
  /** In their household order. */
  households: AdminUserHousehold[];
  /** One per feature, in the fixed order. */
  usage: AdminFeatureUsage[];
  /** Newest first. */
  plan_history: AdminPlanHistoryEntry[];
};

/** `admin_set_user_plan(p_user_id, p_plan_id, p_note)` returns its audit row's details. */
export type AdminSetUserPlanResult = SetUserPlanDetails;

// --- AI usage: admin_ai_usage ----------------------------------------------------------------

export type AdminTopUser = {
  user_id: string;
  email: string | null;
  plan_id: string | null;
  used: number;
  limit: MonthlyLimit;
};

export type AdminFeatureUsageSummary = {
  feature: string;
  /** This calendar month (UTC) across everyone, in the limit's unit. */
  used: number;
  /** How many users used any this month. */
  users: number;
  /** The last 40 UTC days, oldest first, zeros included. */
  daily: { day: string; used: number }[];
  /** The 10 heaviest this month, heaviest first. */
  top_users: AdminTopUser[];
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
  /** One per feature, in the fixed order. */
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
  /** Users assigned it, plus, for the default, everyone unassigned. */
  users: number;
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
  /** How many users the plan applies to. */
  users: number;
  /** `admin_set_default_plan` only: the old default's id, or null. */
  previous_default?: string | null;
};

// --- Activity: admin_list_actions ------------------------------------------------------------

export type AdminAction = {
  id: string;
  /** `set_user_plan`, a plan edit (`create_plan`, …), `delete_user` or `delete_account`. */
  action: string;
  target_user_id: string | null;
  /** While that user still exists. */
  target_user_email: string | null;
  target_household_id: string | null;
  target_plan_id: string | null;
  details: Record<string, unknown>;
  note: string | null;
  performed_by: string;
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
