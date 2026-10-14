// The recipe photo (boards 13 and 18): the card's tile and the recipe screen's header, with the icon
// tile or the band's tint as the placeholder and a permanent fallback when the photo fails to load.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { IconTile } from '@/components/icon-tile';
import { recipeHue } from '@/domain/aisle-color';
import { Rounded as rounded, Sizes as sizes } from '@/constants/theme';

import { RecipePhotoHeader, RecipePhotoTile } from '../recipe-photo';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-image', () => {
  const { createElement } = require('react');
  return { Image: (props: object) => createElement('ExpoImage', props) };
});

const URL = 'https://example.com/tacos.jpg';
let tree: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(element);
  });
  return tree!;
}

const images = (root: ReactTestRenderer) => root.root.findAll((n) => String(n.type) === 'ExpoImage');
const tiles = (root: ReactTestRenderer) => root.root.findAll((n) => n.type === IconTile);
const flatStyle = (style: unknown) => Object.assign({}, ...[style].flat(Infinity as 1));

describe('RecipePhotoTile', () => {
  test('without an imageUrl: the icon tile only, in the recipe hue', () => {
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={null} />);
    expect(images(root)).toHaveLength(0);
    const [tile] = tiles(root);
    expect([tile.props.hue, tile.props.name, tile.props.size]).toEqual([recipeHue('r1'), 'fork.knife', sizes.recipeTile]);
  });

  test('with an imageUrl: the photo covers the tile at its radius, cached on disk, the tile underneath', () => {
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={URL} />);
    const [image] = images(root);
    expect([image.props.source, image.props.contentFit, image.props.cachePolicy]).toEqual([URL, 'cover', 'disk']);
    expect(flatStyle(image.props.style)).toMatchObject({ position: 'absolute', borderRadius: rounded.md });
    // The placeholder while it loads.
    expect(tiles(root)).toHaveLength(1);
  });

  test('is hidden from VoiceOver', () => {
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={URL} />);
    expect(images(root)[0].props.accessible).toBe(false);
    const wrapper = root.root.findAll((n) => String(n.type) === 'View' && n.props.accessibilityElementsHidden === true);
    expect(wrapper).toHaveLength(1);
    expect(wrapper[0].props.importantForAccessibility).toBe('no-hide-descendants');
  });

  test('onError falls back to the icon tile, and stays there', () => {
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={URL} />);
    act(() => images(root)[0].props.onError({ error: '403' }));
    expect(images(root)).toHaveLength(0);
    expect(tiles(root)).toHaveLength(1);
    act(() => root.update(<RecipePhotoTile recipeId="r1" imageUrl={URL} />));
    expect(images(root)).toHaveLength(0);
  });

  test('a new imageUrl after a failure gets its own try', () => {
    const root = render(<RecipePhotoTile recipeId="r1" imageUrl={URL} />);
    act(() => images(root)[0].props.onError({ error: '404' }));
    act(() => root.update(<RecipePhotoTile recipeId="r1" imageUrl="https://example.com/new.jpg" />));
    expect(images(root).map((i) => i.props.source)).toEqual(['https://example.com/new.jpg']);
  });
});

describe('RecipePhotoHeader', () => {
  test('full width at 16:9 in the band tint, the photo covering it, cached on disk, hidden from VoiceOver', () => {
    const onError = jest.fn();
    const root = render(<RecipePhotoHeader imageUrl={URL} tint="#FBE3E6" onError={onError} />);
    const header = root.root.find((n) => String(n.type) === 'View' && n.props.accessibilityElementsHidden === true);
    expect(flatStyle(header.props.style)).toMatchObject({ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#FBE3E6' });
    expect(header.props.importantForAccessibility).toBe('no-hide-descendants');
    const [image] = images(root);
    expect([image.props.source, image.props.contentFit, image.props.cachePolicy, image.props.accessible]).toEqual([
      URL,
      'cover',
      'disk',
      false,
    ]);
    act(() => image.props.onError({ error: '404' }));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
