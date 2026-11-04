# SevaNest Backend — Demo Meeting Briefing (10:30 AM, 2026-11-02)

This is a speaking guide for the backend portion of the demo. It answers every item on the meeting agenda,
in the agenda's own order, with the exact facts (URLs, counts, commands) so you don't have to invent anything
on the spot. Read it once before the meeting; use the headings as your talking points.

---

## 1. Technical Deliverables & Access

### Backend deployment
- **Live API:** `https://sevanest-backend.onrender.com`
- **Health check:** `GET /health/ready` → currently returns `{"status":"ok","info":{"database":{"status":"up"},"redis":{"status":"up"}}}` — database and cache are both up right now.
- **Platform:** Render (free/starter tier web service), auto-deploys from the `main` branch of the GitHub repo on every push.
- **Process model:** one API process + one background worker process (BullMQ), both from the same codebase (`EMBEDDED_WORKERS=true` currently runs them together on Render).

### Third-party integrations and their status
| Integration | Status | Say this in the meeting |
|---|---|---|
| **Database — PostgreSQL (Supabase)** | Live, connected | "Our database is a managed Supabase Postgres instance in `ap-southeast-1`." |
| **File storage — Supabase S3-compatible storage** | Live, two buckets | "`kyc-documents` is our private bucket for ID documents and private photos. `seva-public` is a new public bucket for worker photos and category images — those load instantly with permanent cached links." |
| **Payments — Razorpay** | Test mode only | "Razorpay is wired in and tested end-to-end in test mode. We're waiting on production keys before real money moves." |
| **SMS (OTP login)** | Not live | "This is our biggest blocker — no SMS account is active yet, so OTP login can't send a real text message to a real phone. The code for two providers (Twilio, MSG91) is written and ready; we just need an account." |
| **Push notifications — Firebase (FCM)** | Configured, untested live | "Firebase is configured on the server; we haven't yet confirmed a real push notification lands on a device." |
| **Maps — Google Maps** | Built, not live | "Search works today using area names, not GPS distance. Google Maps for distance-based search is coded but needs an API key — not launch-critical." |
| **Malware scanning (uploads)** | Optional, off | "Uploaded files are checked for type, size and tampering either way. A dedicated virus scanner is optional and currently off — we decided it's not worth running a second server for it." |
| **WhatsApp notifications** | Built, optional, off | "Nice-to-have, not turned on." |

### Database details
- PostgreSQL, Supabase-managed, region `ap-southeast-1`.
- 44 migrations applied, all additive (nothing destructive has ever been run against this database).
- Schema is managed by Prisma — every table change goes through a reviewed migration file, never a manual edit.
- Say: "Every table is created and changed through version-controlled migration scripts. We have never dropped or reset this database."

### S3 bucket details
- **`kyc-documents`** — private. Holds ID/KYC documents and customer profile photos. Access only through short-lived signed links the server issues after checking permissions.
- **`seva-public`** — public, newly added. Holds worker photos and category icons as small WebP images with permanent links, cached for a year, so they load instantly on repeat views.
- Say: "We split storage into private and public on purpose — nothing sensitive is ever on a public link."

### API documentation and endpoints
- **Live interactive docs:** `https://sevanest-backend.onrender.com/docs` (Swagger UI — you can open this live in the meeting and click "Try it out" on any endpoint).
- **Raw OpenAPI spec:** `https://sevanest-backend.onrender.com/docs/openapi.json`
- **252 documented API operations** across 30 backend modules.
- Say: "Every endpoint is documented and testable live in the browser — I can demo any one of them right now."

### Mobile/web app links, Figma
- **Not applicable to this backend session** — the Customer app, Worker app and Admin web portal are separate codebases/repos, built by other team members. This briefing covers the API they call, not those apps.
- If asked for links: say plainly you don't have them, and point to whoever owns the Flutter/React repos.

---

## 2. Development Progress

### Work completed so far (plain-English summary)
The backend is a single NestJS service backing three clients: the Customer app, the Worker app, and the Admin web portal. It covers the entire PRD, end to end:

- **Login** — OTP-based login for customers and workers, password login for admin staff, secure sessions.
- **Profiles** — customer profiles and addresses; worker profiles, skills, areas, documents.
- **Worker verification** — document upload, admin review screens, approve/reject with reasons, a verified badge.
- **Search & matching** — customers find workers by category, area, availability; admins can hand-match a worker to a hard-to-fill request.
- **Booking** — interview/trial requests, booking creation, confirm/cancel/decline, full status history.
- **Payments** — booking fees, payment confirmation, refunds, reconciliation against the gateway.
- **Attendance** — check-in/out, late/leave marking, correction history.
- **Ratings & reviews** — customers rate completed bookings, worker review pages.
- **Replacement workflow** — request a replacement worker, admin reviews, new booking links to the old one.
- **Support tickets** — customers/workers raise tickets, staff assign/escalate/resolve.
- **Notifications** — in-app, SMS, WhatsApp and push, all queued and retried if delivery fails.
- **Reports & admin dashboard** — bookings, demand by category/area, conversion rates, worker utilization.
- **Image pipeline** (shipped this week) — any photo upload (worker, customer, category icon) is resized, converted to a small WebP, and stripped of hidden phone location data before it's ever shown to anyone.
- **Security & audit** — every admin action, verification decision and payment event is logged; role-based permissions on every screen.

### Modules successfully completed
All **19 of 19 planned business modules** have working, tested code:
Auth · Users · Customers · Workers · Service Categories · Availability · Search · Matching · Verification ·
Booking · Payment · Notifications · Attendance · Replacement · Ratings · Support · Reports · Admin · Audit/Security.

Plus later additions beyond the original module list: worker/customer photo pipeline, shortlist, platform-config
(admin-editable app settings), public image storage for fast-loading photos.

### Modules currently in progress
**None on the code side.** There is no module where backend code is partially written. What remains is entirely
external accounts, vendor sign-ups, and business decisions (see Blockers below) — not more code to write.

### Pending modules and estimated timelines
| Item | What's pending | Backend effort once unblocked |
|---|---|---|
| Customer subscription plans | No spec yet — what does a plan grant, for how long | 1–2 days, once defined |
| Real SMS delivery | Needs account + sender ID/template approval | Same day as the account is active (code is done) |
| Real payment go-live | Needs Razorpay production keys | Same day (code is done, test-mode proven) |

### Incomplete integrations or dependencies
Listed fully under Blockers below — every one of them is "waiting on an account/decision," not "waiting on code."

---

## 3. Blockers & Challenges

Say this plainly: **the backend code itself is complete against the PRD. Everything blocking launch is an
external account or a business decision, not a coding task.**

| # | Blocker | Impact | Proposed solution | Who unblocks it |
|---|---|---|---|---|
| 1 | **No live SMS provider** | Nobody can log in with a real phone in production | Sign up with Twilio or MSG91, register a sender ID; code already supports both | Business/Ops — needs an account today |
| 2 | **Payment gateway in test mode only** | No real booking fee can be collected | Get Razorpay production keys | Business — needs KYC with Razorpay |
| 3 | **Database backups not yet turned on** | Risk of data loss with no recovery path | Enable Supabase automated backups, do one test restore | 15-minute task, needs an admin to click it |
| 4 | **Legal text not supplied** | Terms/privacy/consent can't be enforced | Legal team supplies reviewed text and a version number | Legal |
| 5 | **Data retention policy undefined** | Can't auto-delete old data on schedule | Business decides how long to keep documents/logs | Business |
| 6 | **Google Maps not connected** | Search works by area name, not by GPS distance | Get a Maps API key if GPS-distance search is wanted for launch | Business, low urgency |
| 7 | **Subscription plan feature not started** | Feature doesn't exist | Define what a plan includes and its price/term | Business |

**Expected resolution timeline:** blockers 1–3 can be closed within a day each, as soon as an account/approval
exists — the code side is zero additional work. Blockers 4–7 are policy decisions with no fixed backend timeline;
flag that the 10-day deadline is realistic for code, but **not** for closing all seven of these, since five of
them depend on people outside engineering.

---

## 4. Demo Readiness

### What you can actually demo live, right now
1. Open `https://sevanest-backend.onrender.com/docs` and show the full Swagger catalogue — 252 operations.
2. Call `GET /health/ready` and show it's live, database and Redis both up.
3. Walk through one real flow in Swagger with "Try it out":
   - OTP request/verify (login) — using the demo-OTP flag, since real SMS isn't live.
   - Worker photo upload → confirm → show the returned permanent image link loads instantly.
   - Category list → show the new `image` field with a worker photo and category icon.
   - Admin login → list service categories → upload a category image.
4. Show the admin verification screens' underlying endpoints (document review, approve/reject with reason).

### Before you walk in, verify these three things yourself
1. Hit `https://sevanest-backend.onrender.com/health/ready` from your own laptop five minutes before the meeting — if Render has gone to sleep (free tier can cold-start), the first request takes ~30s, so warm it up in advance.
2. Have `https://sevanest-backend.onrender.com/docs` open in a browser tab already.
3. Have an admin login ready (ask whoever holds the Super Admin credentials, or use the bootstrap script if you're the one who ran it) — you'll need this to demo any admin screen.

### Credentials/links to have open in tabs before 10:30
- Swagger docs tab (above).
- This briefing file, open on a second monitor or printed.
- Your Render dashboard (to show deploy history / confirm it's live, if asked).
- Supabase dashboard (to show the database/storage if asked for "access information" — do not paste connection strings or keys on screen).

**Do not** read out database passwords, API keys, or secrets in the meeting, even if someone asks for "access
information" — offer to share them privately afterward through a password manager or a private channel instead.

---

## One-paragraph summary, if you only have 30 seconds

> "The SevaNest backend is code-complete against the PRD — all 19 modules, every customer/worker/admin flow,
> 252 documented API endpoints, deployed and live right now with the database and cache both healthy. What's
> left before full production launch isn't code — it's five external pieces: a live SMS account, production
> payment keys, database backups turned on, legal text, and a data-retention decision. All of those are
> business or account-setup tasks, not engineering work."
