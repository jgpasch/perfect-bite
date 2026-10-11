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

const styles = StyleSheet.create({
  card: { overflow: 'hidden', borderCurve: 'continuous' },
});
