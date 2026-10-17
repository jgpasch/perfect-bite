/**
 * Theme tokens for the current color scheme. Light/dark follows the system setting.
 * https://docs.expo.dev/guides/color-schemes/
 */

import {
  AisleColors,
  Motion,
  Opacity,
  Palette,
  PhotoScrim,
  PhotoViewer,
  Rounded,
  Shadows,
  Sizes,
  Spacing,
  typographyFor,
  type ColorScheme,
} from '@/constants/theme';
import { useFontSet } from '@/hooks/font-set';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme() {
  const raw = useColorScheme();
  const scheme: ColorScheme = raw === 'dark' ? 'dark' : 'light';
  const fontSet = useFontSet();

  return {
    scheme,
    colors: Palette[scheme],
    /** Aisle colours by hue; pick the hue with `aisleColor(slug)`. */
    aisles: AisleColors[scheme],
    /** In the device's font set (Settings > Design trials > Fonts). */
    typography: typographyFor(fontSet),
    spacing: Spacing,
    rounded: Rounded,
    shadows: Shadows,
    sizes: Sizes,
    motion: Motion,
    opacity: Opacity,
    /** The band under a name on a photo; the same in both schemes. */
    photoScrim: PhotoScrim,
    /** The full-screen photo viewer's ground; the same in both schemes. */
    photoViewer: PhotoViewer,
  };
}

export type Theme = ReturnType<typeof useTheme>;
