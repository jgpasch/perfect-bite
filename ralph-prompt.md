You are working through tasks in tasks.md, one per session.

1. Read tasks.md and progress.md (if it exists) to see what has been done.
2. Pick the FIRST unchecked task (`- [ ]`). Do only that task.
3. Implement it.
4. Write new unit tests that cover the behavior you added or changed. Assert actual
   values (not just types or shapes), and include edge cases and error cases. If the
   task fixes a bug, add a test that would have failed before your fix.
5. Run `yarn jest`, `yarn expo lint` and `yarn tsc --noEmit`, and make sure all three
   pass, including your new tests. This project uses Yarn 4: never run npm or npx.
6. Only if all three pass, change that task's `- [ ]` to `- [x]` in tasks.md.
7. Append a one-line summary of what you did (including which tests you added) to progress.md.

Do not work on more than one task. Do not run git commit; the script handles commits.
