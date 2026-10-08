import { SymbolView, type SymbolViewProps } from 'expo-symbols';

import type { ColorToken } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type IconName = Extract<SymbolViewProps['name'], string>;

type IconProps = Omit<SymbolViewProps, 'name' | 'tintColor'> & {
  /** SF Symbol name (iOS). */
  name: IconName;
  color?: ColorToken;
};

/** SF Symbol tinted by a color token. Decorative by default: label the surrounding control instead. */
export function Icon({ name, color = 'ink', size, weight = 'regular', ...rest }: IconProps) {
  const { colors, sizes } = useTheme();
  return (
    <SymbolView
      name={name}
      size={size ?? sizes.icon}
      tintColor={colors[color]}
      weight={weight}
      accessible={false}
      importantForAccessibility="no"
      {...rest}
    />
  );
}
