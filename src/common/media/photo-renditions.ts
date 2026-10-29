import sharp from 'sharp';

/**
 * Profile photo renditions (D-69). Every confirmed photo is re-encoded on the server, so customers download small WebP files
 * whatever the phone uploaded, and camera metadata (EXIF: GPS position, device, time) never leaves the server: sharp writes
 * no metadata unless asked to. The orientation tag is applied to the pixels first, so the picture still looks upright.
 * Sizes are presentation choices, not business rules.
 */
export const RENDITIONS = {
  /** Square crop for search cards, shortlist and home: 320 px covers 3x density at about 100 dp. */
  card: { size: 320, quality: 72 },
  /** Whole picture, longest side at most 1080 px, for the worker profile screen. */
  large: { size: 1080, quality: 78 },
} as const;

export const RENDITION_CONTENT_TYPE = 'image/webp';
/** The object behind a rendition key never changes (a new photo gets new keys), so clients and CDNs may cache it for good. */
export const RENDITION_CACHE_CONTROL = 'private, max-age=31536000, immutable';
/** Decompression-bomb guard: refuse images above about 40 megapixels before decoding them. */
const MAX_INPUT_PIXELS = 40_000_000;

export class UnreadableImageError extends Error {}

export interface Renditions {
  card: Buffer;
  large: Buffer;
}

export async function makeRenditions(original: Buffer): Promise<Renditions> {
  const input = (): sharp.Sharp =>
    sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
  try {
    const [card, large] = await Promise.all([
      input()
        .resize(RENDITIONS.card.size, RENDITIONS.card.size, { fit: 'cover', position: 'attention' })
        .webp({ quality: RENDITIONS.card.quality })
        .toBuffer(),
      input()
        .resize(RENDITIONS.large.size, RENDITIONS.large.size, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: RENDITIONS.large.quality })
        .toBuffer(),
    ]);
    return { card, large };
  } catch (error) {
    throw new UnreadableImageError((error as Error).message);
  }
}

/** Rendition keys live next to the original upload: `<original key>.card.webp`, `<original key>.large.webp`. */
export function renditionKeys(objectKey: string): { card: string; large: string } {
  return { card: `${objectKey}.card.webp`, large: `${objectKey}.large.webp` };
}
