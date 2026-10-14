# Feature discovery: later

<!-- Status: ideas, not tasks yet. -->

Siri (4.9) and the share sheet (4.10) live outside the app, so nobody stumbles on them. Teach them with small in-context tips at the moment the user is doing it the slow way, not an onboarding carousel (skipped on first launch, before the user has the need). Needs a spec section (4.11 Feature discovery?) before these become tasks.

- **Tip rules.** At most one tip on screen at a time. Every tip is dismissable and never comes back once dismissed. A tip retires for good once its feature is used: a share envelope imported retires the Safari tip, a Siri contribution retires the Siri tip. Seen/dismissed/used state lives in per-user settings so it syncs across the user's devices.
- **Tip card component.** Built in JS with DESIGN.md tokens rather than wrapping SwiftUI `TipKit`/`SiriTipView` (iOS-only, SwiftUI, needs a native module). Title, one line, optional illustration, close button.
- **Safari tip after an in-app link import.** When a user pastes a URL into the in-app import and it succeeds: "Next time, skip the copy-paste: in Safari tap Share → The Perfect Bite." With a small two-step share sheet illustration.
- **Recipes empty state.** A "Save recipes from Safari" card with the same illustration, plus the in-app link import as the fallback.
- **"Can't find it?" help.** A new share extension often isn't in the share sheet's app row; the user has to scroll to More and turn it on. Say so in the Safari tip and the empty state, since this is why people think the feature doesn't exist.
- **Siri tip after a few typed adds.** After N manual adds (3?), with no Siri contribution yet: "Adding from the kitchen? Say 'Hey Siri, add to The Perfect Bite.'"
- **Explain Siri in Edit list.** One line under the "Default list for Siri" switch saying what Siri does, since the switch is meaningless if you don't know Siri works.
- **Ways to add page in Settings.** A permanent reference: typing, Siri (with the phrase and naming a list), Safari share, in-app link import.
