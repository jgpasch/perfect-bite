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

Manual checks don't block. You can't tap, scroll or look at the simulator or a device,
and you shouldn't install tools to try. If a task asks for a manual check (simulator
taps, VoiceOver, Dynamic Type, a real device, a second simulator), do everything else,
then append the check to manual-checks.md as `- [ ] <task name>: <what to check>`, and
check off the task in tasks.md as usual if the automated checks pass. If the whole task
is hands-on with no code to write (e.g. "End-to-end on a device"), copy it into
manual-checks.md, change its `- [ ]` in tasks.md to `- [m]`, note it in progress.md, and
stop. Either way, the next session moves on to the next task.

If the task is ambiguous, contradicts the code, or you can't get the checks passing,
don't guess and don't check it off: leave it `- [ ]`, write what's blocking you in
progress.md, and stop.

Never delete, skip or weaken existing tests to make the checks pass. Only change an
existing test when the task changes the behavior it checks, and say so in progress.md.

Real AI calls (OpenAI, Anthropic, Google, through the `yarn ai:*` scripts) are fine when they
help you decide something, such as tuning a prompt or checking that an output is good. The keys
have a few dollars of prepaid credit shared by every task, so be sparing: don't repeat a run
that already answered your question, and don't loop on retries. If a call fails for lack of
credit, stop and write that in progress.md. Say in progress.md what real calls you made and
what you decided from them. Automated tests (`yarn jest`, Deno tests, `yarn e2e`) never make
real calls: they use fakes and the `mock` models.

Do not work on more than one task. Do not run git commit; the script handles commits.
