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

/** Number of leading bytes needed to recognise every supported signature. */
export const SIGNATURE_BYTES = 8;

export function signatureFor(contentType: string): Buffer | undefined {
  return SIGNATURES[contentType];
}

export function matchesDeclaredType(contentType: string, head: Buffer): boolean {
  const signature = SIGNATURES[contentType];
  return (
    signature !== undefined &&
    head.length >= signature.length &&
    head.subarray(0, signature.length).equals(signature)
  );
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
    default:
      return { ok: false, reason: 'SIGNATURE' };
  }
}

/** A minimal file of exactly `size` bytes that passes validateContent (test and in-memory storage helper). */
export function buildSampleFile(contentType: string, size: number): Buffer {
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
