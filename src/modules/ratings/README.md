# Ratings & Reviews Module

## 1. Executive Summary

The **Ratings Module** governs customer feedback, star ratings, and review moderation across SevaNest. It allows households to evaluate service quality upon completion of domestic engagements while giving domestic helpers public credibility through verified reviews.

Engineered around **Review Authenticity** and **Moderation Control**:
1. **Verified Engagement Requirement:** Ratings can strictly be submitted only for completed engagements (`COMPLETED` state), preventing fraudulent or unearned ratings.
2. **Instant Summary Aggregation:** Worker average scores and total review counts are calculated and maintained in real time inside `worker_rating_summaries`, avoiding costly database table scans.
3. **Abuse Moderation:** Administrators can review and hide abusive, discriminatory, or inappropriate comments, automatically recalibrating the worker's visible score.

---

## 2. Core Features & Capabilities

* **Post-Engagement Review Submission:** 1-to-5 star rating scale with optional detailed text feedback submitted upon engagement completion.
* **Review Uniqueness:** Exactly one review permitted per booking, guaranteed by database-level constraints.
* **Worker Rating Summaries:** Pre-aggregated average scores and review counts for sub-millisecond retrieval on public profile cards.
* **Administrative Moderation:** Operations staff can hide policy-violating reviews (`/hide`, `/unhide`) with mandatory justification logs.
* **Worker Transparency:** Domestic helpers can view all approved reviews and rating averages directly from their mobile app.

---

## 3. End-to-End Rating Workflow

The following diagram illustrates how customer reviews are submitted and aggregated:

```
Customer Mobile App (Flutter)
           │
           ▼
[POST /api/v1/ratings { bookingId, score: 5, review: "Prompt and very professional." }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Eligibility & Anti-Duplicate Check                  │
│    - Verifies booking is in COMPLETED status           │
│    - Verifies caller owns the booking                  │
│    - Enforces score bounds (1 to RATING_SCALE_MAX)     │
│    - Prevents duplicate review submission              │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Atomic Rating Commit & Summary Update               │
│    - Inserts rating record                             │
│    - Recalculates average rating in worker_summaries   │
│    - Commits transaction atomically                    │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
Public Search & Worker Profile
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Instant Profile Visibility                          │
│    - Updated star rating reflects on worker cards      │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `POST /api/v1/ratings`
Submits a rating and optional review for a completed service engagement.
* **Payload:** `{ bookingId: "booking_uuid", score: 5, review?: "Punctual and thorough cleaning." }`

---

### 2. `GET /api/v1/ratings` & `GET /api/v1/ratings/:id`
Retrieves reviews submitted by the authenticated customer.

---

### 3. `GET /api/v1/workers/me/ratings` & `GET /api/v1/workers/me/ratings/summary`
Allows domestic helpers to view their performance summary (average score and review counts).

---

### 4. `POST /api/v1/admin/ratings/:id/hide` & `POST .../unhide`
Allows operations moderators to hide inappropriate reviews.
* **Authorization:** Administrative JWT (`rating.moderate` permission).
* **Payload:** `{ reason: "Contains profanity or inappropriate personal remarks" }`

---

## 5. Inter-Module Dependencies & System Design

The Ratings module connects completed transactions with discovery cards:

```
┌─────────────────────────┐
│     Booking Module      │──┐
│  (COMPLETED Bookings)   │  │
└─────────────────────────┘  │
                             ▼
                    [ Ratings Module ] ──► [ Search & Profile Module ]
                  (Feedback & Summaries)   (Displays Stars on Cards)
```

* **Engagement Verification:** The Ratings module checks the Booking module to verify that a service was formally concluded before accepting feedback.
* **Search Integration:** Real-time rating summaries are queried by Search to render verified star badges on customer worker cards.

