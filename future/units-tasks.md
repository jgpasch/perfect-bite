# Units: US or metric

<!-- Status: ready. Spec: 4.2, 11.4. -->

The app is for US shoppers, so the catalog's units are a US supermarket's (spec 4.15). Households that shop in metric (Mexico, most of the world) can choose metric instead.

## Household unit system

- [ ] Household unit system (spec 4.2). Settings → household → **Units**: **US** (the default) or **Metric**, stored on the household (a migration adds the column; the user pushes it) so every member gets the same. It only decides the starting unit of an ingredient the household has no unit history for: Metric maps the catalog's `default_unit` through a fixed table (`lb` → `kg`, `oz` → `g`, `gal`, `qt` and `pt` → `l`, `fl oz` → `ml`; `count`, `cup`, `tbsp`, `tsp`, `can`, `jar`, `bag`, `box`, `bunch`, `dozen` and the rest unchanged). The household's own history still wins once it has one, and nothing already on a list changes. The mapping is a tested helper next to the usual-unit code; component tests for the setting and for an add with no history in each system. Strings in `src/i18n/` (English and Spanish). Update spec 4.2 and remove the line from 11.4.
