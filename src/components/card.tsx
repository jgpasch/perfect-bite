import { StyleSheet, View, type ViewProps } from 'react-native';

import { cardLook } from '@/components/appearance';
import type { ColorToken } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = ViewProps & {
  /** Card ground. Defaults to `surface`; the Sorting… card uses `pendingSoft`. */
  background?: ColorToken;
};

/** A soft white card, 16 pt in from the screen edge. Separate rows inside with a 1 pt `border` hairline. */
export function Card({ background = 'surface', style, ...rest }: Props) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.card,
        cardLook(background, colors),
        style,
      ]}
      {...rest}
    />
  );
}

type SliceProps = Props & {
  /** The card's first slice: its top corners are rounded. */
  top?: boolean;
  /** The card's last slice: its bottom corners are rounded. */
  bottom?: boolean;
};

/**
 * One row's piece of a `Card`, for a virtualized list whose rows are its items: the card's ground and inset,
 * with the top corners rounded on the first slice and the bottom ones on the last, so the slices stacked read
 * as one card.
 */
export function CardSlice({ background = 'surface', top = false, bottom = false, style, ...rest }: SliceProps) {
  const { colors } = useTheme();
  const { borderRadius, ...look } = cardLook(background, colors);
  return (
    <View
      style={[
        styles.card,
        look,
        top ? { borderTopLeftRadius: borderRadius, borderTopRightRadius: borderRadius } : null,
        bottom ? { borderBottomLeftRadius: borderRadius, borderBottomRightRadius: borderRadius } : null,
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden', borderCurve: 'continuous' },
});
