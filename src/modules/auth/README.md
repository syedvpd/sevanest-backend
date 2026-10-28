# Authentication & Session Management Module

## 1. Executive Summary

The **Authentication & Session Management Module** establishes the security perimeter for the SevaNest platform. It handles identity verification and session lifecycles for all platform participants: mobile passwordless login (OTP) for Customers and Workers, and credential-based access with brute-force protection for Operations and Support Administrators.

Engineered around **Defense-in-Depth** and **Zero-Trust Session Integrity**:
1. **Passwordless Mobile Onboarding:** Customers and domestic workers log in securely using short-lived, tamper-evident SMS one-time passwords without remembering complex passwords.
2. **Rotating Refresh Token Security:** Every token refresh automatically revokes the old refresh token and issues a new cryptographic pair. Any attempt to replay an old token triggers instant session revocation and security alerts.
3. **Multi-Device Transparency:** Users can view all active phone and web sessions across their devices and remotely revoke unauthorized or lost devices at any time.

---

## 2. Core Features & Capabilities

* **Mobile OTP Authentication:** Fast, one-click login for Indian mobile numbers with automatic account provisioning for first-time users.
* **Granular Abuse & Toll-Fraud Protection:** Multi-tiered rate limiting (per mobile number, per IP address, resend cooldowns, and progressive lockout delays) to prevent spam and SMS toll fraud.
* **Enterprise Admin Security:** Administrative credential login secured with salted `scrypt` password hashing and progressive IP/account lockouts against brute-force attacks.
* **Single-Use Rotating Token Pairs:** Short-lived access JWTs (15 minutes) paired with opaque, cryptographically hashed refresh tokens.
* **Device Session Management:** Tracks active sessions per device (`deviceId`, device model, login timestamps) with single-device re-login deduplication.
* **Push Notification Binding:** Seamlessly registers and unregisters Firebase Cloud Messaging (FCM) device tokens bound directly to active device sessions.

---

## 3. End-to-End Authentication Workflow

The following diagram illustrates the mobile OTP authentication and session creation lifecycle:

```
Mobile Application (Customer / Worker)
           │
           ▼
[POST /api/v1/auth/otp/request { mobile, appType }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Rate Limiting & Fraud Prevention Gate               │
│    - Verifies IP and mobile send limits in Redis       │
│    - Enforces 60-second resend cooldown timer          │
│    - Rejects suspended or banned phone numbers         │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Cryptographic OTP Generation & Delivery             │
│    - Generates numeric OTP with ephemeral TTL (5 min)  │
│    - Stores keyed HMAC in Redis (never plain text)     │
│    - Dispatches SMS via primary notification gateway   │
└──────────────────────────┬─────────────────────────────┘
                           │
      User inputs OTP      ▼
[POST /api/v1/auth/otp/verify { mobile, otp, deviceId }]
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Atomic Verification & Session Provisioning          │
│    - Verifies OTP atomically (single-use destruction)  │
│    - Auto-provisions user account if first-time user   │
│    - Revokes any stale session on the same deviceId    │
│    - Inserts new active session in PostgreSQL          │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 4. Token Issuance & Client Handoff                     │
│    - Issues short-lived Access JWT + Opaque Refresh    │
│    - Returns { accessToken, refreshToken, user }       │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `POST /api/v1/auth/otp/request`
Requests a one-time password sent via SMS to an Indian mobile number.
* **Payload:** `{ mobile: "+919876543210", appType: "CUSTOMER" | "WORKER" }`
* **Protection:** Cooldown timers and daily send quotas per mobile number and IP address.

---

### 2. `POST /api/v1/auth/otp/verify`
Verifies the SMS code, completes login, and auto-provisions new user accounts.
* **Payload:** `{ mobile: "+919876543210", appType: "CUSTOMER", otp: "123456", deviceId?: "...", deviceName?: "iPhone 15" }`
* **Response:** `{ accessToken, refreshToken, expiresIn, user: { id, type, isNewUser } }`

---

### 3. `POST /api/v1/auth/admin/login`
Authenticates operations, verification executives, and support staff.
* **Payload:** `{ email: "admin@sevanest.com", password: "...", deviceId?: "..." }`
* **Protection:** Progressive lockout after consecutive failed attempts.

---

### 4. `POST /api/v1/auth/token/refresh`
Rotates the session tokens, returning a fresh access token and a new single-use refresh token.
* **Payload:** `{ refreshToken: "..." }`

---

### 5. `POST /api/v1/auth/logout`
Revokes the current device session and disassociates its FCM push notification token.
* **Authorization:** Bearer JWT.

---

### 6. `GET /api/v1/auth/sessions` & `DELETE /api/v1/auth/sessions/:sessionId`
Lists all active login sessions for the authenticated user and allows remote revocation of any specific session.

---

### 7. `PUT /api/v1/auth/device-token`
Binds an FCM push notification token (`ANDROID` / `IOS`) to the active session for reliable push delivery.

---

## 5. Inter-Module Dependencies & System Design

The Authentication module coordinates with core platform services to validate identity and manage sessions:

```
┌─────────────────────────┐
│     Mobile / Web App    │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐      Creates / Reads Account     ┌─────────────────────────┐
│       Auth Module       │─────────────────────────────────►│      Users Module       │
│  (Sessions & Tokens)    │                                  │   (Identity & Status)   │
└────────────┬────────────┘                                  └─────────────────────────┘
             │
             ├──────────────────────┬────────────────────────┐
             ▼                      ▼                        ▼
┌─────────────────────────┐ ┌───────────────┐ ┌─────────────────────────┐
│      Redis Store        │ │ PostgreSQL DB │ │  Notifications Module   │
│ (OTP TTL & Rate Limits) │ │  (Sessions)   │ │  (SMS Delivery Gateway) │
└─────────────────────────┘ └───────────────┘ └─────────────────────────┘
```

* **Account Synchronization:** The Auth module queries the Users module to verify account lifecycle status (`ACTIVE` vs `SUSPENDED`) and delegates initial user record creation.
* **Decoupled Delivery:** OTP dispatch is delegated to the Notifications service, keeping auth logic independent of specific telecom and SMS providers.

