// The list's add field copy. The placeholder stays short so it fits on an iPhone SE and at large
// Dynamic Type sizes without being cut off, as on the Pantry boards.

import { i18n, onLanguageChanged } from '@/i18n';

// Module-level strings follow the app's language (a live binding, set once i18n is initialized).
export let LIST_ADD_PLACEHOLDER = '';
export let LIST_ADD_LABEL = '';
onLanguageChanged(() => {
  LIST_ADD_PLACEHOLDER = i18n.t('addBar.placeholder');
  LIST_ADD_LABEL = i18n.t('addBar.label');
});
