# Manual checks

Checks Ralph sessions can't do (simulator taps, VoiceOver, devices). Tick them by hand.

- [ ] Tap the name to open, tap the check to check: in the simulator, tapping a name never checks it, tapping the circle never opens the sheet, and scrolling with a finger on a row does neither. Do a VoiceOver pass too (check is "Check off <name>", body has "Opens details" and the Check off / Uncheck action).
- [ ] Launch into the last list: in the simulator, open a list, kill and relaunch; it opens on that list with no flash of the home screen and the add bar not focused. Back shows "Your lists". Background and foreground the app on another screen; it stays there. Delete that list, relaunch; it opens the default list.
