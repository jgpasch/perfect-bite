# Siri: later

<!-- Status: ideas, not tasks yet. -->

- **Siri straight to the server.** Let the intent extension upload with the scoped device token (`docs/spikes.md` §2 option C) to a `siri-add` Edge Function, so a Siri add reaches the household without the phone's app opening. Needs M5 sync. Spec 4.9 already describes `siri-add`.
- **Multi-item adds** (spec 11.3). "Milk, eggs, and a bag of limes" becomes three items. Splitting on "and" naively breaks items like "mac and cheese", so `siri-add` would ask the LLM to split and parse when the text contains a list separator. Offline, the text stays one item until the server can split it. Needs the item above.
