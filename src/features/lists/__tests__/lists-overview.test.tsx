import { describe, expect, it, jest } from '@jest/globals';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { listsOverview } from '../list-view';
import { ListsOverviewGrid } from '../lists-overview';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));

type Tile = { id: string; name: string; householdId: string };
const tiles: Tile[] = [
  { id: 'a', name: 'Groceries', householdId: 'h1' },
  { id: 'b', name: 'Groceries', householdId: 'h2' },
  { id: 'c', name: 'HEB', householdId: 'h2' },
];

function render(householdRows: { id: string; name: string }[], lists: Tile[], onNewList = jest.fn()) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ListsOverviewGrid
        overview={listsOverview(householdRows, lists, householdRows[0]?.id ?? null)}
        renderTile={(l) => <Text key={l.id}>{l.name}</Text>}
        onNewList={onNewList}
      />,
    );
  });
  const headers = tree.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'header');
  const newTiles = tree.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === 'New list');
  return { tree, headers, newTiles, onNewList };
}

describe('ListsOverviewGrid', () => {
  it('shows one household without any household UI', () => {
    const { tree, headers, newTiles, onNewList } = render([{ id: 'h1', name: 'Peacher Paschal Fam' }], tiles.slice(0, 1));
    expect(headers).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).not.toContain('Peacher Paschal Fam');
    expect(newTiles).toHaveLength(1);
    act(() => newTiles[0].props.onClick?.() ?? newTiles[0].props.onPress?.());
    expect(onNewList).toHaveBeenCalledWith('h1');
  });

  it('shows a header per household, all open, with a New list tile for each', () => {
    const { headers, newTiles, onNewList } = render(
      [
        { id: 'h1', name: 'Peacher Paschal Fam' },
        { id: 'h2', name: 'test fam' },
      ],
      tiles,
    );
    expect(headers.map((h) => h.props.accessibilityLabel)).toEqual(['Peacher Paschal Fam', 'test fam']);
    expect(newTiles).toHaveLength(2);
    act(() => newTiles[1].props.onClick?.() ?? newTiles[1].props.onPress?.());
    expect(onNewList).toHaveBeenCalledWith('h2');
  });
});
