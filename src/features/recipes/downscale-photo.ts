// Shrinking a photo on the device before it's uploaded (spec 4.5): the recipe-photos bucket takes
// JPEGs of at most 2 MB, and a phone photo is several times that.
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export type DownscaleOptions = {
  /** The longer side's most pixels; a smaller photo keeps its size. */
  longEdge: number;
  /** JPEG quality, 0–1. */
  quality: number;
};

export type DownscaledPhoto = { uri: string; width: number; height: number };

/** The photo for upload's: what the Choose a photo sheet's Photo library and Take photo use. */
export const UPLOAD_PHOTO: DownscaleOptions = { longEdge: 1600, quality: 0.8 };

/**
 * Re-encodes the image at `uri` as a JPEG in the cache directory, its longer side at most
 * `longEdge`, keeping its proportions. Throws if the image can't be read.
 */
export async function downscalePhoto(uri: string, { longEdge, quality }: DownscaleOptions): Promise<DownscaledPhoto> {
  let image = await ImageManipulator.manipulate(uri).renderAsync();
  if (Math.max(image.width, image.height) > longEdge) {
    const size = image.width >= image.height ? { width: longEdge } : { height: longEdge };
    image = await ImageManipulator.manipulate(image).resize(size).renderAsync();
  }
  const saved = await image.saveAsync({ compress: quality, format: SaveFormat.JPEG });
  return { uri: saved.uri, width: saved.width, height: saved.height };
}
