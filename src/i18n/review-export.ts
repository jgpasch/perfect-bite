/**
 * The Spanish review sheet (spec 4.15: a native speaker reviews every string before Spanish is
 * switched on). `yarn i18n:export` writes it to `docs/i18n/es-review.csv`.
 */

type StringTree = { readonly [key: string]: string | StringTree };

export type ReviewRow = { key: string; english: string; spanish: string; notes: string };

/**
 * Spanish shortened to fit a layout that can't wrap, so the reviewer keeps any change as short.
 * Keyed by the dotted key.
 */
export const LAYOUT_NOTES: Readonly<Record<string, string>> = {
  'lists.viewModes.newest':
    'Shortened from "Como se agregaron": it also shows in the one-line header subtitle while adding ("8 por comprar · Recientes"). Keep it short.',
  'addBar.alreadyOnList':
    'Shortened from "ya está en la lista": it replaces the amount at the right of a list row while typing. Keep it short.',
};

/** Every leaf of a string tree as `[dotted key, string]`, in the tree's order. */
export function flattenStrings(tree: StringTree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]): [string, string][] => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[path, value]] : flattenStrings(value, path);
  });
}

function pluralNote(key: string): string {
  if (key.endsWith('_one')) return 'Plural form for a count of 1.';
  if (key.endsWith('_other')) return 'Plural form for every other count.';
  return '';
}

/**
 * One row per English key, in `en.ts`'s order, with the Spanish beside it. Notes say which plural
 * form a key is and why a string was shortened. A key Spanish lacks has an empty Spanish cell
 * (the typecheck already stops that happening).
 */
export function reviewRows(en: StringTree, es: StringTree): ReviewRow[] {
  const spanish = new Map(flattenStrings(es));
  return flattenStrings(en).map(([key, english]) => ({
    key,
    english,
    spanish: spanish.get(key) ?? '',
    notes: [pluralNote(key), LAYOUT_NOTES[key] ?? ''].filter(Boolean).join(' '),
  }));
}

/** One CSV field (RFC 4180): quoted, with quotes doubled, when it holds a comma, quote or line break. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The sheet as CSV: a header row, then the rows, CRLF line ends. It starts with a UTF-8 byte order
 * mark so Excel reads the accents right; Numbers and Google Sheets ignore it.
 */
export function reviewCsv(rows: readonly ReviewRow[]): string {
  const lines = [['key', 'English', 'Spanish', 'notes'], ...rows.map((r) => [r.key, r.english, r.spanish, r.notes])];
  return `﻿${lines.map((fields) => fields.map(csvField).join(',')).join('\r\n')}\r\n`;
}
