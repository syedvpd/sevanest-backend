# Worker Photo Module

## 1. Executive Summary

The Worker Photo module facilitates verified profile picture onboarding for domestic workers. Profile pictures establish crucial customer trust and visual safety during home service visits. The module provisions presigned upload tunnels to object storage, conducts strict binary and MIME signature validation, strips sensitive GPS and EXIF metadata, generates standardized WebP thumbnail and profile renditions via image processing pipelines, and delivers privacy-preserving signed URLs throughout worker discovery and booking journeys.

---

## 2. Core Features & Capabilities

* **Presigned Cloud Uploads:** Issues direct-to-cloud presigned upload URLs with configurable size ceilings, preventing heavy binary payload buffering on backend instances.
* **Format & Signature Verification:** Analyzes binary headers (magic bytes) to strictly enforce genuine JPEG and PNG formats, defending against spoofed extensions and unauthorized payloads.
* **Automated Image Renditions:** Generates multiple standardized WebP renditions (cards, detail views, avatar icons) to optimize network bandwidth for mobile clients across varied network conditions.
* **EXIF & Privacy Sanitization:** Automatically removes embedded GPS coordinates, camera models, and private device metadata before photos become accessible.
* **Immutable Versioning & Lifecycle Cleanup:** Prior approved photos are smoothly transitioned or cleanly purged upon new photo confirmation, with unconfirmed uploads discarded after expiration.

---

## 3. End-to-End Worker Photo Workflow

```
[ Worker App ]             [ SevaNest API ]           [ Cloud Storage ]
       |                          |                          |
       | 1. Request Upload URL    |                          |
       |------------------------->|                          |
       |                          | Generate Presigned URL   |
       | 2. Return URL & Photo ID |                          |
       |<-------------------------|                          |
       |                                                     |
       | 3. Direct Binary Upload (PUT)                       |
       |---------------------------------------------------->|
       |                                                     |
       | 4. Confirm Upload (photoId)                         |
       |------------------------->|                          |
       |                          | 5. Verify Magic Bytes    |
       |                          |    Strip EXIF / Metadata |
       |                          |    Generate WebP Rends   |
       |                          |    Promote to Current    |
       | 6. Confirmation: READY   |                          |
       |<-------------------------|                          |
       |                                                     |
       | 7. Request Worker Photo  |                          |
       |------------------------->|                          |
       |                          | 8. Generate Signed Link  |
       | 9. Download URL + Key    |                          |
       |<-------------------------|                          |
```

---

## 4. API Endpoints & Contracts

* **`POST /api/v1/workers/me/photo`**  
  * **Role:** Worker (`WORKER`)  
  * **Summary:** Request an authorized short-lived presigned URL to upload a profile photograph.  
  * **Payload:** `{ contentType: "image/jpeg" | "image/png", byteSize: number }`  
  * **Response:** `{ photoId: string, uploadUrl: string, expiresAt: string }`

* **`POST /api/v1/workers/me/photo/:photoId/confirm`**  
  * **Role:** Worker (`WORKER`)  
  * **Summary:** Finalize upload; verifies binary signatures, renders WebP image assets, and assigns the photo to the worker profile.  
  * **Response:** `{ photoId: string, status: "READY" }`

* **`GET /api/v1/workers/me/photo`**  
  * **Role:** Worker (`WORKER`)  
  * **Summary:** Fetch the current signed photo URL, thumbnail rendition, and caching key for the authenticated worker.  
  * **Response:** `{ url: string, largeUrl?: string, cacheKey: string, expiresAt: string }`

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                     Worker Photo Module                      |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Workers / Discovery   |                   | Cloud Storage    |
| Profile Cards, Search |                   | S3-Compatible    |
| & Booking Workflows   |                   | Renditions Bucket|
+-----------------------+                   +------------------+
```

* **Integration with Discovery & Verification:** Verified worker photos automatically populate search cards, shortlist previews, and customer booking management views.
* **Separation of Image Processing:** Image transformation pipelines convert uploaded raw bytes into cached WebP renditions asynchronously or upon confirmation, safeguarding cluster CPU availability.

---

## 6. Public links (D-93)

When `STORAGE_S3_PUBLIC_BUCKET` and `STORAGE_PUBLIC_BASE_URL` are set, new photo renditions are written to the public bucket (keys start `pub/`) and `url` / `largeUrl` are permanent links that never change until the photo is replaced; `cacheKey` is the image cache key. The original upload and every KYC document stay private. Photos confirmed before the switch keep signed links.
