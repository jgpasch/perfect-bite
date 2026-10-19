// Drift guard for the admin portal (spec 4.12). Jest ignores `admin/`, so this reads its files as
// text: the portal's feature map must name exactly the app's features, and its tokens.css must
// carry every colour of the app's theme, so changing either without the portal fails here.
import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
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
