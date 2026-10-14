// Spec 4.15: the add bar, item sheet and Aisle order strings come from src/i18n/. English is checked by
// the existing tests; these check the Spanish, the plurals and the module-level strings.
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { addBarButton } from '@/components/appearance';
import { addedByLabel, addedLine, addedWhen, checkedLine } from '@/domain/added-by';
import { sharedAisleFootnote } from '@/features/categories/aisle-copy';
import { aisleMovedAnnouncement, aisleRowActions, aisleRowLabel } from '@/features/categories/aisle-order';
import { alwaysHaveFootnote } from '@/features/households/staples';
import { LIST_ADD_LABEL, LIST_ADD_PLACEHOLDER } from '@/features/lists/add-bar-copy';
import { UNIT_GROUPS, unitLabel, unitMenuSections } from '@/features/lists/amount-stepper';
import { ALREADY_ON_LIST_LABEL } from '@/features/lists/list-view';
import { recipeSuggestionLabel } from '@/features/recipes/recipe-view';
import { i18n, initI18n } from '@/i18n';

jest.mock('@/global.css', () => ({}));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

afterEach(() => initI18n('en'));

const ME = 'user-1';
// A Friday afternoon, local time.
const NOW = new Date(2026, 9, 9, 15, 30);

describe('item strings in English', () => {
  it('announces an aisle move by its new place', () => {
    expect(aisleMovedAnnouncement(0, 20)).toBe('Moved to 1 of 20');
    expect(aisleMovedAnnouncement(19, 20)).toBe('Moved to 20 of 20');
  });

  it('says how many more aisles Show all shows, with real plurals', () => {
    expect(i18n.t('item.showMore', { count: 1 })).toBe('Shows 1 more aisle');
    expect(i18n.t('item.showMore', { count: 14 })).toBe('Shows 14 more aisles');
  });

  it('keeps names with i18next syntax in them as typed', () => {
    const recipe = { source: 'recipe' as const, addedBy: ME, recipeName: '{{who}} $t(common.undo)' };
    expect(addedLine({ ...recipe, createdAt: NOW }, ME, NOW)).toBe('{{who}} $t(common.undo), just now');
    expect(sharedAisleFootnote('{{name}}')).toBe('Changes it for everyone in {{name}}.');
    expect(aisleRowLabel('$t(common.done)', 0, 2, '{{household}}')).toBe('$t(common.done), {{household}}, 1 of 2');
  });
});

describe('item strings in Spanish', () => {
  it('says who added an amount', () => {
    initI18n('es');
    expect(addedByLabel({ source: 'siri', addedBy: ME, recipeName: null }, ME)).toBe('Siri');
    expect(addedByLabel({ source: 'recipe', addedBy: ME, recipeName: null }, ME)).toBe('Una receta');
    expect(addedByLabel({ source: 'recipe', addedBy: ME, recipeName: ' Pozole ' }, ME)).toBe('Pozole');
    expect(addedByLabel({ source: 'manual', addedBy: ME, recipeName: null }, ME)).toBe('Tú');
    expect(addedByLabel({ source: 'manual', addedBy: null, recipeName: null }, ME)).toBe('Alguien más');
  });

  it('says when, relative to now', () => {
    initI18n('es');
    expect(addedWhen(NOW, NOW)).toBe('justo ahora');
    expect(addedWhen(new Date(NOW.getTime() + 5 * 60_000), NOW)).toBe('justo ahora');
    expect(addedWhen(new Date(NOW.getTime() - 60_000), NOW)).toBe('hace 1 min');
    expect(addedWhen(new Date(NOW.getTime() - 59 * 60_000), NOW)).toBe('hace 59 min');
    expect(addedWhen(new Date(2026, 9, 9, 8, 0), NOW)).toBe('hoy');
    expect(addedWhen(new Date(2026, 9, 8, 23, 59), NOW)).toBe('ayer');
  });

  it('puts who and when together, and says who checked it', () => {
    initI18n('es');
    expect(addedLine({ source: 'manual', addedBy: ME, recipeName: null, createdAt: NOW }, ME, NOW)).toBe('Tú, justo ahora');
    const fiveAgo = new Date(NOW.getTime() - 5 * 60_000);
    expect(checkedLine(fiveAgo, ME, ME, NOW)).toBe('Marcado hace 5 min por ti');
    expect(checkedLine(fiveAgo, 'user-2', ME, NOW)).toBe('Marcado hace 5 min por alguien más');
    expect(checkedLine(fiveAgo, null, ME, NOW)).toBe('Marcado hace 5 min');
  });

  it('names the household in the shared footnotes, or says tu hogar', () => {
    initI18n('es');
    expect(sharedAisleFootnote(' Casa ')).toBe('Lo cambia para todos en Casa.');
    expect(sharedAisleFootnote(null)).toBe('Lo cambia para todos en tu hogar.');
    expect(sharedAisleFootnote('  ')).toBe('Lo cambia para todos en tu hogar.');
    expect(alwaysHaveFootnote('Casa')).toBe('Se omite cuando agregas una receta. Lo cambia para todos en Casa.');
    expect(alwaysHaveFootnote('')).toBe('Se omite cuando agregas una receta. Lo cambia para todos en tu hogar.');
  });

  it('titles the unit menu groups, following a language change', () => {
    initI18n('es');
    expect(UNIT_GROUPS.map((g) => g.title)).toEqual(['Piezas', 'Peso', 'Volumen', 'Paquetes']);
    expect(unitLabel(null)).toBe('Piezas');
    // Unit abbreviations stay as they are.
    expect(unitLabel('kg')).toBe('kg');
    expect(unitMenuSections('lb', 'lb').map((s) => s.title)).toEqual([null, 'Piezas', 'Peso', 'Volumen', 'Paquetes']);
    expect(unitMenuSections(null, undefined)[0].items[0]).toEqual({
      unit: null,
      label: 'Piezas',
      checked: true,
      usual: false,
    });
    initI18n('en');
    expect(UNIT_GROUPS.map((g) => g.title)).toEqual(['Count', 'Weight', 'Volume', 'Packages']);
  });

  it('reads the aisle rows, their actions and moves', () => {
    initI18n('es');
    expect(aisleRowLabel('Frutas y verduras', 0, 20)).toBe('Frutas y verduras, 1 de 20');
    expect(aisleRowLabel('Costco', 2, 20, 'Casa')).toBe('Costco, Casa, 3 de 20');
    expect(aisleRowLabel('Costco', 2, 20, null)).toBe('Costco, 3 de 20');
    expect(aisleRowActions(0, 3)).toEqual([{ name: 'moveDown', label: 'Bajar' }]);
    expect(aisleRowActions(2, 3)).toEqual([{ name: 'moveUp', label: 'Subir' }]);
    expect(aisleRowActions(0, 1)).toEqual([]);
    expect(aisleMovedAnnouncement(2, 20)).toBe('Movido a 3 de 20');
  });

  it('reads a recipe chip with Spanish plurals, a million included', () => {
    initI18n('es');
    expect(recipeSuggestionLabel('Tacos', 1)).toBe('Agregar receta Tacos, 1 artículo');
    expect(recipeSuggestionLabel('Tacos', 8)).toBe('Agregar receta Tacos, 8 artículos');
    expect(recipeSuggestionLabel('Tacos', 0)).toBe('Agregar receta Tacos, 0 artículos');
    expect(recipeSuggestionLabel('Tacos', 1000000)).toBe('Agregar receta Tacos, 1000000 artículos');
  });

  it('says how many more aisles Show all shows', () => {
    initI18n('es');
    expect(i18n.t('item.showMore', { count: 1 })).toBe('Muestra 1 pasillo más');
    expect(i18n.t('item.showMore', { count: 14 })).toBe('Muestra 14 pasillos más');
  });

  it('keeps the module-level add bar strings in the app’s language', () => {
    expect([LIST_ADD_PLACEHOLDER, LIST_ADD_LABEL, ALREADY_ON_LIST_LABEL, addBarButton('').label]).toEqual([
      'Add an item',
      'Add an item',
      'already on list',
      'Add',
    ]);
    initI18n('es');
    expect([LIST_ADD_PLACEHOLDER, LIST_ADD_LABEL, ALREADY_ON_LIST_LABEL, addBarButton('x').label]).toEqual([
      'Agrega un artículo',
      'Agregar un artículo',
      'ya está en la lista',
      'Agregar',
    ]);
    initI18n('en');
    expect(LIST_ADD_PLACEHOLDER).toBe('Add an item');
    expect(ALREADY_ON_LIST_LABEL).toBe('already on list');
  });
});
