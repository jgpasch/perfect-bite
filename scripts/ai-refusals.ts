// Fake refused AI photo prompts in the local database, for testing AI photo blocks by hand (spec
// 6.11). Local only: it refuses any database that isn't on 127.0.0.1 or localhost. Needs `psql`.
//
//   yarn dev:ai-refusals <email> [count]   # insert count refused rows (default 3); the third blocks
//   yarn dev:ai-refusals <email> --clear   # delete the fake rows, the block and its audit row
//
// The rows go through the real `ai_calls` trigger, so they block the user exactly as real refusals
// would. `DATABASE_URL` overrides the local database.

import { RECIPE_PHOTO_IMAGE_PROMPT_VERSION } from '../supabase/functions/_shared/ai/prompts/recipe-photo-image.v1.ts';

export const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';
/** Every fake row's `error`, which is how `--clear` finds them. */
export const FAKE_REFUSAL_ERROR = 'Fake refusal (dev:ai-refusals)';
export const DEFAULT_COUNT = 3;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Throws unless `url` is a postgres URL on 127.0.0.1 or localhost, so this can never touch hosted. */
export function assertLocalDatabase(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a database URL: ${url}`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') throw new Error(`Not a postgres URL: ${url}`);
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to run against ${parsed.hostname || 'no host'}: dev:ai-refusals only touches a local database (127.0.0.1 or localhost)`);
  }
}

export type Command = { email: string; action: { kind: 'insert'; count: number } | { kind: 'clear' } };

const USAGE = 'Usage: yarn dev:ai-refusals <email> [count] | yarn dev:ai-refusals <email> --clear';

/** `<email> [count]` or `<email> --clear`; throws the usage for anything else. */
export function parseArgs(args: string[]): Command {
  const clear = args.includes('--clear');
  const rest = args.filter((a) => a !== '--clear');
  const [email, countArg, ...extra] = rest;
  if (!email || !email.includes('@') || extra.length > 0 || (clear && countArg !== undefined)) throw new Error(USAGE);
  if (clear) return { email, action: { kind: 'clear' } };
  if (countArg === undefined) return { email, action: { kind: 'insert', count: DEFAULT_COUNT } };
  if (!/^\d+$/.test(countArg) || Number(countArg) < 1 || Number(countArg) > 100) throw new Error(`count must be a whole number from 1 to 100, not ${countArg}\n${USAGE}`);
  return { email, action: { kind: 'insert', count: Number(countArg) } };
}

/** Runs `sql` through psql with `vars` as psql variables (quoted in the SQL as `:'name'`); answers its unaligned output. */
async function psql(url: string, sql: string, vars: Record<string, string>): Promise<string> {
  const args = [url, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-f', '-'];
  let child;
  try {
    child = new Deno.Command('psql', { args, stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn();
  } catch (err) {
    throw new Error(`Couldn't run psql (is it installed?): ${err instanceof Error ? err.message : String(err)}`);
  }
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr).trim() || `psql exited with ${code}`);
  return new TextDecoder().decode(stdout).trim();
}

const STATUS_SQL = `
select private.ai_photo_refusals(:'user_id'::uuid, now() - private.ai_photo_block_window())
  || '|' || case when exists (select 1 from private.ai_photo_blocks where user_id = :'user_id'::uuid) then 'blocked' else 'not blocked' end;
`;

/** One insert per row, so the trigger sees them one at a time as it would real refusals. */
function insertSql(count: number): string {
  const insert = `insert into public.ai_calls (id, created_at, task, model, prompt_version, status, instructions, prompt, duration_ms, error, user_id, household_id)
values (gen_random_uuid(), now(), 'recipePhotoImage', 'mock', '${RECIPE_PHOTO_IMAGE_PROMPT_VERSION}', 'refused', '', 'Fake refused prompt (dev:ai-refusals)', 0, :'fake_error', :'user_id'::uuid, nullif(:'household_id', '')::uuid);`;
  return `begin;\n${Array.from({ length: count }, () => insert).join('\n')}\ncommit;\n`;
}

const CLEAR_SQL = `
begin;
delete from admin.admin_actions a
using private.ai_photo_blocks b
where b.user_id = :'user_id'::uuid and a.target_user_id = b.user_id
  and a.action = 'block_ai_photos' and a.created_at >= b.blocked_at;
delete from private.ai_photo_blocks where user_id = :'user_id'::uuid;
delete from public.ai_calls where user_id = :'user_id'::uuid and error = :'fake_error';
commit;
`;

async function main() {
  const command = parseArgs(Deno.args);
  const url = Deno.env.get('DATABASE_URL')?.trim() || LOCAL_DATABASE_URL;
  assertLocalDatabase(url);

  const found = await psql(
    url,
    `select u.id || '|' || coalesce((
       select m.household_id::text from public.household_members m join public.households h on h.id = m.household_id
       where m.user_id = u.id order by h.created_at, h.id limit 1), '')
     from auth.users u where lower(u.email) = lower(:'email');`,
    { email: command.email },
  );
  if (!found) throw new Error(`No user with the email ${command.email}`);
  const [userId, householdId] = found.split('|');
  const vars = { user_id: userId, household_id: householdId, fake_error: FAKE_REFUSAL_ERROR };

  if (command.action.kind === 'clear') {
    await psql(url, CLEAR_SQL, vars);
    console.log(`Cleared the fake refusals and AI photo block for ${command.email}.`);
  } else {
    await psql(url, insertSql(command.action.count), vars);
    console.log(`Inserted ${command.action.count} fake refused prompt${command.action.count === 1 ? '' : 's'} for ${command.email}.`);
  }
  const [refusals, blocked] = (await psql(url, STATUS_SQL, vars)).split('|');
  console.log(`${refusals} refused prompts in the block window; ${blocked}.`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
