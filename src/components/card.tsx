import { StyleSheet, View, type ViewProps } from 'react-native';

import type { ColorToken } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = ViewProps & {
  /** Card ground. Defaults to `surface`; the Sorting… card uses `pendingSoft`. */
  background?: ColorToken;
  /** Edge to edge with square corners: the list screen's add mode, where every row counts. */
  flush?: boolean;
};

/** A soft white card, 16 pt in from the screen edge. Separate rows inside with a 1 pt `border` hairline. */
export function Card({ background = 'surface', flush = false, style, ...rest }: Props) {
  const { colors, rounded, spacing } = useTheme();
  return (
    <View
      style={[
        styles.card,
        flush
          ? { backgroundColor: colors[background] }
          : { backgroundColor: colors[background], borderRadius: rounded.card, marginHorizontal: spacing.lg },
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden', borderCurve: 'continuous' },
});
