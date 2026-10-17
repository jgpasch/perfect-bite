import type { SupabaseClient } from '@supabase/supabase-js';

import type { GroupDetails, NotificationStore, QueuedEvent, Recipient, StoredReceipt } from './handler.ts';

/** NotificationStore over the service-role client (20261105120000_send_notifications.sql). */
export function createNotificationStore(admin: SupabaseClient): NotificationStore {
  async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw error;
    return data as T;
  }

  return {
    async readEvents(qty, vtSeconds) {
      const rows = await call<{ msg_id: number; message: unknown }[] | null>('read_household_events', { p_qty: qty, p_vt: vtSeconds });
      return (rows ?? []).map((r): QueuedEvent => ({ msgId: Number(r.msg_id), message: r.message }));
    },
    async archive(msgIds) {
      await call('archive_household_events', { p_msg_ids: msgIds });
    },
    async release(msgIds) {
      await call('release_household_events', { p_msg_ids: msgIds });
    },
    async groupDetails(kind, listId, actor, ids) {
      const data = await call<{
        list_name: string | null;
        actor_name: string | null;
        last_sent_at: string | null;
        items: { id: string; name: string; recipe_id: string | null; recipe_name: string | null }[];
      }>('notification_group', { p_kind: kind, p_list_id: listId, p_actor: actor, p_ids: ids });
      return {
        listName: data.list_name,
        actorName: data.actor_name,
        lastSentAt: data.last_sent_at,
        items: data.items.map((i) => ({ id: i.id, name: i.name, recipeId: i.recipe_id, recipeName: i.recipe_name })),
      } satisfies GroupDetails;
    },
    async recipients(householdId, actor, kind, at) {
      const rows = await call<{ user_id: string; token: string; platform: string }[] | null>('notification_recipients', {
        p_household_id: householdId,
        p_actor: actor,
        p_kind: kind,
        p_at: at.toISOString(),
      });
      return (rows ?? []).map((r): Recipient => ({ userId: r.user_id, token: r.token, platform: r.platform }));
    },
    async recordSent(householdId, actor, listId, kind) {
      await call('record_push_sent', { p_household_id: householdId, p_actor: actor, p_list_id: listId, p_kind: kind });
    },
    async deleteTokens(tokens) {
      await call('delete_push_tokens', { p_tokens: tokens });
    },
    async saveReceipts(receipts) {
      await call('save_push_receipts', { p_receipts: receipts.map((r) => ({ ticket_id: r.ticketId, token: r.token })) });
    },
    async dueReceipts(minAgeSeconds, limit) {
      const rows = await call<{ ticket_id: string; token: string }[] | null>('due_push_receipts', {
        p_min_age: `${minAgeSeconds} seconds`,
        p_limit: limit,
      });
      return (rows ?? []).map((r): StoredReceipt => ({ ticketId: r.ticket_id, token: r.token }));
    },
    async deleteReceipts(ticketIds) {
      await call('delete_push_receipts', { p_ticket_ids: ticketIds });
    },
  };
}
