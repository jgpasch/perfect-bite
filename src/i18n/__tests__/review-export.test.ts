// The Spanish review sheet that `yarn i18n:export` writes (spec 4.15).
import { describe, expect, it } from '@jest/globals';

import { en } from '../en';
import { es } from '../es';
import { csvField, flattenStrings, LAYOUT_NOTES, reviewCsv, reviewRows } from '../review-export';

describe('flattenStrings', () => {
  it('gives every leaf its dotted key, in order', () => {
    expect(flattenStrings({ a: 'A', b: { c: 'C', d: { e: 'E' } }, f: 'F' })).toEqual([
      ['a', 'A'],
      ['b.c', 'C'],
      ['b.d.e', 'E'],
      ['f', 'F'],
    ]);
  });

  it('gives nothing for an empty tree or group', () => {
    expect(flattenStrings({})).toEqual([]);
    expect(flattenStrings({ a: {} })).toEqual([]);
  });
});

describe('reviewRows', () => {
  it('pairs each English string with its Spanish, noting plural forms', () => {
    const rows = reviewRows(
      { lists: { title: 'Lists', items_one: '{{count}} item', items_other: '{{count}} items' } },
      { lists: { title: 'Listas', items_one: '{{count}} artículo', items_other: '{{count}} artículos' } },
    );
    expect(rows).toEqual([
      { key: 'lists.title', english: 'Lists', spanish: 'Listas', notes: '' },
      { key: 'lists.items_one', english: '{{count}} item', spanish: '{{count}} artículo', notes: 'Plural form for a count of 1.' },
      {
        key: 'lists.items_other',
        english: '{{count}} items',
        spanish: '{{count}} artículos',
        notes: 'Plural form for every other count.',
      },
    ]);
  });

  it('follows the English order and leaves a missing Spanish string empty', () => {
    const rows = reviewRows({ b: 'B', a: 'A' }, { a: 'Á', extra: 'X' });
    expect(rows.map((r) => [r.key, r.spanish])).toEqual([
      ['b', ''],
      ['a', 'Á'],
    ]);
  });

  it('covers every key of the real strings, with the Spanish shortened for layout noted', () => {
    const rows = reviewRows(en, es);
    expect(rows).toHaveLength(flattenStrings(en).length);
    expect(rows.every((r) => r.spanish !== '')).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);

    const newest = rows.find((r) => r.key === 'lists.viewModes.newest');
    expect(newest).toEqual({
      key: 'lists.viewModes.newest',
      english: 'As added',
      spanish: 'Recientes',
      notes: LAYOUT_NOTES['lists.viewModes.newest'],
    });
    const onList = rows.find((r) => r.key === 'addBar.alreadyOnList');
    expect([onList?.english, onList?.spanish]).toEqual(['already on list', 'en la lista']);
    expect(onList?.notes).toMatch(/^Shortened from "ya está en la lista"/);
    // Every layout note names a real key.
    expect(Object.keys(LAYOUT_NOTES).every((key) => rows.some((r) => r.key === key))).toBe(true);
  });
});

describe('csvField', () => {
  it('leaves plain text, accents and interpolations as they are', () => {
    expect(csvField('Se quitó {{name}}')).toBe('Se quitó {{name}}');
    expect(csvField('')).toBe('');
  });

  it('quotes a comma, a quote or a line break, doubling quotes', () => {
    expect(csvField('{{name}}, cambiar de lista')).toBe('"{{name}}, cambiar de lista"');
    expect(csvField('¿Eliminar "{{name}}"?')).toBe('"¿Eliminar ""{{name}}""?"');
    expect(csvField('one\ntwo')).toBe('"one\ntwo"');
    expect(csvField('one\r\ntwo')).toBe('"one\r\ntwo"');
  });
});

describe('reviewCsv', () => {
  it('writes a BOM, the header and one CRLF line per row', () => {
    const csv = reviewCsv([
      { key: 'common.undo', english: 'Undo', spanish: 'Deshacer', notes: '' },
      { key: 'lists.switch', english: '{{name}}, switch list', spanish: '{{name}}, cambiar de lista', notes: 'Say "lista"' },
    ]);
    expect(csv).toBe(
      '﻿key,English,Spanish,notes\r\n' +
        'common.undo,Undo,Deshacer,\r\n' +
        'lists.switch,"{{name}}, switch list","{{name}}, cambiar de lista","Say ""lista"""\r\n',
    );
  });

  it('with no rows, is just the header', () => {
    expect(reviewCsv([])).toBe('﻿key,English,Spanish,notes\r\n');
  });
});
