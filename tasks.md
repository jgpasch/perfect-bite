# Tasks

<!-- One task per line as "- [ ] description". Ralph works top to bottom, one per iteration. -->

Manual checks (simulators, two signed-in users, real devices) never block a task. If you can't do one, finish the rest of the task, mark it done, and end that task's progress.md entry with "NEEDS A MANUAL CHECK:" and the exact steps for a person to run.

## One tap out closes the add bar

Goal: the two-step tap-out on a list's add bar (first tap drops the keyboard, second hides the bar and keeps the text) feels like a stuck bar. Make it one step: the first tap outside the field hides the keyboard and the bar together and throws the typed text away, the same as losing focus with the field empty does today.

- [x] One tap out closes the add bar and clears it (spec 4.1, 4.2). In `src/features/lists/list-screen.tsx`, while the add field is focused with text in it, a tap outside the bar (the list's empty space below or between the rows, the header, the compact title) now hides the keyboard and the bar at once and clears `addText` (and its chips), so + (and `openAdd`) next opens an empty, focused bar. A tap on a row, chip or control does what it does now. With the field empty, losing focus still hides the bar at once, as now. Select mode still swaps the bar out and clears the text, as now. Submitting from the keyboard still adds and keeps the bar open, as now. The second-tap machinery goes: `addTucked`, `tapOutHidesBar` and the `onStartShouldSetResponder` that uses it, and `showAddBar` no longer stays up just because `addText !== ''`; update the comments above them. Jest (`src/features/lists/__tests__/list-screen.test.tsx`): type text, tap out once, the bar is gone; + brings it back empty and focused; with an empty field, blur hides it straight away; replace the tests for the old two-step behavior. Update spec 4.1 (the tab bar's + bullet) and 4.2 (Add mode) where they describe the first tap out keeping the bar and its text and a second tap out hiding it.
