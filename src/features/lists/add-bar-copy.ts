// The list's add field copy. The placeholder says a recipe's name works too (it offers recipe chips,
// spec 4.2) and stays short enough to fit on an iPhone SE without being cut off.

import { i18n, onLanguageChanged } from '@/i18n';

// Module-level strings follow the app's language (a live binding, set once i18n is initialized).
export let LIST_ADD_PLACEHOLDER = '';
export let LIST_ADD_LABEL = '';
onLanguageChanged(() => {
  LIST_ADD_PLACEHOLDER = i18n.t('addBar.placeholder');
  LIST_ADD_LABEL = i18n.t('addBar.label');
});
