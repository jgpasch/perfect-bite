// Shrinking a photo before upload (spec 4.5): longer side at most `longEdge`, JPEG at `quality`.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { downscalePhoto, UPLOAD_PHOTO } from '../downscale-photo';

type Image = { width: number; height: number; saveAsync: jest.Mock };
const mockCalls = { manipulate: [] as unknown[], resize: [] as object[] };
const mockImages: { original: Image | null; resized: Image | null } = { original: null, resized: null };

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: {
    manipulate: (source: unknown) => {
      mockCalls.manipulate.push(source);
      let resized = false;
      const context = {
        resize: (size: object) => {
          mockCalls.resize.push(size);
          resized = true;
          return context;
        },
        renderAsync: async () => (resized ? mockImages.resized : mockImages.original),
      };
      return context;
    },
  },
}));

const image = (width: number, height: number): Image => ({
  width,
  height,
  saveAsync: jest.fn(async () => ({ uri: `file:///cache/${width}x${height}.jpg`, width, height })),
});

beforeEach(() => {
  mockCalls.manipulate.length = 0;
  mockCalls.resize.length = 0;
  mockImages.resized = null;
});

describe('downscalePhoto', () => {
  test("upload's parameters: 1600 px on the long edge, quality 0.8", () => {
    expect(UPLOAD_PHOTO).toEqual({ longEdge: 1600, quality: 0.8 });
  });

  test('a landscape photo is resized to 1600 wide and saved as JPEG at 0.8', async () => {
    mockImages.original = image(4032, 3024);
    mockImages.resized = image(1600, 1200);
    expect(await downscalePhoto('file:///p.heic', UPLOAD_PHOTO)).toEqual({ uri: 'file:///cache/1600x1200.jpg', width: 1600, height: 1200 });
    expect(mockCalls.resize).toEqual([{ width: 1600 }]);
    expect(mockCalls.manipulate).toEqual(['file:///p.heic', mockImages.original]);
    expect(mockImages.resized.saveAsync).toHaveBeenCalledWith({ compress: 0.8, format: 'jpeg' });
    expect(mockImages.original.saveAsync).not.toHaveBeenCalled();
  });

  test('a portrait photo is resized by its height', async () => {
    mockImages.original = image(3024, 4032);
    mockImages.resized = image(1200, 1600);
    await downscalePhoto('file:///p.jpg', UPLOAD_PHOTO);
    expect(mockCalls.resize).toEqual([{ height: 1600 }]);
  });

  test('a square photo is resized by its width', async () => {
    mockImages.original = image(2000, 2000);
    mockImages.resized = image(1600, 1600);
    await downscalePhoto('file:///p.jpg', UPLOAD_PHOTO);
    expect(mockCalls.resize).toEqual([{ width: 1600 }]);
  });

  test('a photo already small enough keeps its size but is still re-encoded as JPEG', async () => {
    mockImages.original = image(1600, 900);
    expect(await downscalePhoto('file:///p.png', { longEdge: 1600, quality: 0.5 })).toEqual({
      uri: 'file:///cache/1600x900.jpg',
      width: 1600,
      height: 900,
    });
    expect(mockCalls.resize).toEqual([]);
    expect(mockImages.original.saveAsync).toHaveBeenCalledWith({ compress: 0.5, format: 'jpeg' });
  });

  test('an image that cannot be read throws', async () => {
    mockImages.original = { width: 10, height: 10, saveAsync: jest.fn(async () => Promise.reject(new Error('bad image'))) };
    await expect(downscalePhoto('file:///p.jpg', UPLOAD_PHOTO)).rejects.toThrow('bad image');
  });
});
