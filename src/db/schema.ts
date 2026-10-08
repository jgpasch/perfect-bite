import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Per-device key/value settings that never sync, e.g. each list's last view mode (spec 4.6).
 * Values are JSON. Household data and per-user settings get their own tables (M1, M2).
 */
export const deviceSettings = sqliteTable('device_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});
