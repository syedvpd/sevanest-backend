import sharp from 'sharp';
import { makeRenditions, renditionKeys, UnreadableImageError } from './photo-renditions';

const photo = (width: number, height: number, withGps = false): Promise<Buffer> => {
  const image = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 60 } },
  }).jpeg({ quality: 95 });
  return (
    withGps
      ? image.withExif({
          IFD0: { Make: 'PhoneMaker', Model: 'Phone 1' },
          IFD3: { GPSLatitudeRef: 'N' },
        })
      : image
  ).toBuffer();
};

describe('makeRenditions', () => {
  it('makes a square WebP card and a WebP large image no wider than 1080 px', async () => {
    const original = await photo(3000, 2000);
    const { card, large } = await makeRenditions(original);
    const cardMeta = await sharp(card).metadata();
    const largeMeta = await sharp(large).metadata();
    expect(cardMeta).toMatchObject({ format: 'webp', width: 320, height: 320 });
    expect(largeMeta).toMatchObject({ format: 'webp', width: 1080, height: 720 });
    expect(card.length + large.length).toBeLessThan(original.length);
  });

  it('never enlarges a small picture for the large rendition', async () => {
    const { large } = await makeRenditions(await photo(400, 300));
    expect(await sharp(large).metadata()).toMatchObject({ width: 400, height: 300 });
  });

  it('drops camera metadata (EXIF, GPS)', async () => {
    const original = await photo(800, 600, true);
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const { card, large } = await makeRenditions(original);
    expect((await sharp(card).metadata()).exif).toBeUndefined();
    expect((await sharp(large).metadata()).exif).toBeUndefined();
  });

  it('refuses bytes that are not a decodable image', async () => {
    await expect(
      makeRenditions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])),
    ).rejects.toBeInstanceOf(UnreadableImageError);
  });

  it('names renditions next to the original key', () => {
    expect(renditionKeys('photos/w1/abc')).toEqual({
      card: 'photos/w1/abc.card.webp',
      large: 'photos/w1/abc.large.webp',
    });
  });
});
