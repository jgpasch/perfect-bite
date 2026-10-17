// Clearing expo-image's caches of recipe photos (spec 4.5): both caches, and never a throw.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { clearPhotoCache } from '../photo-cache';

const mockClearDisk = jest.fn<() => Promise<boolean>>();
const mockClearMemory = jest.fn<() => Promise<boolean>>();

jest.mock('expo-image', () => ({
  Image: { clearDiskCache: () => mockClearDisk(), clearMemoryCache: () => mockClearMemory() },
}));

beforeEach(() => {
  mockClearDisk.mockReset().mockResolvedValue(true);
  mockClearMemory.mockReset().mockResolvedValue(true);
});

describe('clearPhotoCache', () => {
  test('clears the disk and the memory cache, once each', async () => {
    await expect(clearPhotoCache()).resolves.toBeUndefined();
    expect(mockClearDisk).toHaveBeenCalledTimes(1);
    expect(mockClearMemory).toHaveBeenCalledTimes(1);
  });

  test('a failure is logged, not thrown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('disk busy');
    mockClearDisk.mockRejectedValue(error);

    await expect(clearPhotoCache()).resolves.toBeUndefined();

    expect(mockClearMemory).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[photos] clearing the image cache failed', error);
    warn.mockRestore();
  });
});
