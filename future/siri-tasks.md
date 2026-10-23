# Siri: later

<!-- Status: ideas, not tasks yet. -->

- **Siri straight to the server.** Let the intent extension upload to a `siri-add` Edge Function, so a Siri add reaches the household without the phone's app opening. It reuses what "Share import on the server" in `tasks.md` builds (`docs/share-server-import-plan.md`): the device credential (add a `siri.add` scope), the shared Keychain group, and the shared `planListAdds` committed through `private.apply_mutation` under the per-list lock, with a receipt so a retry adds nothing. Spec 4.9 already describes `siri-add`.
- **Multi-item adds** (spec 11.3). "Milk, eggs, and a bag of limes" becomes three items. Splitting on "and" naively breaks items like "mac and cheese", so `siri-add` would ask the LLM to split and parse when the text contains a list separator. Offline, the text stays one item until the server can split it. Needs the item above.
