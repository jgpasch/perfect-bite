// Writes docs/i18n/es-review.csv (key, English, Spanish, notes) from src/i18n/ for the native
// speaker's review of the Spanish (spec 4.15). Run it after changing en.ts or es.ts:
//
//   yarn i18n:export
import { en } from '../src/i18n/en.ts';
import { es } from '../src/i18n/es.ts';
import { reviewCsv, reviewRows } from '../src/i18n/review-export.ts';

const path = 'docs/i18n/es-review.csv';
const rows = reviewRows(en, es);
await Deno.mkdir('docs/i18n', { recursive: true });
await Deno.writeTextFile(path, reviewCsv(rows));
console.log(`Wrote ${rows.length} strings to ${path}`);
