# Customer Photo Module

## 1. Executive Summary

The Customer Photo module manages the secure upload, content validation, processing, and retrieval of customer profile photos. To maintain high throughput and minimize server memory consumption, uploads are handled through secure, short-lived presigned object storage URLs with direct client-to-storage transfer. The module verifies image integrity, enforces strict size and file signature checks, normalizes images into modern web formats, and ensures automated lifecycle management including orphan cleanup and privacy-compliant data erasure.

---

## 2. Core Features & Capabilities

* **Presigned Direct-to-Storage Uploads:** Generates time-bounded, cryptographically signed upload URLs, allowing mobile and web clients to transmit binary image data directly to cloud storage without burdening the application server.
* **Strict Binary & Security Validation:** Enforces magic byte inspection, MIME-type validation (JPEG, PNG), malware scanning, and size boundaries to eliminate payload tampering and security threats.
* **Image Rendition Pipeline:** Strips EXIF/metadata for privacy, normalizes image orientation, and converts assets to optimized WebP formats for high-performance mobile rendering.
* **Orphan Discard & Lifecycle Erasure:** Unconfirmed upload reservations are automatically pruned after 24 hours. Full erasure hooks integrate with privacy workflows to sanitize storage on account deletion.
* **Safe Private Delivery:** Produces time-limited signed download URLs with client-side cache keys to optimize CDN and mobile cache performance while preventing unauthorized hotlinking.

---

## 3. End-to-End Customer Photo Workflow

```
[ Customer App ]           [ SevaNest API ]           [ Cloud Storage ]
       |                          |                          |
       | 1. Request Upload URL    |                          |
       |------------------------->|                          |
       |                          | Generate Presigned URL   |
       | 2. Return URL & Photo ID |                          |
       |<-------------------------|                          |
       |                                                     |
       | 3. Direct Binary PUT (JPEG / PNG)                   |
       |---------------------------------------------------->|
       |                                                     |
       | 4. Confirm Upload (photoId)                         |
       |------------------------->|                          |
       |                          | 5. Validate Magic Bytes  |
       |                          |    & Sanitize Metadata   |
       |                          |    Generate WebP Variant |
       |                          |    Mark Status: READY    |
       | 6. Confirmation Complete |                          |
       |<-------------------------|                          |
       |                                                     |
       | 7. Request Current Photo |                          |
       |------------------------->|                          |
       |                          | 8. Generate Signed Link  |
       | 9. Photo URL + Cache Key |                          |
       |<-------------------------|                          |
```

---

## 4. API Endpoints & Contracts

* **`POST /api/v1/customers/me/photo`**  
  * **Role:** Customer (`CUSTOMER`)  
  * **Summary:** Request a short-lived presigned URL to upload a new profile picture.  
  * **Payload:** `{ contentType: "image/jpeg" | "image/png", byteSize: number }`  
  * **Response:** `{ photoId: string, uploadUrl: string, expiresAt: string }`

* **`POST /api/v1/customers/me/photo/:photoId/confirm`**  
  * **Role:** Customer (`CUSTOMER`)  
  * **Summary:** Finalize upload after direct cloud storage transfer; triggers file signature verification and WebP conversion.  
  * **Response:** `{ photoId: string, status: "READY" }`

* **`GET /api/v1/customers/me/photo`**  
  * **Role:** Customer (`CUSTOMER`)  
  * **Summary:** Retrieve a short-lived signed download link and cache key for the active customer photo.  
  * **Response:** `{ url: string, cacheKey: string, expiresAt: string }`

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                     Customer Photo Module                    |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Cloud Storage (S3)    |                   | Retention Worker |
| Presigned I/O & Assets|                   | 24h Clean-up &   |
|                       |                   | Privacy Erasure  |
+-----------------------+                   +------------------+
```

* **Decoupled Binary Storage:** High-bandwidth image streams bypass the application cluster, using S3-compatible object storage while the database tracks strict metadata and validation statuses.
* **Unified Privacy Lifecycles:** Connects to the platform's retention and data-erasure subsystems to ensure complete asset purging when customers request profile deletion.
