/**
 * Theme tokens for the current color scheme. Light/dark follows the system setting.
 * https://docs.expo.dev/guides/color-schemes/
 */

import {
  AisleColors,
  Motion,
  Opacity,
  Palette,
  Rounded,
  Shadows,
  Sizes,
  Spacing,
  Typography,
  type ColorScheme,
} from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme() {
  const raw = useColorScheme();
  const scheme: ColorScheme = raw === 'dark' ? 'dark' : 'light';

  return {
    scheme,
    colors: Palette[scheme],
    /** Aisle colours by hue; pick the hue with `aisleColor(slug)`. */
    aisles: AisleColors[scheme],
    typography: Typography,
    spacing: Spacing,
    rounded: Rounded,
    shadows: Shadows,
    sizes: Sizes,
    motion: Motion,
    opacity: Opacity,
  };
}

export type Theme = ReturnType<typeof useTheme>;
