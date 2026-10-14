/**
 * The app's English strings, the source every other language follows (spec 4.15). Grouped by
 * feature; `{{name}}` is filled in by `t`. `es.ts` must have exactly these keys.
 */
export const en = {
  /** Shared across features. Plurals are `_one`/`_other` keys, picked by `count`. */
  common: {
    undo: 'Undo',
    cancel: 'Cancel',
    done: 'Done',
    edit: 'Edit',
    delete: 'Delete',
    select: 'Select',
    viewRecipe: 'View recipe',
    /** What VoiceOver announces when a toast with actions appears. */
    toastAnnouncement: '{{message}}. {{actions}} available.',
    /** A section header for VoiceOver: "Produce, 3 items". */
    sectionCount_one: '{{name}}, {{count}} item',
    sectionCount_other: '{{name}}, {{count}} items',
  },
  lists: {
    screen: {
      toGet: '{{count}} to get',
      allDone: 'All done',
      empty: 'Nothing on this list yet. Add an item below.',
      listActions: 'List actions',
      selectItems: 'Select items',
      shareList: 'Share list',
      editList: 'Edit list…',
      reorderAisles: 'Reorder aisles…',
      switchList: '{{name}}, switch list',
      switchListInvites_one: '{{name}}, switch list, {{count}} invite waiting',
      switchListInvites_other: '{{name}}, switch list, {{count}} invites waiting',
      switchListHint: 'Shows your other lists',
      compactTitle: '{{name}}, {{subtitle}}',
      compactTitleHint: 'Hides the keyboard',
    },
    viewModes: {
      newest: 'As added',
      category: 'By aisle',
      recipe: 'By recipe',
      button: 'View: {{mode}}',
      buttonHint: 'Changes how the list is grouped',
      collapseAll: 'Collapse all',
      expandAll: 'Expand all',
      resetOrder: 'Reset order',
    },
    sections: {
      sorting: 'Sorting…',
      checkAll: 'Check all',
      visitRecipe: 'Visit recipe on web',
      removeRecipe: 'Remove recipe from list',
      alsoIn: 'Also in {{names}}',
      fromRecipes: 'From {{names}}',
    },
    checked: {
      header: 'Checked · {{count}}',
      label_one: 'Checked, {{count}} item',
      label_other: 'Checked, {{count}} items',
      uncheckAll: 'Uncheck all',
      clear: 'Clear',
      clearLabel_one: 'Clear {{count}} checked item',
      clearLabel_other: 'Clear {{count}} checked items',
    },
    select: {
      tapToSelect: 'Tap items to select them',
      selected_one: '{{count}} selected',
      selected_other: '{{count}} selected',
      addToRecipe: 'Add to recipe',
    },
    row: {
      checkOff: 'Check off {{name}}',
      checkOffAction: 'Check off',
      uncheckAction: 'Uncheck',
      opensDetails: 'Opens details',
      selectHint: 'Double-tap to select',
    },
    toasts: {
      addedTo: 'Added to {{name}}',
      addedToNow: 'Added to {{name}}, now {{amount}}',
      moved: 'Moved {{name}}',
      movedFrom: 'Moved {{name}} from {{list}}',
      deleted: 'Deleted {{name}}',
      cleared_one: 'Cleared {{count}} item',
      cleared_other: 'Cleared {{count}} items',
      checkedAll_one: 'Checked {{count}} item',
      checkedAll_other: 'Checked {{count}} items',
      uncheckedAll_one: 'Unchecked {{count}} item',
      uncheckedAll_other: 'Unchecked {{count}} items',
      removedRecipe: 'Removed {{name}} from the list',
      siriAdded_one: 'Siri added {{count}} item',
      siriAdded_other: 'Siri added {{count}} items',
      orderReset: 'Order reset',
      /** On a recipe added from the add bar: opens its add sheet. */
      adjust: 'Adjust',
    },
    /** Share as text: the list's name, then a line per item. */
    share: {
      line: '- {{item}}',
      withNote: '{{item}} ({{note}})',
    },
    /** The Your lists sheet. */
    sheet: {
      title: 'Your lists',
      newList: 'New list',
      newListIn: 'New list in',
      invite: 'Invite',
      noLists: 'No lists',
      archived: 'Archived lists ({{count}})',
      archivedLabel: 'Archived lists, {{count}}',
      rowDone: 'Done',
      toGet_one: '{{count}} item to get',
      toGet_other: '{{count}} items to get',
      allDone: 'all done',
      siriList: 'Siri list',
      archivedState: 'archived',
      current: 'current',
      members_one: '{{name}}, {{count}} member',
      members_other: '{{name}}, {{count}} members',
      rename: 'Rename',
      makeDefault: 'Make default for Siri',
      archive: 'Archive',
      unarchive: 'Unarchive',
      archivedHint: 'Unarchive or delete',
      moreActions: 'More actions',
      deleteTitle: 'Delete “{{name}}”?',
      deleteMessage: 'Its items are deleted too.',
    },
    /** The system prompt for a list's name. */
    prompt: {
      rename: 'Rename list',
      new: 'New list',
      save: 'Save',
      create: 'Create',
    },
    /** The List tab with no open lists. */
    noLists: {
      message: 'No lists yet.',
      newList: 'New list',
      invites_one: '{{count}} invite waiting',
      invites_other: '{{count}} invites waiting',
      yourLists: 'Your lists',
    },
    edit: {
      name: 'Name',
      colour: 'Colour',
      siri: 'Default list for Siri',
      siriHintOn: 'To change it, turn it on for another list',
      siriHintOff: 'Siri adds to this list unless you name another',
      deleteList: 'Delete list',
      deleteHint: 'Asks first',
    },
    /** A list's colour, in Edit list. */
    colours: {
      default: 'Default',
      green: 'Green',
      blue: 'Blue',
      rose: 'Rose',
      amber: 'Amber',
      grey: 'Grey',
    },
  },
  signIn: {
    appName: 'The Perfect Bite',
    appNameStart: 'The ',
    appNameAccent: 'Perfect',
    appNameEnd: ' Bite',
    unconfigured:
      'Backend not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local, then restart the dev server.',
    tagline: 'The shopping list app that helps you get the perfect bite.',
    codeSent: 'Enter the 6-digit code sent to {{email}}.',
    continueWithGoogle: 'Continue with Google',
    signingIn: 'Signing in…',
    email: 'Email',
    code: 'Sign-in code',
    codePlaceholder: '123456',
    sendCode: 'Send code',
    sending: 'Sending…',
    signIn: 'Sign in',
    differentEmail: 'Use a different email',
    newHere: 'New here? We’ll set up your household and a Groceries list.',
  },
};

/** Every language's strings: `en`'s shape, with a string at each leaf. */
export type Strings = StringsOf<typeof en>;

type StringsOf<T> = { [K in keyof T]: T[K] extends string ? string : StringsOf<T[K]> };
