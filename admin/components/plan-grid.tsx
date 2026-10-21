"use client";

// The Plans grid (spec 4.12): the six features as rows and each plan as a column. A cell opens a
// popover to turn the feature on or off for that plan and set its monthly limit; a column's menu
// duplicates, renames, makes default or deletes the plan. Every edit asks for a note, and the
// server's message stays in the popover or dialog on failure.
import { MoreHorizontal } from "lucide-react";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FEATURE_KEYS, FEATURES, featureColors, type Feature } from "@/lib/features";
import {
  createPlan,
  deletePlan,
  renamePlan,
  setDefaultPlan,
  setPlanFeature,
  setPlanLimit,
  type ActionResult,
} from "@/lib/plan-actions";
import { isNoteValid } from "@/lib/plan-change";
import {
  affectsLine,
  cellSave,
  cellWording,
  copyId,
  copyName,
  defaultLimit,
  deleteBlockedReason,
  isPlanIdValid,
  parseLimit,
  planFeature,
  usersCount,
} from "@/lib/plans";
import type { AdminPlan, AdminPlanList } from "@/lib/types";
import { cn } from "@/lib/utils";

export function PlanGrid({ plans }: { plans: AdminPlanList }) {
  return (
    <div className="overflow-x-auto rounded-2xl bg-surface shadow-sm">
      <table className="w-full text-left text-[15px] tabular-nums">
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className="py-3 pr-4 pl-5 align-bottom text-[13px] font-semibold text-ink-secondary">
              Feature
            </th>
            {plans.map((plan) => (
              <th key={plan.id} scope="col" className="min-w-36 px-4 py-3 align-bottom font-normal">
                <PlanHeader plan={plan} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FEATURE_KEYS.map((feature) => (
            <tr key={feature} className="border-b border-border last:border-0">
              <th scope="row" className="py-2 pr-4 pl-5 font-normal">
                <FeatureLabel feature={feature} />
              </th>
              {plans.map((plan) => (
                <td key={plan.id} className="px-2 py-1">
                  <PlanCell plan={plan} feature={feature} plans={plans} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeatureLabel({ feature }: { feature: Feature }) {
  const info = FEATURES[feature];
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: featureColors(feature).color }} />
      <span className="font-semibold text-ink">{info.label}</span>
      <span className="text-[13px] text-ink-tertiary">{info.unit}</span>
    </span>
  );
}

function PlanHeader({ plan }: { plan: AdminPlan }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[15px] font-bold text-ink">{plan.name}</span>
          {plan.is_default && (
            <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[12px] font-semibold text-primary">Default</span>
          )}
        </div>
        <div className="font-mono text-[12px] text-ink-tertiary">{plan.id}</div>
        <div className="text-[13px] text-ink-secondary">{usersCount(plan.users)}</div>
      </div>
      <PlanMenu plan={plan} />
    </div>
  );
}

// --- A cell --------------------------------------------------------------------------------------

function PlanCell({ plan, feature, plans }: { plan: AdminPlan; feature: Feature; plans: AdminPlanList }) {
  const entry = planFeature(plan, feature);
  const before = { enabled: entry !== null, limit: entry?.monthly_limit ?? null };
  const wording = cellWording(plan, feature);
  const colors = featureColors(feature);

  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(before.enabled);
  const [noLimit, setNoLimit] = useState(before.limit === null);
  const [limitText, setLimitText] = useState(before.limit === null ? "" : String(before.limit));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const switchId = useId();
  const limitId = useId();
  const noLimitId = useId();

  function onOpenChange(next: boolean) {
    if (pending) return;
    if (next) {
      setEnabled(before.enabled);
      setNoLimit(before.limit === null);
      setLimitText(before.limit === null ? "" : String(before.limit));
      setNote("");
      setError(null);
    }
    setOpen(next);
  }

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    if (next && !before.enabled) {
      const prefill = defaultLimit(plans, feature);
      setNoLimit(prefill === null);
      setLimitText(prefill === null ? "" : String(prefill));
    }
  }

  const limit = noLimit ? null : parseLimit(limitText);
  const limitValid = !enabled || noLimit || limit !== null;
  const change = limitValid ? cellSave(before, { enabled, limit }) : null;

  function save() {
    if (change === null || !isNoteValid(note)) return;
    setError(null);
    startTransition(async () => {
      const result =
        change.kind === "feature"
          ? await setPlanFeature(plan.id, feature, change.enabled, change.limit, note)
          : await setPlanLimit(plan.id, feature, change.limit, note);
      if (result.ok) setOpen(false);
      else setError(result.message);
    });
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={`${FEATURES[feature].label} in ${plan.name}: ${wording === "—" ? "not in plan" : wording}`}
        className="w-full cursor-pointer rounded-lg px-2 py-1.5 text-left text-[15px] outline-none hover:bg-surface-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {entry === null ? (
          <span className="text-ink-tertiary">—</span>
        ) : (
          <span className="rounded-md px-1.5 py-0.5 font-semibold" style={{ backgroundColor: colors.soft, color: colors.strong }}>
            {wording}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-3 bg-surface p-4 text-ink">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <p className="text-[15px] font-bold">
            {FEATURES[feature].label} · {plan.name}
          </p>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={switchId} className="text-[14px] font-semibold">
              In this plan
            </label>
            <button
              id={switchId}
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={toggle}
              disabled={pending}
              className={cn(
                "relative h-6 w-10 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                enabled ? "bg-primary" : "bg-border",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-0.5 left-0.5 size-5 rounded-full bg-surface shadow transition-transform",
                  enabled && "translate-x-4",
                )}
              />
            </button>
          </div>
          {enabled && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={limitId} className="text-[14px] font-semibold">
                Monthly limit
              </label>
              <div className="flex items-center gap-3">
                <Input
                  id={limitId}
                  inputMode="numeric"
                  value={noLimit ? "" : limitText}
                  onChange={(event) => setLimitText(event.target.value)}
                  disabled={pending || noLimit}
                  placeholder={noLimit ? "No limit" : "0"}
                  aria-invalid={!limitValid}
                  className="w-28 tabular-nums"
                />
                <span className="text-[13px] text-ink-secondary">{FEATURES[feature].unit}</span>
                <label htmlFor={noLimitId} className="ml-auto flex items-center gap-1.5 text-[14px]">
                  <input
                    id={noLimitId}
                    type="checkbox"
                    checked={noLimit}
                    onChange={(event) => setNoLimit(event.target.checked)}
                    disabled={pending}
                    className="accent-primary"
                  />
                  No limit
                </label>
              </div>
            </div>
          )}
          <NoteField note={note} onChange={setNote} disabled={pending} />
          <p className="text-[13px] text-ink-secondary">{affectsLine(plan.users)}</p>
          <ErrorLine error={error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || change === null || !isNoteValid(note)}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

// --- A column's menu ----------------------------------------------------------------------------

type MenuAction = "duplicate" | "rename" | "default" | "delete";

function PlanMenu({ plan }: { plan: AdminPlan }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [action, setAction] = useState<MenuAction | null>(null);
  const deleteReason = deleteBlockedReason(plan);

  function choose(next: MenuAction) {
    setMenuOpen(false);
    setAction(next);
  }

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger
          aria-label={`${plan.name} actions`}
          className="-mr-1 rounded-lg p-1 text-ink-secondary outline-none hover:bg-surface-muted hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 gap-0.5 bg-surface p-1.5 text-ink">
          <MenuItem onClick={() => choose("duplicate")}>Duplicate…</MenuItem>
          <MenuItem onClick={() => choose("rename")}>Rename…</MenuItem>
          <MenuItem onClick={() => choose("default")} disabled={plan.is_default} reason={plan.is_default ? "It's the default already." : null}>
            Make default
          </MenuItem>
          <MenuItem onClick={() => choose("delete")} disabled={deleteReason !== null} reason={deleteReason} danger>
            Delete
          </MenuItem>
        </PopoverContent>
      </Popover>
      {action !== null && <PlanActionDialog plan={plan} action={action} onClose={() => setAction(null)} />}
    </>
  );
}

function MenuItem({
  onClick,
  disabled = false,
  reason = null,
  danger = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  reason?: string | null;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full flex-col rounded-md px-2.5 py-1.5 text-left text-[14px] font-semibold outline-none hover:bg-surface-muted focus-visible:bg-surface-muted disabled:cursor-not-allowed disabled:hover:bg-transparent",
        danger ? "text-danger" : "text-ink",
        disabled && "opacity-60",
      )}
    >
      {children}
      {reason !== null && <span className="text-[12px] font-normal text-ink-secondary">{reason}</span>}
    </button>
  );
}

const DIALOG_TITLES: Record<MenuAction, string> = {
  duplicate: "Duplicate plan",
  rename: "Rename plan",
  default: "Make default",
  delete: "Delete plan",
};

function PlanActionDialog({ plan, action, onClose }: { plan: AdminPlan; action: MenuAction; onClose: () => void }) {
  const [id, setId] = useState(copyId(plan.id));
  const [name, setName] = useState(action === "duplicate" ? copyName(plan.name) : plan.name);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const idField = useId();
  const nameField = useId();

  const idValid = action !== "duplicate" || isPlanIdValid(id.trim());
  const nameValid = (action !== "duplicate" && action !== "rename") || name.trim() !== "";
  const canSave = idValid && nameValid && isNoteValid(note) && !pending;

  function save() {
    if (!canSave) return;
    setError(null);
    startTransition(async () => {
      let result: ActionResult;
      if (action === "duplicate") result = await createPlan(id, name, plan.id, note);
      else if (action === "rename") result = await renamePlan(plan.id, name, note);
      else if (action === "default") result = await setDefaultPlan(plan.id, note);
      else result = await deletePlan(plan.id, note);
      if (result.ok) onClose();
      else setError(result.message);
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[20px] text-ink">{DIALOG_TITLES[action]}</DialogTitle>
          <DialogDescription className="text-ink-secondary">
            {action === "duplicate" && `A new plan with ${plan.name}'s features and limits. It starts with no users.`}
            {action === "rename" && `The id stays ${plan.id}.`}
            {action === "default" && `Everyone without a plan of their own moves to ${plan.name} right away.`}
            {action === "delete" && `${plan.name} and its limits are deleted. No one is on it.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {action === "duplicate" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={idField} className="text-[14px] font-semibold text-ink">
                Id
              </label>
              <Input
                id={idField}
                value={id}
                onChange={(event) => setId(event.target.value)}
                disabled={pending}
                aria-invalid={!idValid}
                className="font-mono"
              />
              <p className={cn("text-[13px]", idValid ? "text-ink-secondary" : "text-danger")}>
                A lowercase letter, then 1–30 lowercase letters, digits or _. It can&apos;t be changed later.
              </p>
            </div>
          )}
          {(action === "duplicate" || action === "rename") && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={nameField} className="text-[14px] font-semibold text-ink">
                Name
              </label>
              <Input id={nameField} value={name} onChange={(event) => setName(event.target.value)} disabled={pending} />
            </div>
          )}
          <NoteField note={note} onChange={setNote} disabled={pending} />
          <ErrorLine error={error} />
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Cancel</DialogClose>
            <Button type="submit" variant={action === "delete" ? "destructive" : "default"} disabled={!canSave}>
              {pending ? "Saving…" : action === "delete" ? "Delete" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Shared --------------------------------------------------------------------------------------

export function NoteField({ note, onChange, disabled }: { note: string; onChange: (note: string) => void; disabled: boolean }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[14px] font-semibold text-ink">
        Note
      </label>
      <textarea
        id={id}
        required
        rows={2}
        value={note}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder="Who asked and why"
        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-[15px] text-ink outline-none placeholder:text-ink-tertiary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[14px] text-danger">
      {error}
    </p>
  );
}
