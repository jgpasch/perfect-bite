"use client";

// Change plan on a user's page (spec 4.12): the default plan first, then every plan with its features
// and limits, the current one marked, and a required note. Save calls admin_set_user_plan; the dialog
// closes, "Moved <email> to <plan>" shows and the page reloads its data. An error stays in the dialog.
import { useEffect, useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setUserPlan } from "@/lib/plan-actions";
import { isNoteValid, movedMessage, planChoices } from "@/lib/plan-change";
import type { AdminPlanList } from "@/lib/types";
import { cn } from "@/lib/utils";

const MOVED_MS = 5000;

export function ChangePlan({
  userId,
  email,
  plans,
  currentPlanId,
}: {
  userId: string;
  email: string | null;
  plans: AdminPlanList;
  /** Their `user_plans` plan id, or null on the default. */
  currentPlanId: string | null;
}) {
  const choices = planChoices(plans, currentPlanId);
  const currentValue = currentPlanId ?? "";
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentValue);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const noteId = useId();
  const name = useId();

  useEffect(() => {
    if (moved === null) return;
    const timer = setTimeout(() => setMoved(null), MOVED_MS);
    return () => clearTimeout(timer);
  }, [moved]);

  function onOpenChange(next: boolean) {
    if (pending) return;
    if (next) {
      setValue(currentValue);
      setNote("");
      setError(null);
    }
    setOpen(next);
  }

  function save() {
    const choice = choices.find((c) => c.value === value);
    if (!choice || !isNoteValid(note)) return;
    setError(null);
    startTransition(async () => {
      const result = await setUserPlan(userId, choice.planId, note);
      if (result.ok) {
        setOpen(false);
        setMoved(movedMessage(email, choice));
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <>
      <Button variant="outline" className="mt-4" onClick={() => onOpenChange(true)}>
        Change plan
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[20px] text-ink">Change plan</DialogTitle>
            <DialogDescription className="text-ink-secondary">{email ?? userId}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Plan</legend>
              {choices.map((choice) => (
                <label
                  key={choice.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3",
                    value === choice.value ? "border-primary bg-primary-soft/40" : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name={name}
                    value={choice.value}
                    checked={value === choice.value}
                    onChange={() => setValue(choice.value)}
                    disabled={pending}
                    className="mt-1 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                      {choice.title}
                      {choice.current && (
                        <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[12px] font-semibold text-ink-secondary">
                          Current
                        </span>
                      )}
                    </span>
                    <span className="block text-[13px] text-ink-secondary">{choice.summary}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={noteId} className="text-[14px] font-semibold text-ink">
                Note
              </label>
              <textarea
                id={noteId}
                required
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                disabled={pending}
                placeholder="Who asked and why"
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-[15px] text-ink outline-none placeholder:text-ink-tertiary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <p className="text-[13px] text-ink-secondary">
                AI requests use the new plan right away; the app shows or hides features the next time it&apos;s opened.
              </p>
            </div>
            {error !== null && (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[14px] text-danger">
                {error}
              </p>
            )}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Cancel</DialogClose>
              <Button type="submit" disabled={pending || !isNoteValid(note)}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <p
        role="status"
        className={cn(
          "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-toast px-4 py-2 text-[15px] font-semibold text-on-toast shadow-lg",
          moved === null && "sr-only",
        )}
      >
        {moved}
      </p>
    </>
  );
}
