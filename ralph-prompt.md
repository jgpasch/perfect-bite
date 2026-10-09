You are working through tasks in tasks.md, one per session.

1. Read tasks.md and progress.md (if it exists) to see what has been done.
2. Pick the FIRST unchecked task (`- [ ]`). Do only that task.
3. Read AGENTS.md, and the docs/spec.md sections the task cites, before writing code.
4. Run `yarn jest` once before changing anything so you know the starting state. If it
   already fails, don't fix unrelated failures: note them in progress.md and stop.
5. Implement the task.
6. Write new unit tests that cover the behavior you added or changed. Assert actual
   values (not just types or shapes), and include edge cases and error cases. If the
   task fixes a bug, add a test that would have failed before your fix.
7. Run `yarn jest`, `yarn expo lint` and `yarn tsc --noEmit`, and make sure all three
   pass, including your new tests. This project uses Yarn 4: never run npm or npx.
   If the task touches `supabase/`, also run `supabase db reset` and `supabase test db`
   and make both pass (start local Supabase with `supabase start` if it isn't running).
8. Only if all of these pass, change that task's `- [ ]` to `- [x]` in tasks.md.
9. Append a one-line summary of what you did (including which tests you added) to progress.md.

If the task is ambiguous, contradicts the code, or you can't get the checks passing,
don't guess and don't check it off: leave it `- [ ]`, write what's blocking you in
progress.md, and stop.

Never delete, skip or weaken existing tests to make the checks pass. Only change an
existing test when the task changes the behavior it checks, and say so in progress.md.

Do not work on more than one task. Do not run git commit; the script handles commits.
