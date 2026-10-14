// Spec 4.15: households and invites, Settings, account deletion, sync status, in-app notifications and
// the app's own error messages come from src/i18n/. English is checked by the existing tests; these check
// the Spanish, the plurals, and that module-level strings follow a language change.
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  ACCOUNT_DELETED_TOAST,
  DELETE_ACCOUNT_FAILED,
  DELETE_ACCOUNT_OFFLINE,
  DELETE_ACCOUNT_SECOND_CONFIRM,
  deleteAccountConfirmation,
} from '@/features/auth/delete-account';
import {
  deletedHouseholdToast,
  deleteHouseholdConfirmation,
  HouseholdActionError,
  householdActionAlert,
  householdCountsLabel,
  leaveConfirmation,
  MEMBERS_ERROR_MESSAGE,
  memberActionsSheet,
  memberLabel,
  memberRowAccessibilityLabel,
  roleChangeConfirmation,
  type HouseholdMember,
} from '@/features/households/households';
import { inviteChannelLabel, inviteSendTitle, inviteSheetTitle, inviteSkipNote } from '@/features/households/invite-sheet';
import {
  inviteErrorMessage,
  inviteMailBody,
  inviteMailSubject,
  inviteShareMessage,
  inviteStatusMessage,
  JOIN_BODY,
  joinTitle,
  type InviteErrorKind,
  type MyInvite,
} from '@/features/households/invites';
import {
  declineInvitePrompt,
  inviteCardAccessibilityLabel,
  inviteCardDetail,
  inviteCardTitle,
  myInviteFailure,
} from '@/features/households/my-invites';
import { pendingInviteActions, pendingInviteDetail, pendingInviteErrorTitle } from '@/features/households/pending-invites';
import { staplesCountLabel } from '@/features/households/staples';
import { DuplicateItemError } from '@/features/lists/items';
import { AISLE_COLOR_STYLES, aisleColorStyleLabel, ITEM_ROW_STYLES } from '@/features/lists/list-view';
import { importedNotification, importFailedNotification, savedNotification } from '@/features/recipes/import-notifications';
import { InviteError } from '@/features/households/invites';
import { i18n, initI18n } from '@/i18n';
import { getGoogleIdToken } from '@/lib/google-sign-in';
import { formatLastSync, syncStatus, type SyncInputs } from '@/sync/status';

jest.mock('@/global.css', () => ({}));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
// The native SDK isn't in Jest; Google sign-in isn't configured here, so it's never called.
jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: {}, statusCodes: {} }));

afterEach(() => initI18n('en'));

const member = (over: Partial<HouseholdMember> & Pick<HouseholdMember, 'userId' | 'displayName'>): HouseholdMember => ({
  avatarUrl: null,
  role: 'member',
  joinedAt: '2026-01-01T00:00:00Z',
  isYou: false,
  ...over,
});
const ME_OWNER = member({ userId: 'me', displayName: 'John', role: 'owner', isYou: true, joinedAt: '2025-01-01T00:00:00Z' });
const SAM = member({ userId: 'sam', displayName: 'Sam' });
const INVITE: MyInvite = { id: 'i1', householdId: 'h1', householdName: 'Casa Pérez', invitedBy: 'Lupita', memberCount: 1 };

describe('in English', () => {
  it('counts lists and recipes with real plurals', () => {
    expect(householdCountsLabel(0, 0)).toBe('0 lists · 0 recipes');
    expect(householdCountsLabel(1, 1)).toBe('1 list · 1 recipe');
    expect(householdCountsLabel(2, 1_000_000)).toBe('2 lists · 1000000 recipes');
  });

  it('keeps household and member names with i18next syntax in them as typed', () => {
    expect(deletedHouseholdToast('{{name}}')).toEqual({ message: 'Deleted {{name}}', emphasis: '{{name}}' });
    expect(roleChangeConfirmation('make-owner', '$t(common.undo)').title).toBe('Make $t(common.undo) an owner?');
  });

  it('says the sync times', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    expect(formatLastSync(null, now)).toBe('Never');
    expect(formatLastSync('2026-10-14T11:59:30Z', now)).toBe('Just now');
    expect(formatLastSync('2026-10-14T11:59:00Z', now)).toBe('1 min ago');
    expect(formatLastSync('2026-10-14T09:00:00Z', now)).toBe('3 h ago');
  });
});

describe('households in Spanish', () => {
  it('counts lists and recipes, including the many case', () => {
    initI18n('es');
    expect(householdCountsLabel(0, 1)).toBe('0 listas · 1 receta');
    expect(householdCountsLabel(1, 3)).toBe('1 lista · 3 recetas');
    expect(householdCountsLabel(1_000_000, 2)).toBe('1000000 listas · 2 recetas');
  });

  it('labels members and roles', () => {
    initI18n('es');
    expect(memberLabel(ME_OWNER)).toBe('John (Tú)');
    expect(memberLabel(member({ userId: 'x', displayName: '  ' }))).toBe('Sin nombre');
    expect(memberRowAccessibilityLabel(SAM)).toBe('Sam, Miembro');
    expect(memberRowAccessibilityLabel(ME_OWNER)).toBe('John (Tú), Dueño');
    expect(MEMBERS_ERROR_MESSAGE).toBe('No se pudieron cargar los miembros. Revisa tu conexión.');
    expect(staplesCountLabel(0)).toBe('Ninguno');
    expect(staplesCountLabel(4)).toBe('4');
  });

  it('words the Leave confirm for each case', () => {
    initI18n('es');
    expect(leaveConfirmation({ householdName: 'Casa', members: [ME_OWNER], listCount: 1, recipeCount: 0, onlyHousehold: true })).toEqual({
      title: '¿Salir y eliminar Casa?',
      message: 'Eres el único miembro, así que se eliminarán sus 1 lista y 0 recetas. Tendrás un hogar nuevo y vacío.',
      confirmLabel: 'Salir y eliminar',
    });
    expect(leaveConfirmation({ householdName: ' ', members: [ME_OWNER, SAM], listCount: 2, recipeCount: 2, onlyHousehold: false })).toEqual({
      title: '¿Salir de este hogar?',
      message: 'Ya no tendrás acceso a sus listas y recetas. Se quedan en el hogar. Sam será el dueño.',
      confirmLabel: 'Salir',
    });
  });

  it('words the Delete confirm, naming the members only when there are others', () => {
    initI18n('es');
    expect(deleteHouseholdConfirmation({ householdName: 'Casa', memberCount: 3, listCount: 2, recipeCount: 1, onlyHousehold: false })).toEqual({
      title: '¿Eliminar Casa?',
      message: 'Se eliminarán sus 2 listas y 1 receta para los 3 miembros. No se puede deshacer.',
      confirmLabel: 'Eliminar',
    });
    expect(deleteHouseholdConfirmation({ householdName: '', memberCount: 1, listCount: 1, recipeCount: 1, onlyHousehold: true }).message).toBe(
      'Se eliminarán sus 1 lista y 1 receta. No se puede deshacer. Tendrás un hogar nuevo y vacío.',
    );
    expect(deletedHouseholdToast('Casa')).toEqual({ message: 'Se eliminó Casa', emphasis: 'Casa' });
    expect(deletedHouseholdToast('  ')).toEqual({ message: 'Se eliminó el hogar' });
  });

  it('says why a household action failed', () => {
    initI18n('es');
    const err = (kind: ConstructorParameters<typeof HouseholdActionError>[0]) => new HouseholdActionError(kind, kind);
    expect(householdActionAlert('leave', err('offline'), { householdName: 'Casa' })).toEqual({
      title: 'No tienes conexión',
      message: 'Conéctate a internet y vuelve a intentarlo.',
    });
    expect(householdActionAlert('rename', err('not-owner'), { householdName: 'Casa' })).toEqual({
      title: 'No se pudo cambiar el nombre de Casa',
      message: 'Solo los dueños pueden cambiar el nombre del hogar.',
    });
    expect(householdActionAlert('remove', err('not-member'), { householdName: 'Casa', memberName: 'Sam' })).toEqual({
      title: 'No se pudo quitar a Sam',
      message: 'Ya no está en Casa.',
    });
    expect(householdActionAlert('step-down', err('last-owner')).message).toBe('Este hogar necesita al menos un dueño.');
    expect(householdActionAlert('step-down', err('last-owner'), { householdName: 'Casa' }).message).toBe('Casa necesita al menos un dueño.');
    expect(householdActionAlert('rename', err('too-long')).message).toBe('Usa un nombre más corto (hasta 50 caracteres).');
    expect(householdActionAlert('make-owner', err('failed')).title).toBe('No se pudo hacer dueño a esta persona');
    expect(householdActionAlert('delete', new Error('boom')).message).toBe('Algo salió mal. Vuelve a intentarlo.');
  });

  it("offers a member row's actions and confirms role changes", () => {
    initI18n('es');
    expect(memberActionsSheet(SAM, [ME_OWNER, SAM], 'Casa')).toMatchObject({
      options: ['Hacer dueño', 'Quitar de Casa', 'Cancelar'],
      hint: 'Hacer dueño o quitar del hogar.',
    });
    const otherOwner = { ...SAM, role: 'owner' as const };
    expect(memberActionsSheet(ME_OWNER, [ME_OWNER, otherOwner], 'Casa')).toMatchObject({
      options: ['Dejar de ser dueño', 'Cancelar'],
      hint: 'Dejar de ser dueño.',
    });
    expect(roleChangeConfirmation('remove-owner', 'Sam')).toEqual({
      title: '¿Quitar a Sam como dueño?',
      message: 'Seguirá como miembro.',
      confirmLabel: 'Quitar como dueño',
      destructive: true,
    });
    expect(roleChangeConfirmation('step-down', 'John').title).toBe('¿Dejar de ser dueño?');
  });
});

describe('invites in Spanish', () => {
  it('writes the share text and the Mail invite', () => {
    initI18n('es');
    const link = 'perfectbite://invite/abc';
    expect(inviteShareMessage('Casa', link)).toBe(`Únete a “Casa” en The Perfect Bite: ${link}`);
    expect(inviteShareMessage(' ', link)).toBe(`Únete a mi hogar en The Perfect Bite: ${link}`);
    expect(inviteMailSubject('')).toBe('Únete a mi hogar en The Perfect Bite');
    expect(inviteMailBody({ householdName: 'Casa', inviterName: 'Lupita', email: ' Pat@Example.com ', link })).toBe(
      [
        'Lupita te invitó a unirte a Casa en The Perfect Bite.',
        'Compartirás sus listas y recetas. Tus otros hogares no cambian.',
        `Abre este enlace para unirte: ${link}`,
        'Inicia sesión con pat@example.com y ahí estará la invitación.',
      ].join('\n\n'),
    );
    expect(inviteMailBody({ householdName: 'Casa', inviterName: null, email: 'a@b.co', link }).split('\n\n')[0]).toBe(
      'Te invitaron a unirte a Casa en The Perfect Bite.',
    );
  });

  it('says what went wrong for every invite error', () => {
    initI18n('es');
    const kinds: Record<InviteErrorKind, string> = {
      invalid: 'Este enlace de invitación no es válido. Pide uno nuevo.',
      used: 'Esta invitación ya se usó. Pide una nueva.',
      expired: 'Esta invitación ya venció. Pide una nueva.',
      'already-member': 'Ya está en este hogar.',
      'invalid-email': 'Eso no parece un correo electrónico.',
      network: 'No se pudo conectar con el servidor. Revisa tu conexión y vuelve a intentarlo.',
    };
    for (const [kind, message] of Object.entries(kinds)) expect(inviteErrorMessage(kind as InviteErrorKind)).toBe(message);
    expect(inviteErrorMessage('already-member', { email: 'PAT@x.com', householdName: 'Casa' })).toBe('pat@x.com ya está en Casa.');
  });

  it('words the join screen', () => {
    initI18n('es');
    expect(joinTitle('Casa')).toBe('¿Unirte a Casa?');
    expect(joinTitle('')).toBe('¿Unirte a este hogar?');
    expect(inviteStatusMessage('member', 'Casa')).toBe('Ya estás en Casa.');
    expect(inviteStatusMessage('used', 'Casa')).toBe('Esta invitación ya se usó. Pide una nueva.');
    expect(inviteStatusMessage('valid', 'Casa')).toBeNull();
  });

  it('words the invite sheet', () => {
    initI18n('es');
    expect(inviteSheetTitle(null)).toBe('Invitar a tu hogar');
    expect(inviteSendTitle('sam.lee@x.com')).toBe('Avísale a Sam');
    expect(inviteSendTitle('@x.com')).toBe('Avísale a esa persona');
    expect(inviteSkipNote('@x.com')).toBe(
      'También puedes saltarte esto. Si inicia sesión con este correo, verá la invitación en la app.',
    );
    expect((['messages', 'mail', 'copy', 'more'] as const).map(inviteChannelLabel)).toEqual([
      'Mensajes',
      'Mail',
      'Copiar enlace',
      'Más…',
    ]);
  });

  it('words the invite cards, with real plurals', () => {
    initI18n('es');
    expect(inviteCardTitle(INVITE)).toBe('Lupita te invitó');
    expect(inviteCardTitle({ ...INVITE, invitedBy: null })).toBe('Te invitaron');
    expect(inviteCardDetail(INVITE)).toBe('a Casa Pérez · 1 miembro');
    expect(inviteCardDetail({ ...INVITE, memberCount: 0 })).toBe('a Casa Pérez · 0 miembros');
    expect(inviteCardDetail({ ...INVITE, householdName: ' ', memberCount: 4 })).toBe('a un hogar · 4 miembros');
    expect(inviteCardAccessibilityLabel(INVITE)).toBe('Lupita te invitó a Casa Pérez');
    expect(declineInvitePrompt(INVITE)).toEqual({
      title: '¿Rechazar la invitación a Casa Pérez?',
      message: 'Lupita puede enviarte una nueva.',
    });
    expect(declineInvitePrompt({ ...INVITE, invitedBy: null }).message).toBe('Te pueden enviar una nueva.');
    expect(myInviteFailure(new InviteError('used', 'invite already used'))).toEqual({
      message: 'Esta invitación se canceló.',
      removed: true,
    });
  });

  it('words the Invited rows and their action sheet', () => {
    initI18n('es');
    const now = new Date('2026-10-14T00:00:00Z');
    expect(pendingInviteDetail({ invitedBy: 'John', expiresAt: '2026-10-18T12:00:00Z' }, now)).toBe('Enviada por John · vence 18 oct');
    expect(pendingInviteDetail({ invitedBy: null, expiresAt: 'nope' }, now)).toBe('Enviada');
    expect(pendingInviteActions({ email: 'a@b.co' }).options).toEqual(['Volver a enviar', 'Cancelar invitación', 'Cancelar']);
    expect(pendingInviteErrorTitle('revoke')).toBe('No se pudo cancelar la invitación');
  });

  it('switches the join body both ways', () => {
    initI18n('es');
    expect(JOIN_BODY).toBe('Compartirás sus listas y recetas. Tus otros hogares no cambian.');
    initI18n('en');
    expect(JOIN_BODY).toBe("You'll share its lists and recipes. Your other households aren't affected.");
  });
});

describe('account deletion in Spanish', () => {
  it('says what goes, with one shared household or several', () => {
    initI18n('es');
    const solo = { name: 'Mi casa', listCount: 1, recipeCount: 2, memberCount: 1 };
    const shared = { name: 'Casa Pérez', listCount: 3, recipeCount: 0, memberCount: 2 };
    expect(deleteAccountConfirmation([solo, shared])).toEqual({
      title: '¿Eliminar tu cuenta?',
      message: [
        'No se puede deshacer. Se eliminarán tu cuenta, tu orden de pasillos y tus ajustes.',
        'Se eliminarán Mi casa y sus 1 lista y 2 recetas, porque eres su único miembro.',
        'Tus listas y recetas en Casa Pérez se quedan con sus otros miembros.',
      ].join('\n\n'),
    });
    expect(deleteAccountConfirmation(null).message).toBe(
      'No se puede deshacer. Se eliminarán tu cuenta, tu orden de pasillos y tus ajustes.',
    );
  });

  it('keeps "its" and "their" apart in English', () => {
    const shared = (name: string) => ({ name, listCount: 1, recipeCount: 1, memberCount: 2 });
    expect(deleteAccountConfirmation([shared('A')]).message).toContain('in A stay with its other members.');
    expect(deleteAccountConfirmation([shared('A'), shared('B')]).message).toContain('in A, B stay with their other members.');
  });

  it('switches the alerts and the toast both ways', () => {
    initI18n('es');
    expect(DELETE_ACCOUNT_SECOND_CONFIRM).toEqual({ title: '¿Estás seguro?', message: 'Tu cuenta se eliminará ahora.' });
    expect(DELETE_ACCOUNT_OFFLINE).toEqual({ title: 'No tienes conexión', message: 'Conéctate a internet para eliminar tu cuenta.' });
    expect(DELETE_ACCOUNT_FAILED.title).toBe('No se pudo eliminar tu cuenta');
    expect(ACCOUNT_DELETED_TOAST).toBe('Tu cuenta se eliminó.');
    initI18n('en');
    expect(DELETE_ACCOUNT_OFFLINE).toEqual({ title: "You're offline", message: 'Connect to the internet to delete your account.' });
    expect(ACCOUNT_DELETED_TOAST).toBe('Your account was deleted.');
  });
});

describe('sync status in Spanish', () => {
  const inputs = (over: Partial<SyncInputs> = {}): SyncInputs => ({
    signedIn: true,
    pending: 0,
    rejected: 0,
    push: { lastSuccessAt: null, lastError: null },
    pull: { lastSuccessAt: null, lastError: null },
    activity: { pushing: false, pulling: false, online: true },
    ...over,
  });

  it('labels each state', () => {
    initI18n('es');
    const ok = { lastSuccessAt: '2026-10-14T00:00:00Z', lastError: null };
    expect(syncStatus(inputs({ signedIn: false })).label).toBe('Sin sincronizar');
    expect(syncStatus(inputs({ activity: { pushing: false, pulling: false, online: false } })).label).toBe('Sin conexión');
    expect(syncStatus(inputs({ activity: { pushing: true, pulling: false, online: true } })).label).toBe('Sincronizando…');
    expect(syncStatus(inputs()).label).toBe('Aún sin sincronizar');
    expect(syncStatus(inputs({ push: ok, pull: ok }))).toMatchObject({ label: 'Sincronizado', tone: 'positive' });
  });

  it('puts the error as received after a translated prefix', () => {
    initI18n('es');
    const push = { lastSuccessAt: null, lastError: 'HTTP 500' };
    expect(syncStatus(inputs({ push }))).toMatchObject({ state: 'error', label: 'Error de sincronización', tone: 'danger', lastError: 'Al enviar: HTTP 500' });
    const pull = { lastSuccessAt: null, lastError: 'Network request failed' };
    expect(syncStatus(inputs({ pull })).lastError).toBe('Al recibir: Network request failed');
  });

  it('says when it last synced', () => {
    initI18n('es');
    const now = new Date('2026-10-14T12:00:00Z');
    expect(formatLastSync(null, now)).toBe('Nunca');
    expect(formatLastSync('not a date', now)).toBe('Nunca');
    expect(formatLastSync('2026-10-14T11:59:59Z', now)).toBe('Justo ahora');
    expect(formatLastSync('2026-10-14T11:15:00Z', now)).toBe('Hace 45 min');
    expect(formatLastSync('2026-10-13T13:00:00Z', now)).toBe('Hace 23 h');
  });
});

describe('notifications and errors in Spanish', () => {
  const result = { ok: true as const, recipeId: 'r1', recipeName: 'Pozole', listId: 'l1', created: true, added: 1, combined: 0, undo: () => {} };

  it('words the import notifications, with real plurals', () => {
    initI18n('es');
    expect(importedNotification(result, 'Súper')).toMatchObject({
      title: 'Receta agregada',
      body: 'Se agregó Pozole · 1 artículo a Súper',
      emphasis: 'Pozole',
      hint: 'Abre Súper',
    });
    expect(importedNotification({ ...result, added: 12 }, 'Súper').body).toBe('Se agregó Pozole · 12 artículos a Súper');
    expect(savedNotification(result, 'Casa')).toMatchObject({
      title: 'Receta guardada',
      body: 'Se guardó Pozole en Casa',
      hint: 'Abre la receta',
    });
    expect(importFailedNotification({ ok: false, error: 'offline' }, 'https://x.com')).toMatchObject({
      title: 'No se pudo importar la receta',
      hint: 'Vuelve a abrir el enlace para intentarlo otra vez',
    });
  });

  it('words the errors the screens show', async () => {
    initI18n('es');
    expect(new DuplicateItemError('Leche').message).toBe('Leche ya está en esta lista');
    await expect(getGoogleIdToken()).rejects.toThrow('El inicio de sesión con Google no está configurado.');
    expect(i18n.t('errors.notAnAmount', { amount: 'mucho' })).toBe('“mucho” no es una cantidad, como 2 o 1 lb');
    initI18n('en');
    expect(new DuplicateItemError('Milk').message).toBe('Milk is already on this list');
    await expect(getGoogleIdToken()).rejects.toThrow('Google sign-in is not configured.');
    expect(i18n.t('errors.notAnAmount', { amount: 'lots' })).toBe('"lots" isn\'t an amount, like 2 or 1 lb');
  });

  it('names the aisle colour choices in the app language', () => {
    initI18n('es');
    expect(ITEM_ROW_STYLES.map((s) => s.label)).toEqual(['Bandas de color', 'Filas blancas']);
    expect(AISLE_COLOR_STYLES.map((s) => s.label)).toEqual(['Toda la fila', 'Solo el encabezado']);
    expect(aisleColorStyleLabel('header')).toBe('Solo el encabezado');
    initI18n('en');
    expect(aisleColorStyleLabel('header')).toBe('Header only');
  });
});
