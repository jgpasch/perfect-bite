// Tells the push that the outbox has something new, without `mutate.ts` importing the network layer.
type Listener = () => void;

let listener: Listener | null = null;

/** Called by `mutate.ts` after each enqueue. Runs after the caller's code, so a rolled-back write just finds nothing to push. */
export function notifyOutboxWrite(): void {
  listener?.();
}

/** Sets the one listener (the push's debounce); returns a cleanup. */
export function onOutboxWrite(next: Listener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}
