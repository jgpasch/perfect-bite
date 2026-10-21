// Drift guard for the admin portal (spec 4.12). Jest ignores `admin/`, so this reads its files as
// text: the portal's feature map must name exactly the app's features, and its tokens.css must
// carry every colour of the app's theme, and its safety-limit keys must be the migrations'
// `private.safety_limit_keys()`, so changing any of them without the portal fails here.
import { describe, expect, it, jest } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AisleColors, Palette, type ColorScheme } from '@/constants/theme';
import { FEATURES } from '@/features/plans/features';

jest.mock('@/global.css', () => ({}));

const root = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** `inkSecondary` → `--ink-secondary`. */
function cssVar(token: string): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** The `--name: value;` declarations in a block of CSS, by name. */
function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

/** tokens.css split into its light (`:root`) and dark (`prefers-color-scheme: dark`) declarations. */
function tokenSchemes(css: string): Record<ColorScheme, Map<string, string>> {
  const at = css.indexOf('@media (prefers-color-scheme: dark)');
  if (at < 0) throw new Error('admin/app/tokens.css has no dark block');
  return { light: declarations(css.slice(0, at)), dark: declarations(css.slice(at)) };
}

/** The keys of the `FEATURES` map in admin/lib/features.ts, in order. */
function adminFeatureKeys(source: string): string[] {
  const block = /export const FEATURES = \{([\s\S]*?)\n\}/.exec(source);
  if (!block) throw new Error('admin/lib/features.ts has no FEATURES map');
  return [...block[1].matchAll(/^\s*([a-z_]+):\s*\{/gm)].map((m) => m[1]);
}

/** The keys of the `SAFETY_LIMITS` map in admin/lib/safety-limits.ts, in order. */
function adminSafetyLimitKeys(source: string): string[] {
  const block = /export const SAFETY_LIMITS = \{([\s\S]*?)\n\}/.exec(source);
  if (!block) throw new Error('admin/lib/safety-limits.ts has no SAFETY_LIMITS map');
  return [...block[1].matchAll(/^\s*([a-z_]+):\s*\{/gm)].map((m) => m[1]);
}

/** The keys in the last `private.safety_limit_keys()` among the migrations (in file order), in order. */
function migrationSafetyLimitKeys(migrations: { name: string; sql: string }[]): string[] {
  let keys: string[] | null = null;
  for (const { sql } of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const m of sql.matchAll(/function private\.safety_limit_keys\(\)[\s\S]*?array\[([^\]]*)\]/g)) {
      keys = [...m[1].matchAll(/'([a-z_]+)'/g)].map((k) => k[1]);
    }
  }
  if (keys === null) throw new Error('no migration defines private.safety_limit_keys()');
  return keys;
}

describe('cssVar', () => {
  it('turns a token name into its kebab-case variable', () => {
    expect(cssVar('background')).toBe('--background');
    expect(cssVar('onHeaderSecondary')).toBe('--on-header-secondary');
  });
});

describe('admin/lib/features.ts', () => {
  const keys = adminFeatureKeys(read('admin/lib/features.ts'));

  it('names exactly the app’s features, once each', () => {
    expect(keys).toHaveLength(FEATURES.length);
    expect([...keys].sort()).toEqual([...FEATURES].sort());
  });

  it('is read the way the test thinks', () => {
    expect(adminFeatureKeys('export const FEATURES = {\n  a_b: { x: 1 },\n  c: { y: 2 },\n} as const;')).toEqual(['a_b', 'c']);
    expect(() => adminFeatureKeys('const nothing = 1;')).toThrow('no FEATURES map');
  });
});

describe('admin/lib/safety-limits.ts', () => {
  const dir = 'supabase/migrations';
  const migrations = readdirSync(join(root, dir))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, sql: read(join(dir, name)) }));

  it('names exactly private.safety_limit_keys(), in its order', () => {
    expect(adminSafetyLimitKeys(read('admin/lib/safety-limits.ts'))).toEqual(migrationSafetyLimitKeys(migrations));
  });

  it('is read the way the test thinks', () => {
    expect(adminSafetyLimitKeys('export const SAFETY_LIMITS = {\n  a_b: { x: 1 },\n  c: { y: 2 },\n} as const;')).toEqual(['a_b', 'c']);
    expect(() => adminSafetyLimitKeys('const nothing = 1;')).toThrow('no SAFETY_LIMITS map');
    const fn = (keys: string) => `create function private.safety_limit_keys()\nreturns text[]\nas $$ select array[${keys}]; $$;`;
    expect(
      migrationSafetyLimitKeys([
        { name: '2_later.sql', sql: fn("'b', 'a'") },
        { name: '1_first.sql', sql: fn("'a'") },
      ]),
    ).toEqual(['b', 'a']);
    expect(() => migrationSafetyLimitKeys([{ name: '1.sql', sql: 'select 1;' }])).toThrow('no migration defines');
  });
});

describe('admin/app/tokens.css', () => {
  const schemes = tokenSchemes(read('admin/app/tokens.css'));

  for (const scheme of ['light', 'dark'] as const) {
    it(`has every ${scheme} Palette colour under its token's variable`, () => {
      const mismatches = Object.entries(Palette[scheme])
        .filter(([token, hex]) => schemes[scheme].get(cssVar(token))?.toUpperCase() !== hex.toUpperCase())
        .map(([token, hex]) => `${cssVar(token)}: expected ${hex}, found ${schemes[scheme].get(cssVar(token)) ?? 'nothing'}`);
      expect(mismatches).toEqual([]);
    });

    it(`has every ${scheme} aisle colour`, () => {
      const mismatches: string[] = [];
      for (const [hue, { dot, soft, strong }] of Object.entries(AisleColors[scheme])) {
        for (const [name, hex] of [[`--aisle-${hue}`, dot], [`--aisle-${hue}-soft`, soft], [`--aisle-${hue}-strong`, strong]]) {
          if (schemes[scheme].get(name)?.toUpperCase() !== hex.toUpperCase()) mismatches.push(name);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('reads each scheme apart', () => {
    const parsed = tokenSchemes(':root { --ink: #111111; }\n@media (prefers-color-scheme: dark) { :root { --ink: #EEEEEE; } }');
    expect(parsed.light.get('--ink')).toBe('#111111');
    expect(parsed.dark.get('--ink')).toBe('#EEEEEE');
    expect(() => tokenSchemes(':root { --ink: #111111; }')).toThrow('no dark block');
  });
});
