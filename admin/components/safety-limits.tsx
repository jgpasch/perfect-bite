"use client";

// The Safety limits card (spec 4.12): each key's per-user limits a minute and a day, the same on
// every plan, blank for none. Edit opens a dialog with both numbers (blank is no limit) and the
// required note; the server's message stays in the dialog on failure.
import { useId, useState, useTransition } from "react";

import { ErrorLine, NoteField } from "@/components/plan-grid";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isNoteValid } from "@/lib/plan-change";
import { setSafetyLimit } from "@/lib/plan-actions";
import {
  MINUTE_UNIT,
  dayUnit,
  fieldText,
  limitNumber,
  parseSafetyLimit,
  safetyLimitHint,
  safetyLimitLabel,
  safetyLimitSave,
} from "@/lib/safety-limits";
import type { AdminSafetyLimit, AdminSafetyLimitList } from "@/lib/types";

export function SafetyLimitsCard({ limits }: { limits: AdminSafetyLimitList }) {
  return (
    <section aria-labelledby="safety-limits-title" className="overflow-x-auto rounded-2xl bg-surface shadow-sm">
      <div className="px-5 pt-4 pb-2">
        <h2 id="safety-limits-title" className="text-[17px] font-bold text-ink">
          Safety limits
        </h2>
        <p className="mt-0.5 max-w-3xl text-[13px] text-ink-secondary">
          Per user, the same on every plan. They stop a client stuck in a loop or a scripted account, not a person. A day is
          the user&apos;s UTC day. Blank is no limit. Changes apply on the next request.
        </p>
      </div>
      <table className="w-full text-left text-[15px] tabular-nums">
        <thead className="border-y border-border text-[13px] font-semibold text-ink-secondary">
          <tr>
            <th scope="col" className="py-3 pr-4 pl-5">Feature</th>
            <th scope="col" className="px-4 py-3">Per minute</th>
            <th scope="col" className="px-4 py-3">Per day</th>
            <th scope="col" className="py-3 pr-5 pl-4">
              <span className="sr-only">Edit</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {limits.map((limit) => (
            <SafetyLimitRow key={limit.key} limit={limit} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SafetyLimitRow({ limit }: { limit: AdminSafetyLimit }) {
  const [editing, setEditing] = useState(false);
  const hint = safetyLimitHint(limit.key);
  return (
    <tr className="border-b border-border align-top text-ink last:border-0">
      <th scope="row" className="py-2.5 pr-4 pl-5 font-normal">
        <div className="font-semibold">{safetyLimitLabel(limit.key)}</div>
        {hint && <div className="text-[13px] text-ink-secondary">{hint}</div>}
        <div className="font-mono text-[12px] text-ink-tertiary">{limit.key}</div>
      </th>
      <td className="px-4 py-2.5">
        <LimitValue value={limit.per_minute} unit={MINUTE_UNIT} />
      </td>
      <td className="px-4 py-2.5">
        <LimitValue value={limit.per_day} unit={dayUnit(limit.key)} />
      </td>
      <td className="py-2 pr-5 pl-4 text-right">
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${safetyLimitLabel(limit.key)}`}>
          Edit
        </Button>
        {editing && <SafetyLimitDialog limit={limit} onClose={() => setEditing(false)} />}
      </td>
    </tr>
  );
}

// The number and its unit; blank for none, with "no limit" for screen readers.
function LimitValue({ value, unit }: { value: number | null; unit: string }) {
  if (value === null) return <span className="sr-only">No limit</span>;
  return (
    <span>
      <span className="font-semibold">{limitNumber(value)}</span> <span className="text-[13px] text-ink-secondary">{unit}</span>
    </span>
  );
}

function SafetyLimitDialog({ limit, onClose }: { limit: AdminSafetyLimit; onClose: () => void }) {
  const [minuteText, setMinuteText] = useState(fieldText(limit.per_minute));
  const [dayText, setDayText] = useState(fieldText(limit.per_day));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const minuteValid = parseSafetyLimit(minuteText).ok;
  const dayValid = parseSafetyLimit(dayText).ok;
  const change = safetyLimitSave(limit, minuteText, dayText);
  const canSave = change !== null && isNoteValid(note) && !pending;
  const label = safetyLimitLabel(limit.key);

  function save() {
    if (!canSave || change === null) return;
    setError(null);
    startTransition(async () => {
      const result = await setSafetyLimit(limit.key, change.per_minute, change.per_day, note);
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
      <DialogContent className="text-left sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[20px] text-ink">{label} safety limits</DialogTitle>
          <DialogDescription className="text-ink-secondary">
            Per user, on every plan. Leave a number blank for no limit. It applies on the next request.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <LimitField label="Per minute" unit={MINUTE_UNIT} value={minuteText} onChange={setMinuteText} valid={minuteValid} disabled={pending} />
          <LimitField label="Per day" unit={dayUnit(limit.key)} value={dayText} onChange={setDayText} valid={dayValid} disabled={pending} />
          <NoteField note={note} onChange={setNote} disabled={pending} />
          <ErrorLine error={error} />
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Cancel</DialogClose>
            <Button type="submit" disabled={!canSave}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LimitField({
  label,
  unit,
  value,
  onChange,
  valid,
  disabled,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  valid: boolean;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[14px] font-semibold text-ink">
        {label}
      </label>
      <div className="flex items-center gap-3">
        <Input
          id={id}
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder="No limit"
          aria-invalid={!valid}
          className="w-28 tabular-nums"
        />
        <span className="text-[13px] text-ink-secondary">{unit}</span>
      </div>
      {!valid && <p className="text-[13px] text-danger">A whole number from 0, or blank for no limit.</p>}
    </div>
  );
}
