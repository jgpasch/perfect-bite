// Spec 4.15: the lists strings come from src/i18n/, with each language's plural rules. English is checked
// by the existing list tests; these check the Spanish, the plurals and the module-level strings.
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { sectionHeaderLabel, toastAnnouncement } from '@/components/appearance';
import { LIST_HUES, listColorName } from '@/domain/aisle-color';
import { i18n, initI18n, onLanguageChanged, withManyPlurals } from '@/i18n';
import {
  addedToast,
  alsoInHint,
  checkedAllToast,
  checkedHeaderLabel,
  checkOffLabel,
  clearCheckedLabel,
  clearedToast,
  compactHeaderSubtitle,
  deletedToast,
  fromRecipesHint,
  householdHeaderLabel,
  LIST_VIEW_MODES,
  listRowAccessibilityLabel,
  listRowCount,
  movedToast,
  removedRecipeToast,
  siriAddedToast,
  SORTING_LABEL,
  switcherAccessibilityLabel,
  toGetLabel,
  toggleActionLabel,
  uncheckedAllToast,
  VIEW_BUTTON_HINT,
  viewButtonAccessibilityLabel,
  viewModeLabel,
} from '@/features/lists/list-view';
import { listShareText } from '@/features/lists/share';

jest.mock('@/global.css', () => ({}));

afterEach(() => initI18n('en'));

describe('lists strings in English', () => {
  it('uses one and other plurals', () => {
    expect(clearedToast(0).message).toBe('Cleared 0 items');
    expect(clearedToast(1).message).toBe('Cleared 1 item');
    expect(clearedToast(1000000).message).toBe('Cleared 1000000 items');
    expect(checkedHeaderLabel(1)).toBe('Checked, 1 item');
    expect(checkedHeaderLabel(4)).toBe('Checked, 4 items');
  });

  it('keeps a name with i18next syntax in it as typed', () => {
    expect(deletedToast('{{count}} $t(common.undo)').message).toBe('Deleted {{count}} $t(common.undo)');
    expect(switcherAccessibilityLabel('$t(common.done)', 0)).toBe('$t(common.done), switch list');
    expect(listShareText('{{name}}', [{ displayName: '{{item}}', amountText: '', note: '$t(common.edit)' }])).toBe(
      '{{name}}\n- {{item}} ($t(common.edit))',
    );
  });
});

describe('lists strings in Spanish', () => {
  it('reads the toasts with Spanish plurals', () => {
    initI18n('es');
    expect(clearedToast(1).message).toBe('Se borró 1 artículo');
    expect(clearedToast(3).message).toBe('Se borraron 3 artículos');
    expect(clearedToast(0).message).toBe('Se borraron 0 artículos');
    expect(checkedAllToast(1).message).toBe('Se marcó 1 artículo');
    expect(checkedAllToast(2).message).toBe('Se marcaron 2 artículos');
    expect(uncheckedAllToast(6).message).toBe('Se desmarcaron 6 artículos');
    expect(siriAddedToast(1).message).toBe('Siri agregó 1 artículo');
    expect(siriAddedToast(2).message).toBe('Siri agregó 2 artículos');
  });

  it('uses the other form for a million, not English', () => {
    initI18n('es');
    expect(new Intl.PluralRules('es').select(1000000)).toBe('many');
    expect(clearedToast(1000000).message).toBe('Se borraron 1000000 artículos');
  });

  it('fills names into the item toasts, bolding the display name', () => {
    initI18n('es');
    expect(addedToast('leche', '2 gal')).toEqual({ message: 'Se agregó a Leche, ahora 2 gal', emphasis: 'Leche' });
    expect(addedToast('leche', null)).toEqual({ message: 'Se agregó a Leche', emphasis: 'Leche' });
    expect(movedToast({ kind: 'new', name: 'leche', fromListName: 'Súper' })).toEqual({
      message: 'Se movió Leche de Súper',
      emphasis: 'Leche',
    });
    expect(movedToast({ kind: 'reopen', name: 'leche', fromListName: '' }).message).toBe('Se movió Leche');
    expect(movedToast({ kind: 'combine', name: 'leche', totalAmountText: '3 l', fromListName: 'Súper' }).message).toBe(
      'Se agregó a Leche, ahora 3 l',
    );
    expect(deletedToast('aguacate')).toEqual({ message: 'Se eliminó Aguacate', emphasis: 'Aguacate' });
    expect(removedRecipeToast('Tacos')).toEqual({ message: 'Se quitó Tacos de la lista', emphasis: 'Tacos' });
  });

  it('reads the list header, view modes and sections', () => {
    initI18n('es');
    expect(toGetLabel(8)).toBe('8 por comprar');
    expect(toGetLabel(0, 2)).toBe('Todo listo');
    expect(toGetLabel(0)).toBeNull();
    expect(LIST_VIEW_MODES.map((m) => m.label)).toEqual(['Recientes', 'Por pasillo', 'Por receta']);
    expect(compactHeaderSubtitle(8, 'newest')).toBe('8 por comprar · Recientes');
    expect(viewModeLabel('category')).toBe('Por pasillo');
    expect(viewButtonAccessibilityLabel('recipe')).toBe('Vista: Por receta');
    expect(compactHeaderSubtitle(8, 'category')).toBe('8 por comprar · Por pasillo');
    expect(alsoInHint(['Tacos', 'Pozole'])).toBe('También en Tacos, Pozole');
    expect(fromRecipesHint([{ recipeId: 'r1', recipeName: 'Tacos' }])).toBe('De Tacos');
    expect(switcherAccessibilityLabel('Súper', 0)).toBe('Súper, cambiar de lista');
    expect(switcherAccessibilityLabel('Súper', 1)).toBe('Súper, cambiar de lista, 1 invitación pendiente');
    expect(switcherAccessibilityLabel('Súper', 2)).toBe('Súper, cambiar de lista, 2 invitaciones pendientes');
  });

  it('reads the item row and Checked section for VoiceOver', () => {
    initI18n('es');
    expect(checkOffLabel('Limones')).toBe('Marcar Limones');
    expect(toggleActionLabel(false)).toBe('Marcar');
    expect(toggleActionLabel(true)).toBe('Desmarcar');
    expect(checkedHeaderLabel(1)).toBe('Marcados, 1 artículo');
    expect(clearCheckedLabel(1)).toBe('Borrar 1 artículo marcado');
    expect(clearCheckedLabel(3)).toBe('Borrar 3 artículos marcados');
  });

  it('reads the Your lists sheet', () => {
    initI18n('es');
    expect(listRowCount(0)).toBe('Listo');
    expect(listRowCount(4)).toBe('4');
    expect(listRowAccessibilityLabel('Súper', 1, { isDefault: true, current: true })).toBe(
      'Súper, 1 artículo por comprar, lista de Siri, actual',
    );
    expect(listRowAccessibilityLabel('Fiesta', 0, { archived: true })).toBe('Fiesta, todo listo, archivada');
    expect(householdHeaderLabel('Casa', 1)).toBe('Casa, 1 miembro');
    expect(householdHeaderLabel('Casa', 3)).toBe('Casa, 3 miembros');
    expect(householdHeaderLabel('Casa')).toBe('Casa');
  });

  it('names the list colours', () => {
    initI18n('es');
    expect([null, ...LIST_HUES].map(listColorName)).toEqual(['Predeterminado', 'Verde', 'Azul', 'Rosa', 'Ámbar', 'Gris']);
  });

  it('shares the list with the same layout', () => {
    initI18n('es');
    expect(
      listShareText('Súper', [
        { displayName: 'leche', amountText: '2 l', note: 'deslactosada' },
        { displayName: 'limones', amountText: '', note: null },
      ]),
    ).toBe('Súper\n- 2 l Leche (deslactosada)\n- Limones');
  });

  it('reads section headers and toast announcements', () => {
    initI18n('es');
    expect(sectionHeaderLabel('Frutas', 1)).toBe('Frutas, 1 artículo');
    expect(sectionHeaderLabel('Frutas', 3)).toBe('Frutas, 3 artículos');
    expect(sectionHeaderLabel('Frutas')).toBe('Frutas');
    // A caller's own unit is left as it is.
    expect(sectionHeaderLabel('Method', 2, ['step', 'steps'])).toBe('Method, 2 steps');
    expect(toastAnnouncement('Se borraron 3 artículos', ['Deshacer'])).toBe('Se borraron 3 artículos. Disponible: Deshacer.');
    expect(toastAnnouncement('Se movió Leche', [])).toBe('Se movió Leche');
  });

  it('switches the module-level strings with the language, and back', () => {
    expect(SORTING_LABEL).toBe('Sorting…');
    initI18n('es');
    // Read through the module, as the screens do (live bindings).
    const listView = jest.requireActual<typeof import('@/features/lists/list-view')>('@/features/lists/list-view');
    expect(listView.SORTING_LABEL).toBe('Clasificando…');
    expect(listView.VIEW_BUTTON_HINT).toBe('Cambia cómo se agrupa la lista');
    initI18n('en');
    expect(listView.SORTING_LABEL).toBe('Sorting…');
    expect(VIEW_BUTTON_HINT).toBe('Changes how the list is grouped');
  });
});

describe('onLanguageChanged', () => {
  it('runs now and on every change', () => {
    const seen: string[] = [];
    onLanguageChanged(() => seen.push(i18n.language));
    initI18n('es');
    initI18n('en');
    expect(seen).toEqual(['en', 'es', 'en']);
  });
});

describe('withManyPlurals', () => {
  it('copies each _other plural to _many, at any depth', () => {
    expect(withManyPlurals({ a: { n_one: '1', n_other: 'n' }, b_other: 'b', c: 'c' })).toEqual({
      a: { n_one: '1', n_other: 'n', n_many: 'n' },
      b_other: 'b',
      b_many: 'b',
      c: 'c',
    });
  });

  it('keeps a _many that is already there', () => {
    expect(withManyPlurals({ n_other: 'n', n_many: 'm' })).toEqual({ n_other: 'n', n_many: 'm' });
  });

  it('leaves strings without plurals alone', () => {
    expect(withManyPlurals({ other: 'x', a_others: 'y' })).toEqual({ other: 'x', a_others: 'y' });
  });
});
