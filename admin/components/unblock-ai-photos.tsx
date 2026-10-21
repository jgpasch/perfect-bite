"use client";

// Unblock on a user's AI photos card (spec 4.12): a required note, then admin_unblock_ai_photos. The
// dialog closes, "Unblocked AI photos for <email>" shows and the page reloads its data. An error
// stays in the dialog.
import { useEffect, useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { unblockedMessage } from "@/lib/ai-photo-block";
import { unblockAiPhotos } from "@/lib/block-actions";
import { isNoteValid } from "@/lib/plan-change";
import { cn } from "@/lib/utils";

const DONE_MS = 5000;

export function UnblockAiPhotos({ userId, email }: { userId: string; email: string | null }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const noteId = useId();

  useEffect(() => {
    if (done === null) return;
    const timer = setTimeout(() => setDone(null), DONE_MS);
    return () => clearTimeout(timer);
  }, [done]);

  function onOpenChange(next: boolean) {
    if (pending) return;
    if (next) {
      setNote("");
      setError(null);
    }
    setOpen(next);
  }

  function save() {
    if (!isNoteValid(note)) return;
    setError(null);
    startTransition(async () => {
      const result = await unblockAiPhotos(userId, note);
      if (result.ok) {
        setOpen(false);
        setDone(unblockedMessage(email));
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <>
      <Button variant="outline" className="mt-4" onClick={() => onOpenChange(true)}>
        Unblock
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[20px] text-ink">Unblock AI photos</DialogTitle>
            <DialogDescription className="text-ink-secondary">{email ?? userId}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
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
                They can generate AI photos again right away, once the app reloads its features. Only refusals from now on
                count toward a new block.
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
                {pending ? "Unblocking…" : "Unblock"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <p
        role="status"
        className={cn(
          "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-toast px-4 py-2 text-[15px] font-semibold text-on-toast shadow-lg",
          done === null && "sr-only",
        )}
      >
        {done}
      </p>
    </>
  );
}
