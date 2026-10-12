/**
 * Private object storage for KYC documents and profile media (DR-002, FR-SEC-003/004, BEA p9).
 * Buckets are private: access is only through short-lived signed URLs issued AFTER the caller's permission check,
 * and every issuance of a download URL for KYC material must be audited by the caller. Deletion exists ONLY to discard uploads
 * that failed validation or were never confirmed; it must never be called on a confirmed document (the retention policy for
 * those is undecided, SRS §14 item 2).
 */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface StorageProvider {
  createUploadUrl(input: {
    objectKey: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds: number;
  }): Promise<SignedUrl>;
  createDownloadUrl(input: { objectKey: string; ttlSeconds: number }): Promise<SignedUrl>;
  /** Server-side check that an object really arrived (a client may skip the upload). null = no such object. `etag` is a change signal, not a hash guarantee. */
  getObjectInfo(objectKey: string): Promise<{ sizeBytes: number; etag?: string } | null>;
  /** The stored bytes, at most `maxBytes` of them (`truncated` = the object is larger). null = no such object. */
  readObject(
    objectKey: string,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; truncated: boolean } | null>;
  /** Removes an object. Idempotent: a missing object is not an error. */
  deleteObject(objectKey: string): Promise<void>;
  /** First `length` bytes of the stored object, for server-side file-signature checks. null = no such object. */
  readObjectHead(objectKey: string, length: number): Promise<Buffer | null>;
}
