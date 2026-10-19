# Design mockups

Mockups the spec and `tasks.md` point to. `.html` files open in a browser. `.dc.html` files are boards exported from claude.ai design canvases: they don't render on their own, so read them as markup. Layout and sizes are in the inline styles, and the sample data (recipes, steps, week) is in the `renderVals()` script at the bottom. Colours and fonts in a mockup are approximate: the tokens in `src/constants/theme.ts` and DESIGN.md win, and the task's text wins over the mockup where they differ.

| Folder | Canvas | Chosen |
|---|---|---|
| `cook-mode/` | [Cook Mode Mockups](https://claude.ai/artifact/PpQqKt8h6CNXecv3eU1XBb) | B, steps with their ingredients |
| `plan-grid/` | [Plan Grid Cards](https://claude.ai/artifact/F13fT2y9nhi4MViFav19Zu) | `today-compact` (reference), A, and B + D (both as a trial setting) |
| `fonts/` | [Font Pairings](https://claude.ai/artifact/L1V1fg1oN9dzuzVMb5ziot) | all five, as a trial setting |
| `item-requests/` | [Who added it & photo requests](https://claude.ai/artifact/YDjSWr3wp7Wtf3PZad79j2) | all: A–B who added it (`tasks.md`), C–G asking for a photo (`tasks.md`) |
| `recipe-actions/` | [Recipe bottom bar](https://claude.ai/artifact/3xPqvetLja9BnuApNweWWT) | A, the action dock, and the adding state (B here, which applies to it) |
| `recipe-grouping/` | [Recipes views](https://claude.ai/artifact/P6TiVYgxVyZaWv2JugAa2q) | 1, group by any facet: the Sort and group menu (A) and grouped by cuisine (B). Saved views, shelves and collections (boards 2–4) are only on the canvas, not taken up yet |
| `step-sections/` | [Step Sections](https://claude.ai/artifact/Q3doqmcDNtijg8oCatgxhV) | all: A the Method card, B and C cook mode (pick a method, then the picked one), D the Steps sheet |
| `recipes-header/` | [Recipes header](https://claude.ai/artifact/JAJoAhdg7wmS53ekFMBLyf) | B, the title switcher (A here), with shelves (B) and with filters on (C). Options A, C and D are only on the canvas |
| `photo-import-pages/` | [Photo import original pages](https://claude.ai/artifact/4zquQ79qXPSyb5xzBCgCjU) | all: See original pages in the recipe's ⋯ menu (A), the pages full screen (B), the Method card's credit (C) and the import sheet's note (D) |
