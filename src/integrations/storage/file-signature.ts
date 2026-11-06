/**
 * Server-side file-signature check for KYC documents. The client-declared content type is never trusted: the first bytes of
 * the stored object must match the declared type. Only the three accepted types exist (VERIFICATION_DOCUMENT_CONTENT_TYPES is
 * validated against this list); an unknown type fails closed.
 */
const SIGNATURES: Record<string, Buffer> = {
  'application/pdf': Buffer.from('%PDF-', 'latin1'),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

/** Container types whose first bytes are a plain prefix are listed above; WebP needs two markers (RIFF....WEBP). */
const WEBP_CONTENT_TYPE = 'image/webp';

function matchesWebp(head: Buffer): boolean {
  return (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  );
}

/** Number of leading bytes needed to recognise every supported signature (WebP needs RIFF at 0 and WEBP at 8). */
export const SIGNATURE_BYTES = 12;

export function signatureFor(contentType: string): Buffer | undefined {
  return SIGNATURES[contentType];
}

export function matchesDeclaredType(contentType: string, head: Buffer): boolean {
  if (contentType === WEBP_CONTENT_TYPE) return matchesWebp(head);
  const signature = SIGNATURES[contentType];
  return (
    signature !== undefined &&
    head.length >= signature.length &&
    head.subarray(0, signature.length).equals(signature)
  );
}

/** The profile-photo formats the server can safely re-encode. */
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', WEBP_CONTENT_TYPE] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/**
 * The real type of an image, read from its bytes only. The client's declared MIME type and filename are ignored: a
 * script renamed to `.png` is not an image, and a JPEG sent as `image/png` is reported as `image/jpeg` here. null =
 * not one of the accepted image formats.
 */
export function detectImageType(bytes: Buffer): ImageContentType | null {
  for (const type of IMAGE_CONTENT_TYPES) {
    if (matchesDeclaredType(type, bytes)) return type;
  }
  return null;
}

export type ContentCheck =
  { ok: true } | { ok: false; reason: 'EMPTY' | 'SIGNATURE' | 'TRUNCATED' };

const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * Whole-file check of an uploaded object: the declared type's signature at the start AND the end-of-file marker of that format, so
 * a file cut short in transit (or a bare signature followed by junk) is refused. This is structural validation only - it is NOT a
 * malware scan and does not parse the document; a polyglot file with valid markers passes. Unknown types fail closed.
 */
export function validateContent(contentType: string, bytes: Buffer): ContentCheck {
  if (bytes.length === 0) return { ok: false, reason: 'EMPTY' };
  if (!matchesDeclaredType(contentType, bytes)) return { ok: false, reason: 'SIGNATURE' };
  switch (contentType) {
    case 'application/pdf':
      // The trailer marker must appear in the last KiB (PDF allows trailing whitespace/garbage after %%EOF).
      return bytes.subarray(Math.max(0, bytes.length - 1024)).includes('%%EOF', 0, 'latin1')
        ? { ok: true }
        : { ok: false, reason: 'TRUNCATED' };
    case 'image/jpeg':
      return bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9]))
        ? { ok: true }
        : { ok: false, reason: 'TRUNCATED' };
    case 'image/png':
      return bytes.length >= 20 && bytes.subarray(bytes.length - 12).equals(PNG_IEND)
        ? { ok: true }
        : { ok: false, reason: 'TRUNCATED' };
    case WEBP_CONTENT_TYPE:
      // A RIFF container declares its own byte length: a file cut short cannot match it.
      return bytes.length >= 12 && bytes.readUInt32LE(4) === bytes.length - 8
        ? { ok: true }
        : { ok: false, reason: 'TRUNCATED' };
    default:
      return { ok: false, reason: 'SIGNATURE' };
  }
}

/** A minimal file of exactly `size` bytes that passes validateContent (test and in-memory storage helper). */
export function buildSampleFile(contentType: string, size: number): Buffer {
  if (contentType === WEBP_CONTENT_TYPE && size >= 16) {
    const file = Buffer.alloc(size);
    file.write('RIFF', 0, 'latin1');
    file.writeUInt32LE(size - 8, 4);
    file.write('WEBP', 8, 'latin1');
    file.write('VP8 ', 12, 'latin1');
    return file;
  }
  const signature = SIGNATURES[contentType] ?? Buffer.alloc(0);
  const tail =
    contentType === 'application/pdf'
      ? Buffer.from('\n%%EOF\n', 'latin1')
      : contentType === 'image/jpeg'
        ? Buffer.from([0xff, 0xd9])
        : contentType === 'image/png'
          ? PNG_IEND
          : Buffer.alloc(0);
  if (size < signature.length + tail.length) return signature.subarray(0, size);
  const fill = Buffer.alloc(
    size - signature.length - tail.length,
    contentType === 'application/pdf' ? 0x20 : 0,
  );
  return Buffer.concat([signature, fill, tail]);
}
