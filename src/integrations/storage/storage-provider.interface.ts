/**
 * Private object storage for KYC documents and profile media (DR-002, FR-SEC-003/004, BEA p9).
 * Buckets are private: access is only through short-lived signed URLs issued AFTER the caller's permission check,
 * and every issuance of a download URL for KYC material must be audited by the caller. No object deletion is exposed
 * until the retention policy exists (SRS §14 item 2).
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
  /** Server-side check that an object really arrived (a client may skip the upload). null = no such object. */
  getObjectInfo(objectKey: string): Promise<{ sizeBytes: number } | null>;
}
