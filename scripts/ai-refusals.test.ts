// dev:ai-refusals (spec 6.11): the local-only host check and the arguments. Deno, no database:
//   deno test --no-lock scripts/ai-refusals.test.ts
import { assertEquals, assertThrows } from 'jsr:@std/assert@1';

import { assertLocalDatabase, DEFAULT_COUNT, LOCAL_DATABASE_URL, parseArgs } from './ai-refusals.ts';

Deno.test('the host check takes the local database on 127.0.0.1 or localhost', () => {
  assertLocalDatabase(LOCAL_DATABASE_URL);
  assertLocalDatabase('postgresql://postgres:postgres@localhost:55322/postgres');
  assertLocalDatabase('postgres://postgres:postgres@127.0.0.1:5432/postgres');
});

Deno.test('the host check refuses a hosted or other non-local database', () => {
  for (const url of [
    'postgresql://postgres.abcdefghijklmnop:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
    'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
    'postgresql://postgres:pw@192.168.1.10:55322/postgres',
    'postgresql://postgres:pw@127.0.0.1.example.com:55322/postgres',
    'postgresql://postgres:pw@localhost.evil.dev/postgres',
  ]) {
    assertThrows(() => assertLocalDatabase(url), Error, 'only touches a local database');
  }
});

Deno.test('the host check refuses what isn\'t a postgres URL', () => {
  assertThrows(() => assertLocalDatabase('not a url'), Error, 'Not a database URL');
  assertThrows(() => assertLocalDatabase('http://127.0.0.1:55321'), Error, 'Not a postgres URL');
  assertThrows(() => assertLocalDatabase(''), Error, 'Not a database URL');
});

Deno.test('arguments: an email, then a count (default 3) or --clear', () => {
  assertEquals(parseArgs(['me@example.com']), { email: 'me@example.com', action: { kind: 'insert', count: DEFAULT_COUNT } });
  assertEquals(DEFAULT_COUNT, 3);
  assertEquals(parseArgs(['me@example.com', '2']), { email: 'me@example.com', action: { kind: 'insert', count: 2 } });
  assertEquals(parseArgs(['me@example.com', '--clear']), { email: 'me@example.com', action: { kind: 'clear' } });
  assertEquals(parseArgs(['--clear', 'me@example.com']), { email: 'me@example.com', action: { kind: 'clear' } });
});

Deno.test('arguments: anything else is the usage or a count error', () => {
  assertThrows(() => parseArgs([]), Error, 'Usage');
  assertThrows(() => parseArgs(['not-an-email']), Error, 'Usage');
  assertThrows(() => parseArgs(['me@example.com', '2', '3']), Error, 'Usage');
  assertThrows(() => parseArgs(['me@example.com', '2', '--clear']), Error, 'Usage');
  for (const count of ['0', '-1', '1.5', 'three', '101']) {
    assertThrows(() => parseArgs(['me@example.com', count]), Error, 'count must be a whole number from 1 to 100');
  }
});
