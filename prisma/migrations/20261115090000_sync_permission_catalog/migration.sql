-- AUTH-BUG-001: databases seeded before config.manage (and other later codes) existed never received them, so Super Admin got 403 on
-- /admin/app-settings and /admin/rating-tags. Idempotent copy of PERMISSION_CATALOG; SUPER_ADMIN holds every permission (FRD section 2).
INSERT INTO "permissions" ("id", "code", "description") VALUES
  (gen_random_uuid(), 'admin.manage_users', 'Create admin accounts and change admin account status'),
  (gen_random_uuid(), 'user.view', 'View a user account'),
  (gen_random_uuid(), 'user.status.manage', 'Suspend or reactivate customer and worker accounts'),
  (gen_random_uuid(), 'customer.view', 'View customer profiles, addresses and notes'),
  (gen_random_uuid(), 'customer.manage', 'Change customer verification status and add notes'),
  (gen_random_uuid(), 'worker.view', 'View worker profiles and availability'),
  (gen_random_uuid(), 'worker.manage', 'Edit worker profiles and availability on a worker behalf (assisted onboarding)'),
  (gen_random_uuid(), 'worker.blacklist', 'Blacklist a worker: excluded from search and matching, account suspended, open bookings flagged'),
  (gen_random_uuid(), 'worker.blacklist.lift', 'Lift a worker blacklisting (Super Admin only)'),
  (gen_random_uuid(), 'worker.reveal_emergency_contact', 'Reveal a worker emergency contact with a stated reason (every reveal is audited)'),
  (gen_random_uuid(), 'verification.signoff', 'Give the final verification sign-off for a worker once all required checks are approved'),
  (gen_random_uuid(), 'verification.reassign', 'Release or reassign a verification check claimed by another reviewer'),
  (gen_random_uuid(), 'worker.activate', 'Activate a signed-off worker so they appear in search and matching'),
  (gen_random_uuid(), 'category.manage', 'View and manage service categories'),
  (gen_random_uuid(), 'area.manage', 'View and manage service areas'),
  (gen_random_uuid(), 'verification.review', 'View the verification queue and worker verification status, start a review'),
  (gen_random_uuid(), 'verification.decide', 'Approve or reject a verification check, trigger a re-check'),
  (gen_random_uuid(), 'verification.document.view', 'Open KYC documents (a short-lived link is issued and audited)'),
  (gen_random_uuid(), 'verification.configure', 'Choose which checks are required for a worker to count as verified'),
  (gen_random_uuid(), 'matching.run', 'Run manual worker matching for a requirement'),
  (gen_random_uuid(), 'booking.view', 'View bookings and their timeline'),
  (gen_random_uuid(), 'booking.manage', 'Match, schedule, confirm, cancel and otherwise move bookings on behalf of the parties'),
  (gen_random_uuid(), 'payment.view', 'View payments, receipts and fee configuration'),
  (gen_random_uuid(), 'payment.refund', 'Initiate a refund'),
  (gen_random_uuid(), 'payment.manage', 'Configure fees and reconcile a payment with the gateway'),
  (gen_random_uuid(), 'notification.manage', 'Manage notification templates and view the delivery log'),
  (gen_random_uuid(), 'attendance.view', 'View attendance records'),
  (gen_random_uuid(), 'attendance.manage', 'Record and correct attendance on behalf of the parties (audited)'),
  (gen_random_uuid(), 'replacement.view', 'View replacement requests'),
  (gen_random_uuid(), 'replacement.manage', 'Approve or reject replacement requests and select the replacement worker'),
  (gen_random_uuid(), 'rating.view', 'View all ratings and reviews'),
  (gen_random_uuid(), 'rating.moderate', 'Hide or restore a rating or review (abusive content, audited)'),
  (gen_random_uuid(), 'support.view', 'View support tickets and their history'),
  (gen_random_uuid(), 'support.manage', 'Assign, prioritise, escalate and close support tickets'),
  (gen_random_uuid(), 'support.category.manage', 'Manage the configured list of support categories'),
  (gen_random_uuid(), 'report.view', 'View the read-only operational reports'),
  (gen_random_uuid(), 'role.manage', 'View roles and permissions and change which permissions a role holds'),
  (gen_random_uuid(), 'audit.view', 'Read the audit log'),
  (gen_random_uuid(), 'alert.view', 'See operational alerts addressed to the permissions this role holds'),
  (gen_random_uuid(), 'alert.manage', 'Acknowledge and resolve operational alerts'),
  (gen_random_uuid(), 'config.manage', 'Edit the app start-up settings (update policy, support contact, policy text) and the rating tag catalogue')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p
WHERE r."code" = 'SUPER_ADMIN'
ON CONFLICT DO NOTHING;
