// EmptyState: the plain line (and one action) its older callers use, and the board C variant with a glyph
// tile, a title and stacked actions (the empty list, spec 4.1).
import { describe, expect, it, jest } from '@jest/globals';
import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Palette, Rounded, Sizes, Spacing, Typography } from '@/constants/theme';

import { EmptyState } from '../empty-state';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});

function render(element: ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
}

const texts = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === (Text as never));
const style = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style);
const textStyle = (root: ReactTestRenderer, content: string) => style(texts(root).find((n) => n.props.children === content)!);

describe('EmptyState', () => {
  it('without a title, icon or actions, is the one centred grey line and its action, as before', () => {
    const root = render(<EmptyState message="No recipes yet." action={<Text>New recipe</Text>} />);
    expect(texts(root).map((n) => n.props.children)).toEqual(['No recipes yet.', 'New recipe']);
    const line = textStyle(root, 'No recipes yet.');
    expect(line.color).toBe(Palette.light.inkSecondary);
    expect(line.fontSize).toBe(Typography.callout.fontSize);
    expect(line.textAlign).toBe('center');
    expect(root.root.findAll((n) => n.props.accessibilityRole === 'header')).toHaveLength(0);
    expect(root.root.findAll((n) => n.type === ('Icon' as never))).toHaveLength(0);
    // Dead centre, filling the space.
    const container = style(root.root.findAll((n) => n.type === ('View' as never))[0]);
    expect(container).toMatchObject({ flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.xl });
  });

  it('with them, a primarySoft glyph tile, the title as a header, the message and the actions', () => {
    const root = render(
      <EmptyState
        icon="cart"
        title="Your list is empty"
        message="Add what you need."
        actions={[<Text key="a">Add an item</Text>, <Text key="b">Add from a recipe</Text>]}
      />,
    );
    expect(texts(root).map((n) => n.props.children)).toEqual([
      'Your list is empty',
      'Add what you need.',
      'Add an item',
      'Add from a recipe',
    ]);
    const tile = root.root.find((n) => n.type === ('View' as never) && n.props.testID === 'empty-state-icon');
    expect(style(tile)).toMatchObject({
      width: Sizes.emptyIcon,
      height: Sizes.emptyIcon,
      borderRadius: Rounded.card,
      backgroundColor: Palette.light.primarySoft,
    });
    const icon = tile.find((n) => n.type === ('Icon' as never));
    expect(icon.props.name).toBe('cart');
    expect(icon.props.color).toBe('onPrimarySoft');

    const title = texts(root).find((n) => n.props.children === 'Your list is empty')!;
    expect(title.props.accessibilityRole).toBe('header');
    expect(style(title)).toMatchObject({
      fontSize: Typography.title.fontSize,
      color: Palette.light.ink,
      textAlign: 'center',
      marginTop: 20,
    });
    expect(textStyle(root, 'Add what you need.')).toMatchObject({
      fontSize: Typography.callout.fontSize,
      color: Palette.light.inkSecondary,
      textAlign: 'center',
      marginTop: Spacing.sm,
    });
    const actions = root.root.find((n) => n.type === ('View' as never) && style(n).gap === Spacing.sm);
    expect(style(actions)).toMatchObject({ marginTop: Spacing.xl, alignItems: 'center' });
    expect(actions.findAll((n) => n.type === (Text as never))).toHaveLength(2);
  });

  it('sits about 40% down, and grows with the content so large text still scrolls', () => {
    const root = render(<EmptyState icon="cart" title="Empty" message="Add something." />);
    const views = root.root.findAll((n) => n.type === ('View' as never));
    const [outer, above] = views;
    const below = views[views.length - 1];
    expect(style(outer).flexGrow).toBe(1);
    expect(style(outer).flex).toBeUndefined();
    const a = style(above).flexGrow as number;
    const b = style(below).flexGrow as number;
    expect(a / (a + b)).toBeCloseTo(0.4);
  });

  it('a title alone, with no icon or actions, draws no tile and no action stack', () => {
    const root = render(<EmptyState title="Nothing here" message="Not yet." />);
    expect(root.root.findAll((n) => n.props.testID === 'empty-state-icon')).toHaveLength(0);
    expect(root.root.findAll((n) => n.type === ('View' as never) && style(n).gap === Spacing.sm)).toHaveLength(0);
    expect(style(texts(root)[0]).marginTop).toBeUndefined();
  });
});
