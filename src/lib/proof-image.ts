import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

export const PROOF_WIDTH = 1080;
export const PROOF_QUALITY = 0.7;

/** Resizes a capture to 1080 px wide JPEG at quality 0.7 (about 150–300 KB). */
export async function prepareProof(uri: string): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  context.resize({ width: PROOF_WIDTH });
  const image = await context.renderAsync();
  const result = await image.saveAsync({ compress: PROOF_QUALITY, format: SaveFormat.JPEG });
  return result.uri;
}
