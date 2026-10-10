import { SymbolView } from 'expo-symbols';
import { StyleSheet, View } from 'react-native';

import type { IconName } from '@/components/icon';
import type { AisleHue } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  /** The tint: the aisle's hue, or `recipeHue(recipe.id)`. */
  hue: AisleHue;
  name: IconName;
  /** The tile's side; defaults to `sizes.iconWell` (36). */
  size?: number;
};

/** A rounded icon well in an aisle hue's soft tint, with the glyph in its `dot` colour. Decorative. */
export function IconTile({ hue, name, size }: Props) {
  const { aisles, sizes, rounded } = useTheme();
  const side = size ?? sizes.iconWell;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[styles.tile, { width: side, height: side, borderRadius: rounded.md, backgroundColor: aisles[hue].soft }]}>
      <SymbolView name={name} size={Math.round(side * 0.55)} tintColor={aisles[hue].dot} weight="semibold" />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
});
