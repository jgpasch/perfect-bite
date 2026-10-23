// Spec 4.15: the recipes strings come from src/i18n/. English is checked by the existing recipe tests; these
// check the Spanish, the plurals, the module-level strings and a few components rendered in Spanish.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NAME_IS_LINK_FOOTNOTE } from '@/features/recipes/add-recipe';
import { recipeServesLabel } from '@/features/recipes/add-to-list';
import { failedImportReason } from '@/features/recipes/failed-imports';
import { favoriteLabel } from '@/features/recipes/favorites';
import {
  importedOnRecipesToast,
  importErrorMessage,
  NOT_ENTITLED_MESSAGE,
  savedRecipeToast,
  sharedImportsToast,
} from '@/features/recipes/import-sheet';
import { quickAddTitle } from '@/features/recipes/quick-add';
import { RecipeFilterBar } from '@/features/recipes/recipe-filter-bar';
import {
  availableFilterFacets,
  filtersPillAccessibilityLabel,
  filtersPillLabel,
  noRecipeFilters,
  recipeFilterChips,
  showRecipesLabel,
  timeBucketLabel,
  untaggedFootnote,
  untaggedOnlyFilters,
} from '@/features/recipes/recipe-filters';
import { NO_RECIPES_MATCH, recipeSearchPlaceholder } from '@/features/recipes/recipe-search';
import { recipeSortMenuLabel } from '@/features/recipes/recipe-sort';
import { RecipeTagRow } from '@/features/recipes/recipe-tag-row';
import { facetLimitLabel, parseTotalTime, recipeTagLine, recipeTagPills } from '@/features/recipes/recipe-tags-view';
import {
  addCtaLabel,
  addedRecipeToListToast,
  addedRecipeWithStaplesToast,
  addedToRecipeToast,
  addToRecipeTitle,
  cookProgressLabel,
  forServingsLabel,
  ingredientCountLabel,
  methodTab,
  parseServings,
  recipeCardLabel,
  recipeMetaLine,
  recipeRowLabel,
  recipeSuggestionDetail,
  recipeTimeLabel,
  servesLabel,
  SERVINGS_ERROR,
  stepLabel,
  stepUnit,
} from '@/features/recipes/recipe-view';
import { NO_LISTS_IN_HOUSEHOLD, saveButtonTitle } from '@/features/recipes/save-choice';
import {
  importsCardHeading,
  queuedShareDetail,
  shareFailureReason,
  waitReasonText,
  type QueuedShare,
} from '@/features/recipes/share-queue-status';
import { NOTHING_SUGGESTED_NOTE, SUGGEST_TAGS_MESSAGES, SUGGESTED_NOTE, suggestTagsMessage } from '@/features/recipes/suggest-tags';
import { i18n, initI18n } from '@/i18n';
import { emptyRecipeTags } from '@/shared/recipe-tags';

jest.mock('@/global.css', () => ({}));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
// The tag row reads the favorites (`favorites.ts`), which ask who's signed in.
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));

afterEach(() => initI18n('en'));

function texts(root: ReactTestRenderer): string[] {
  return root.root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => [n.props.children].flat().filter((c: unknown) => typeof c === 'string').join(''));
}

function labels(root: ReactTestRenderer): string[] {
  return root.root
    .findAll((n) => typeof n.type === 'string' && typeof n.props.accessibilityLabel === 'string')
    .map((n) => n.props.accessibilityLabel as string);
}

function share(overrides: Partial<QueuedShare> = {}): QueuedShare {
  return { id: 's1', url: 'https://www.bonappetit.com/recipe/x', title: null, listName: null, onServer: false, ...overrides };
}

describe('recipes strings in English', () => {
  it('counts recipes, ingredients and steps with real plurals, zero included', () => {
    expect(recipeSearchPlaceholder(0)).toBe('Search 0 recipes');
    expect(recipeSearchPlaceholder(1)).toBe('Search 1 recipe');
    expect(ingredientCountLabel(0)).toBe('0 ingredients');
    expect(methodTab(1)).toEqual({ label: 'Method · 1', accessibilityLabel: 'Method, 1 step' });
    expect(stepUnit()).toEqual(['step', 'steps']);
    expect(cookProgressLabel(null, 1, 1)).toBe('1 of 1 step done');
    expect(untaggedFootnote(1)).toBe("1 recipe without tags isn't shown");
    expect(untaggedFootnote(2)).toBe("2 recipes without tags aren't shown");
  });

  it('names time buckets by key', () => {
    expect(timeBucketLabel('under-30')).toBe('Under 30 min');
    expect(timeBucketLabel('under-60')).toBe('Under 1 hour');
    expect(timeBucketLabel('over-60')).toBe('Over 1 hour');
  });

  it('keeps recipe and list names with i18next syntax in them as typed', () => {
    expect(addedRecipeWithStaplesToast('$t(common.undo)', 2, [], '{{name}}').message).toBe(
      'Added $t(common.undo) to {{name}} · 2 items',
    );
    expect(savedRecipeToast('{{name}}', true)).toEqual({ message: 'Saved {{name}}', emphasis: '{{name}}' });
    expect(stepLabel(0, 1, 'Mix {{count}} eggs')).toBe('Step 1 of 1, Mix {{count}} eggs');
  });

  it('switches the module-level strings with the language, and back', () => {
    expect(NO_RECIPES_MATCH).toBe('No recipes match');
    initI18n('es');
    expect(NO_RECIPES_MATCH).toBe('Ninguna receta coincide');
    initI18n('en');
    expect(NO_RECIPES_MATCH).toBe('No recipes match');
    expect(SERVINGS_ERROR).toBe('Servings must be a whole number from 1 to 100');
    expect(SUGGEST_TAGS_MESSAGES.failed).toBe("Couldn't suggest tags right now. Try again later.");
  });
});

describe('recipes strings in Spanish', () => {
  it('counts recipes in the search field, with real plurals', () => {
    initI18n('es');
    expect(recipeSearchPlaceholder(1)).toBe('Buscar en 1 receta');
    expect(recipeSearchPlaceholder(52)).toBe('Buscar en 52 recetas');
    // Spanish puts a million in the `many` category; it reads as the plural.
    expect(recipeSearchPlaceholder(1000000)).toBe('Buscar en 1000000 recetas');
    expect(NO_RECIPES_MATCH).toBe('Ninguna receta coincide');
  });

  it('labels the Filters pill, its chips and the sheet', () => {
    initI18n('es');
    expect(filtersPillLabel(0)).toBe('Filtros');
    expect(filtersPillLabel(2)).toBe('Filtros · 2');
    expect(filtersPillAccessibilityLabel(0)).toBe('Filtros');
    expect(filtersPillAccessibilityLabel(2)).toBe('Filtros, 2 activos');
    expect(showRecipesLabel(1)).toBe('Mostrar 1 receta');
    expect(showRecipesLabel(12)).toBe('Mostrar 12 recetas');
    expect(untaggedFootnote(1)).toBe('No se muestra 1 receta sin etiquetas');
    expect(untaggedFootnote(3)).toBe('No se muestran 3 recetas sin etiquetas');
    expect(recipeFilterChips(untaggedOnlyFilters())).toEqual([
      expect.objectContaining({ label: 'Sin etiquetas', accessibilityLabel: 'Quitar el filtro Sin etiquetas' }),
    ]);
    const timeChips = recipeFilterChips({ ...noRecipeFilters(), time: ['over-60', 'under-30'] });
    expect(timeChips.map((c) => c.label)).toEqual(['Menos de 30 min', 'Más de 1 hora']);
    expect(timeChips[1].accessibilityLabel).toBe('Quitar el filtro Más de 1 hora');
  });

  it('names the Time facet and its buckets in the sheet and the tag pills', () => {
    initI18n('es');
    const facets = availableFilterFacets([{ id: 'r1', tags: null, totalMinutes: 45 }], noRecipeFilters());
    expect(facets).toEqual([{ key: 'time', label: 'Tiempo', values: [{ slug: 'under-60', label: 'Menos de 1 hora' }] }]);
    expect(recipeTagPills(null, 20)).toEqual([
      { key: 'time:under-30', facet: 'Tiempo', value: 'Menos de 30 min', accessibilityLabel: 'Tiempo: Menos de 30 min' },
    ]);
    expect(recipeTagPills(emptyRecipeTags(), null)).toEqual([]);
  });

  it('says the Tags sheet limits and time errors', () => {
    initI18n('es');
    expect(facetLimitLabel(2)).toBe('Elige hasta 2');
    expect(parseTotalTime('1.5', '')).toEqual({ ok: false, error: 'Usa números enteros' });
    expect(parseTotalTime('49', '')).toEqual({ ok: false, error: 'Hasta 48 horas' });
    expect(parseTotalTime('', '')).toEqual({ ok: true, totalMinutes: null });
  });

  it('reads the one-line tags in Spanish', () => {
    initI18n('es');
    // An old stored `favorite` slug is unknown: not shown (4.14).
    expect(recipeTagLine({ ...emptyRecipeTags(), saved: ['favorite', 'want-to-try'], meal: ['dinner'] }, 90)).toEqual({
      favorite: null,
      text: 'Por probar · Cena · Más de 1 hora',
      accessibilityLabel: 'Etiquetas: Por probar, Cena, Más de 1 hora',
    });
    // A favorite reads first, as `favoriteLabel` gives it.
    expect(recipeTagLine(null, 90, { mine: false, label: favoriteLabel(false, ['Sam'])! })).toEqual({
      favorite: 'others',
      text: 'Más de 1 hora',
      accessibilityLabel: 'Etiquetas: Favorita de Sam, Más de 1 hora',
    });
  });

  it('says what Suggest tags found, or why it failed', () => {
    initI18n('es');
    expect(SUGGESTED_NOTE).toBe('Sugeridas por IA. Revísalas y luego toca Guardar.');
    expect(NOTHING_SUGGESTED_NOTE).toBe('Ninguna etiqueta le queda bien a esta receta.');
    expect(suggestTagsMessage('offline')).toBe('No tienes conexión. Inténtalo de nuevo cuando estés en línea.');
    expect(suggestTagsMessage('no-ingredients')).toBe('Primero agrega algunos ingredientes, para tener algo en qué basarse.');
    expect(suggestTagsMessage('not-entitled')).toBe('Las sugerencias de etiquetas no están incluidas en tu plan.');
    expect(suggestTagsMessage('rate-limited')).toBe('Son muchas sugerencias. Inténtalo de nuevo en un minuto.');
    expect(suggestTagsMessage('unavailable')).toBe('No se pudieron sugerir etiquetas ahorita. Inténtalo más tarde.');
    expect(suggestTagsMessage('failed')).toBe(suggestTagsMessage('unavailable'));
  });

  it('labels recipe cards and the quick add', () => {
    initI18n('es');
    expect(ingredientCountLabel(1)).toBe('1 ingrediente');
    expect(ingredientCountLabel(9)).toBe('9 ingredientes');
    expect(recipeCardLabel('Tacos', 9, 'Súper')).toBe('Tacos, 9 ingredientes, en Súper');
    expect(recipeCardLabel('Tacos', 9, null, 'pollo')).toBe('Tacos, lleva pollo');
    expect(quickAddTitle('Súper')).toBe('Agregar a Súper');
  });

  it('labels the Recipes tab rows and header: meal, time, the view title and the sort button', () => {
    initI18n('es');
    const tacos = { name: 'Tacos', tags: { ...emptyRecipeTags(), meal: ['dinner'] }, totalMinutes: 80 };
    expect(recipeTimeLabel(35)).toBe('35 min');
    expect(recipeTimeLabel(60)).toBe('1 h');
    expect(recipeMetaLine(tacos)).toBe('Cena · 1 h 20 min');
    expect(recipeRowLabel(tacos, 'Súper')).toBe('Tacos, Cena, 1 h 20 min, en Súper');
    expect(recipeRowLabel(tacos, null, 'pollo')).toBe('Tacos, lleva pollo');
    // An old stored `favorite` slug isn't read: favorites are per person now (4.14).
    const saved = { ...tacos, tags: { ...tacos.tags, saved: ['favorite', 'want-to-try'] } };
    expect(recipeRowLabel(saved, 'Súper')).toBe('Tacos, Por probar, Cena, 1 h 20 min, en Súper');
    expect(i18n.t('recipes.tab.switchView', { name: 'Recetas' })).toBe('Recetas, cambiar vista');
    expect(recipeSortMenuLabel('name', 'cuisine', 'small')).toBe('Ordenar: A–Z, agrupadas por cocina, fotos pequeñas');
    expect(recipeSortMenuLabel('recent', 'none', 'large')).toBe('Ordenar: Agregadas recientemente, fotos grandes');
  });

  it('says servings, and rejects ones out of range', () => {
    initI18n('es');
    expect(servesLabel(4)).toBe('Rinde 4');
    expect(forServingsLabel(6)).toBe('Para 6');
    expect(recipeServesLabel(4)).toBe('La receta rinde 4');
    expect(SERVINGS_ERROR).toBe('Las porciones deben ser un número entero de 1 a 100');
    expect(parseServings('0')).toEqual({ error: 'Las porciones deben ser un número entero de 1 a 100' });
    expect(parseServings('cuatro')).toEqual({ error: 'Las porciones deben ser un número entero de 1 a 100' });
    expect(parseServings(' 4 ')).toEqual({ servings: 4 });
  });

  it('labels steps, the Method tab and cooking progress', () => {
    initI18n('es');
    expect(stepLabel(1, 7, 'Dora el pollo')).toBe('Paso 2 de 7, Dora el pollo');
    expect(methodTab(1)).toEqual({ label: 'Preparación · 1', accessibilityLabel: 'Preparación, 1 paso' });
    expect(methodTab(6)).toEqual({ label: 'Preparación · 6', accessibilityLabel: 'Preparación, 6 pasos' });
    expect(stepUnit()).toEqual(['paso', 'pasos']);
    expect(cookProgressLabel(6, 2, 6)).toBe('Para 6 · 2 de 6 pasos listos');
    expect(cookProgressLabel(null, 0, 1)).toBe('0 de 1 paso listo');
  });

  it('says the add-to-list toasts and CTA, staples skipped included', () => {
    initI18n('es');
    expect(addCtaLabel(0, 'Súper')).toBe('Nada seleccionado');
    expect(addCtaLabel(8, 'Súper')).toBe('Agregar 8 a Súper');
    expect(recipeSuggestionDetail(1)).toBe('Receta · 1 artículo');
    expect(recipeSuggestionDetail(8)).toBe('Receta · 8 artículos');
    expect(addedRecipeToListToast('Pozole', 1)).toEqual({ message: 'Se agregó Pozole · 1 artículo', emphasis: 'Pozole' });
    expect(addedRecipeWithStaplesToast('Pozole', 0, ['sal'])).toEqual({
      message: 'Siempre tienes todo lo de Pozole',
      emphasis: 'Pozole',
    });
    expect(addedRecipeWithStaplesToast('Pozole', 6, ['sal', 'pimienta'], 'Súper').message).toBe(
      'Se agregó Pozole a Súper · 6 artículos\nSe omitió sal, pimienta',
    );
    expect(addedRecipeWithStaplesToast('Pozole', 6, ['sal', 'pimienta', 'comino', 'ajo']).message).toBe(
      'Se agregó Pozole · 6 artículos\nSe omitió sal, pimienta y 2 más',
    );
  });

  it('says the Add to recipe title and toast', () => {
    initI18n('es');
    expect(addToRecipeTitle(1)).toBe('Agregar 1 artículo a…');
    expect(addToRecipeTitle(3)).toBe('Agregar 3 artículos a…');
    expect(addedToRecipeToast(1, 'Tacos').message).toBe('Se agregó 1 artículo a Tacos');
    expect(addedToRecipeToast(3, 'Tacos').message).toBe('Se agregaron 3 artículos a Tacos');
  });

  it('says every import error', () => {
    initI18n('es');
    expect(importErrorMessage({ ok: false, error: 'not_a_recipe' })).toBe('Esa página no parece una receta');
    expect(importErrorMessage({ ok: false, error: 'not_entitled' })).toBe('Importar recetas no está incluido en tu plan.');
    expect(NOT_ENTITLED_MESSAGE).toBe('Importar recetas no está incluido en tu plan.');
    expect(importErrorMessage({ ok: false, error: 'rate_limited' })).toBe('Inténtalo de nuevo en un minuto');
    expect(importErrorMessage({ ok: false, error: 'offline' })).toBe('No tienes conexión');
    expect(importErrorMessage({ ok: false, error: 'blocked' })).toBe(
      'Este sitio bloqueó la importación. Ábrelo en Safari y toca Compartir → The Perfect Bite.',
    );
    expect(importErrorMessage({ ok: false, error: 'failed', reason: 'fetch_failed' })).toBe('No se pudo abrir ese sitio');
    expect(importErrorMessage({ ok: false, error: 'failed', reason: 'invalid_url' })).toBe('Eso no parece un enlace');
    expect(importErrorMessage({ ok: false, error: 'failed' })).toBe('No se pudo importar esa receta. Inténtalo de nuevo.');
  });

  it('says the import sheet and the toasts after an import', () => {
    initI18n('es');
    expect(saveButtonTitle(false, 'Súper')).toBe('Guardar receta');
    expect(saveButtonTitle(true, 'Súper')).toBe('Guardar y agregar a Súper');
    expect(saveButtonTitle(true, null)).toBe('Guardar y agregar a la lista');
    expect(NO_LISTS_IN_HOUSEHOLD).toBe('Este hogar no tiene listas');
    expect(NAME_IS_LINK_FOOTNOTE).toBe('Eso es un enlace. Mejor escribe el nombre de la receta.');
    expect(importedOnRecipesToast('Pozole', 12, 'Súper')).toEqual({
      message: 'Se agregó Pozole · 12 artículos en Súper',
      emphasis: 'Pozole',
    });
    expect(importedOnRecipesToast('Pozole', 1, null).message).toBe('Se agregó Pozole · 1 artículo');
    expect(savedRecipeToast('Pozole', true).message).toBe('Se guardó Pozole');
    expect(savedRecipeToast('Pozole', false).message).toBe('Pozole ya está en tus recetas');
    expect(sharedImportsToast(1).message).toBe('Se agregó 1 receta');
    expect(sharedImportsToast(3).message).toBe('Se agregaron 3 recetas');
  });

  it('says why a share failed, and what the queue is doing', () => {
    initI18n('es');
    expect(failedImportReason('not_a_recipe')).toBe('Esa página no parece una receta');
    expect(failedImportReason('blocked')).toBe('El sitio bloqueó la importación');
    expect(failedImportReason('rate_limited')).toBe('El servicio de importación estaba ocupado');
    expect(failedImportReason('offline')).toBe('No se pudo conectar');
    expect(failedImportReason('not_entitled')).toBe('Importar recetas no está incluido en tu plan.');
    expect(failedImportReason('failed')).toBe('No se pudo leer esa página');
    expect(shareFailureReason('not_a_member', null)).toBe('Ya no estás en ese hogar.');
    expect(shareFailureReason('daily_limit', '2026-10-24T00:00:00Z')).toBe(i18n.t('errors.dailyLimit'));
    expect(shareFailureReason('internal', null)).toBe('Algo salió mal.');
    expect(shareFailureReason('fetch_failed', null)).toBe('No se pudo abrir ese sitio');
    expect(shareFailureReason('invalid_url', null)).toBe('Eso no parece un enlace');
    const queue = { queued: [share()], failed: [], offline: false };
    expect(waitReasonText(queue)).toBe('Las prepararemos en segundo plano.');
    expect(waitReasonText({ ...queue, offline: true })).toBe('No tienes conexión. Se importarán cuando vuelvas a estar en línea.');
    expect(queuedShareDetail(share({ listName: 'Súper' }))).toBe('bonappetit.com · a Súper');
    expect(queuedShareDetail(share({ householdName: 'Casa' }))).toBe('bonappetit.com · a Casa');
    expect(queuedShareDetail(share())).toBe('bonappetit.com');
  });

  it('heads the imports card', () => {
    initI18n('es');
    const queued = [share({ id: 'a', title: 'Pozole', listName: 'Súper' }), share({ id: 'b' })];
    expect(importsCardHeading(1, { queued: [], failed: [], offline: false })).toEqual({
      tone: 'failed',
      title: 'No se pudo importar: 1 receta',
      subtitle: null,
    });
    expect(importsCardHeading(2, { queued, failed: [], offline: true })?.subtitle).toBe(
      '2 más en espera · No tienes conexión. Se importarán cuando vuelvas a estar en línea.',
    );
    expect(importsCardHeading(0, { queued, failed: [], offline: false })).toEqual({
      tone: 'waiting',
      title: '2 recetas en espera',
      subtitle: 'Las prepararemos en segundo plano.',
    });
  });

  it('renders the Filters pill and its chips', () => {
    initI18n('es');
    let root!: ReactTestRenderer;
    act(() => {
      root = create(
        <RecipeFilterBar filters={{ ...noRecipeFilters(), time: ['under-30'] }} onOpen={() => {}} onRemove={() => {}} />,
      );
    });
    expect(texts(root)).toEqual(expect.arrayContaining(['Filtros · 1', 'Menos de 30 min']));
    expect(labels(root)).toEqual(expect.arrayContaining(['Filtros, 1 activos', 'Quitar el filtro Menos de 30 min']));
    expect(root.root.findAll((n) => n.props.accessibilityHint === 'Abre los filtros.').length).toBeGreaterThan(0);
    act(() => root.unmount());
  });

  it('the filter bar can hide chips (still counted), take trailing children and scroll in one row', () => {
    initI18n('es');
    const filters = { ...noRecipeFilters(), time: ['under-30' as const], tags: { ...noRecipeFilters().tags, meal: ['dinner'] } };
    let root!: ReactTestRenderer;
    act(() => {
      root = create(
        <RecipeFilterBar row filters={filters} onOpen={() => {}} onRemove={() => {}} hideChip={(chip) => chip.facet === 'meal'}>
          <Text>Rápido</Text>
        </RecipeFilterBar>,
      );
    });
    expect(texts(root)).toEqual(expect.arrayContaining(['Filtros · 2', 'Menos de 30 min', 'Rápido']));
    expect(labels(root)).not.toContain('Quitar el filtro Cena');
    expect(root.root.findAll((n) => n.type === ('RCTScrollView' as never) && n.props.horizontal === true)).toHaveLength(1);
    act(() => root.unmount());
  });

  it('renders the tag row: Add tags and Suggest tags when untagged, one line of values when tagged', () => {
    initI18n('es');
    let root!: ReactTestRenderer;
    act(() => {
      root = create(<RecipeTagRow recipe={{ id: 'r1', tags: null, totalMinutes: null }} onEdit={() => {}} onSuggest={() => {}} />);
    });
    expect(texts(root)).toEqual(expect.arrayContaining(['Agregar etiquetas', 'Sugerir etiquetas']));
    act(() => {
      root.update(<RecipeTagRow recipe={{ id: 'r1', tags: null, totalMinutes: 90 }} onEdit={() => {}} />);
    });
    expect(texts(root)).toEqual(expect.arrayContaining(['Más de 1 hora']));
    expect(labels(root)).toEqual(expect.arrayContaining(['Etiquetas: Más de 1 hora']));
    expect(root.root.findAll((n) => n.props.accessibilityHint === 'Edita las etiquetas').length).toBeGreaterThan(0);
    act(() => root.unmount());
  });
});
