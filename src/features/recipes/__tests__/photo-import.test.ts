// Picking the pages for a photo import (spec 4.10): the library's 3-image limit and order, the
// camera's one at a time with Add another page, the downscale, and the sheet's `photos` param.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { collectImportPhotos, IMPORT_PHOTO, photosFromParam, photosParam, pickImportPhotos, type PickPagesResult } from '../photo-import';

type Picked = { canceled: boolean; assets: { uri: string }[] };
const mockPicker = {
  library: jest.fn(async (_o: object): Promise<Picked> => ({ canceled: false, assets: [{ uri: 'file:///a.heic' }] })),
  camera: jest.fn(async (_o: object): Promise<Picked> => ({ canceled: false, assets: [{ uri: 'file:///shot.jpg' }] })),
  permission: jest.fn(async () => ({ granted: true })),
};
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (o: object) => mockPicker.library(o),
  launchCameraAsync: (o: object) => mockPicker.camera(o),
  requestCameraPermissionsAsync: () => mockPicker.permission(),
}));
const mockDownscale = jest.fn(async (uri: string, _o: object) => ({ uri: `${uri}.small.jpg`, width: 2000, height: 1500 }));
jest.mock('../downscale-photo', () => ({ downscalePhoto: (uri: string, o: object) => mockDownscale(uri, o) }));

const assets = (...uris: string[]): Picked => ({ canceled: false, assets: uris.map((uri) => ({ uri })) });

beforeEach(() => {
  mockPicker.library.mockClear();
  mockPicker.camera.mockClear();
  mockPicker.permission.mockReset().mockResolvedValue({ granted: true });
  mockDownscale.mockClear();
});

describe('pickImportPhotos', () => {
  test('the library allows up to 3 in the order picked, without cropping', async () => {
    await pickImportPhotos('library');
    expect(mockPicker.library).toHaveBeenCalledWith({
      mediaTypes: 'images',
      allowsMultipleSelection: true,
      selectionLimit: 3,
      orderedSelection: true,
      quality: 1,
    });
  });

  test('each page is downscaled to 2000 px at quality 0.8, in order', async () => {
    mockPicker.library.mockResolvedValueOnce(assets('file:///p2.jpg', 'file:///p1.png', 'file:///p3.heic'));
    expect(await pickImportPhotos('library')).toEqual({
      ok: true,
      uris: ['file:///p2.jpg.small.jpg', 'file:///p1.png.small.jpg', 'file:///p3.heic.small.jpg'],
    });
    expect(IMPORT_PHOTO).toEqual({ longEdge: 2000, quality: 0.8 });
    expect(mockDownscale.mock.calls).toEqual([
      ['file:///p2.jpg', { longEdge: 2000, quality: 0.8 }],
      ['file:///p1.png', { longEdge: 2000, quality: 0.8 }],
      ['file:///p3.heic', { longEdge: 2000, quality: 0.8 }],
    ]);
  });

  test('more than the limit back from the picker keeps the first ones', async () => {
    mockPicker.library.mockResolvedValueOnce(assets('file:///1', 'file:///2', 'file:///3', 'file:///4'));
    const result = await pickImportPhotos('library');
    expect(result).toEqual({ ok: true, uris: ['file:///1.small.jpg', 'file:///2.small.jpg', 'file:///3.small.jpg'] });
  });

  test('a smaller limit (pages already taken) narrows the library; one left is a single pick', async () => {
    await pickImportPhotos('library', 2);
    expect(mockPicker.library.mock.calls[0][0]).toMatchObject({ allowsMultipleSelection: true, selectionLimit: 2 });
    await pickImportPhotos('library', 1);
    expect(mockPicker.library.mock.calls[1][0]).toMatchObject({ allowsMultipleSelection: false, selectionLimit: 1 });
  });

  test('a limit over 3 is still 3; none left picks nothing', async () => {
    await pickImportPhotos('library', 10);
    expect(mockPicker.library.mock.calls[0][0]).toMatchObject({ selectionLimit: 3 });
    expect(await pickImportPhotos('library', 0)).toEqual({ ok: false, reason: 'cancelled' });
    expect(mockPicker.library).toHaveBeenCalledTimes(1);
  });

  test('the camera asks for access and takes one photo', async () => {
    expect(await pickImportPhotos('camera')).toEqual({ ok: true, uris: ['file:///shot.jpg.small.jpg'] });
    expect(mockPicker.permission).toHaveBeenCalledTimes(1);
    expect(mockPicker.camera).toHaveBeenCalledWith({ mediaTypes: 'images', quality: 1 });
  });

  test('camera access refused: denied, and the camera never opens', async () => {
    mockPicker.permission.mockResolvedValueOnce({ granted: false });
    expect(await pickImportPhotos('camera')).toEqual({ ok: false, reason: 'denied' });
    expect(mockPicker.camera).not.toHaveBeenCalled();
  });

  test('backing out is cancelled, with nothing downscaled', async () => {
    mockPicker.library.mockResolvedValueOnce({ canceled: true, assets: [] });
    expect(await pickImportPhotos('library')).toEqual({ ok: false, reason: 'cancelled' });
    expect(mockDownscale).not.toHaveBeenCalled();
  });
});

describe('collectImportPhotos', () => {
  const picks = (...results: PickPagesResult[]) => {
    const pick = jest.fn(async (_from: string, _limit?: number) => results.shift() ?? { ok: false as const, reason: 'cancelled' as const });
    return pick;
  };

  test('the library: one pick, no question', async () => {
    const pick = picks({ ok: true, uris: ['a', 'b'] });
    const askForAnother = jest.fn(async () => true);
    expect(await collectImportPhotos('library', { pick, askForAnother, onDenied: jest.fn() })).toEqual(['a', 'b']);
    expect(pick.mock.calls).toEqual([['library', 3]]);
    expect(askForAnother).not.toHaveBeenCalled();
  });

  test('the camera: Add another page takes another, up to 3, then stops without asking', async () => {
    const pick = picks({ ok: true, uris: ['p1'] }, { ok: true, uris: ['p2'] }, { ok: true, uris: ['p3'] });
    const askForAnother = jest.fn(async (_pages: number) => true);
    expect(await collectImportPhotos('camera', { pick, askForAnother, onDenied: jest.fn() })).toEqual(['p1', 'p2', 'p3']);
    expect(pick.mock.calls).toEqual([
      ['camera', 3],
      ['camera', 2],
      ['camera', 1],
    ]);
    expect(askForAnother.mock.calls).toEqual([[1], [2]]);
  });

  test('the camera: Use photos stops after the first', async () => {
    const pick = picks({ ok: true, uris: ['p1'] });
    const askForAnother = jest.fn(async () => false);
    expect(await collectImportPhotos('camera', { pick, askForAnother, onDenied: jest.fn() })).toEqual(['p1']);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  test('a limit (the review sheet, with pages already) caps the picks and stops asking at it', async () => {
    const pick = picks({ ok: true, uris: ['p1'] }, { ok: true, uris: ['p2'] });
    const askForAnother = jest.fn(async (_pages: number) => true);
    expect(await collectImportPhotos('camera', { pick, askForAnother, onDenied: jest.fn(), limit: 2 })).toEqual(['p1', 'p2']);
    expect(pick.mock.calls).toEqual([
      ['camera', 2],
      ['camera', 1],
    ]);
    expect(askForAnother.mock.calls).toEqual([[1]]);

    const library = picks({ ok: true, uris: ['a', 'b', 'c'] });
    expect(await collectImportPhotos('library', { pick: library, askForAnother, onDenied: jest.fn(), limit: 1 })).toEqual(['a']);
    expect(library.mock.calls).toEqual([['library', 1]]);
  });

  test('no room left (a limit of 0) picks nothing', async () => {
    const pick = picks({ ok: true, uris: ['p1'] });
    expect(await collectImportPhotos('library', { pick, askForAnother: async () => true, onDenied: jest.fn(), limit: 0 })).toBeNull();
    expect(pick).not.toHaveBeenCalled();
  });

  test('a cancelled second shot keeps the first page', async () => {
    const pick = picks({ ok: true, uris: ['p1'] }, { ok: false, reason: 'cancelled' });
    expect(await collectImportPhotos('camera', { pick, askForAnother: async () => true, onDenied: jest.fn() })).toEqual(['p1']);
  });

  test('nothing picked is null; refused camera access says so', async () => {
    const onDenied = jest.fn();
    expect(await collectImportPhotos('library', { pick: picks({ ok: false, reason: 'cancelled' }), askForAnother: async () => true, onDenied })).toBeNull();
    expect(onDenied).not.toHaveBeenCalled();
    expect(await collectImportPhotos('camera', { pick: picks({ ok: false, reason: 'denied' }), askForAnother: async () => true, onDenied })).toBeNull();
    expect(onDenied).toHaveBeenCalledTimes(1);
  });
});

describe('the photos param', () => {
  test('round-trips the pages in order', () => {
    const pages = ['file:///cache/a.jpg', 'file:///cache/b,c.jpg'];
    expect(photosFromParam(photosParam(pages))).toEqual(pages);
  });

  test.each([undefined, '', 'not json', '"file:///a.jpg"', '[]', '["a","b","c","d"]', '[1]', '[""]', '{"0":"a"}'])(
    '%p is no photos',
    (param) => {
      expect(photosFromParam(param)).toBeNull();
    },
  );
});
