-- Synthetic data for a LOCAL load test only (never run against Supabase). 80,000 customers + 20,000 workers = 100,000 users,
-- 5 areas, verified workers with skills / areas / windows / languages / ratings, and 60,000 bookings of mixed status.
-- Run on a disposable database that has been migrated and booted once (so the service categories exist):
--   psql "$LOAD_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/load/seed.sql
BEGIN;
INSERT INTO service_areas (id, name, city, is_enabled, created_at, updated_at)
SELECT gen_random_uuid(), a.name, 'Hyderabad', true, now(), now()
FROM (VALUES ('HITEC City'),('Madhapur'),('Kondapur'),('Gachibowli'),('Kukatpally')) AS a(name)
WHERE NOT EXISTS (SELECT 1 FROM service_areas s WHERE s.name = a.name AND s.city = 'Hyderabad');

INSERT INTO verification_requirements (check_type, created_at) VALUES ('IDENTITY', now()) ON CONFLICT DO NOTHING;

-- customers
INSERT INTO users (id, type, mobile, status, created_at, updated_at)
SELECT gen_random_uuid(), 'CUSTOMER', '+9170' || lpad(g::text, 8, '0'), 'ACTIVE', now() - (g % 365 || ' days')::interval, now()
FROM generate_series(1, 80000) g;
INSERT INTO customer_profiles (id, user_id, name, email, preferred_language, verification_status, created_at, updated_at)
SELECT gen_random_uuid(), u.id, 'Customer ' || right(u.mobile, 6), 'c' || right(u.mobile, 8) || '@load.test', 'en', 'VERIFIED', u.created_at, now()
FROM users u WHERE u.type = 'CUSTOMER' AND u.mobile LIKE '+9170%';
INSERT INTO customer_addresses (id, customer_id, line, area, city, pincode, is_default, is_active, created_at, updated_at)
SELECT gen_random_uuid(), p.id, '1 Load Road', 'Madhapur', 'Hyderabad', '500081', true, true, now(), now() FROM customer_profiles p WHERE p.email LIKE '%@load.test';

-- workers
INSERT INTO users (id, type, mobile, status, created_at, updated_at)
SELECT gen_random_uuid(), 'WORKER', '+9180' || lpad(g::text, 8, '0'), 'ACTIVE', now() - (g % 365 || ' days')::interval, now()
FROM generate_series(1, 20000) g;
INSERT INTO worker_profiles (id, user_id, name, onboarding_status, submitted_at, experience_months, created_at, updated_at)
SELECT gen_random_uuid(), u.id, 'Worker ' || right(u.mobile, 6), 'SUBMITTED', now(), (right(u.mobile, 3)::int % 120), u.created_at, now()
FROM users u WHERE u.type = 'WORKER' AND u.mobile LIKE '+9180%';
CREATE TEMP TABLE lw AS SELECT w.id, row_number() OVER (ORDER BY w.id) AS n FROM worker_profiles w JOIN users u ON u.id = w.user_id WHERE u.mobile LIKE '+9180%';
CREATE TEMP TABLE lc AS SELECT id, row_number() OVER (ORDER BY code) AS n FROM service_categories WHERE is_enabled;
CREATE TEMP TABLE la AS SELECT id, row_number() OVER (ORDER BY name) AS n FROM service_areas WHERE city = 'Hyderabad';
INSERT INTO worker_skills (worker_id, category_id) SELECT lw.id, lc.id FROM lw JOIN lc ON lc.n = (lw.n % (SELECT count(*) FROM lc)) + 1;
INSERT INTO worker_skills (worker_id, category_id) SELECT lw.id, lc.id FROM lw JOIN lc ON lc.n = ((lw.n + 2) % (SELECT count(*) FROM lc)) + 1 WHERE lw.n % 3 = 0 ON CONFLICT DO NOTHING;
INSERT INTO worker_preferred_areas (worker_id, area_id) SELECT lw.id, la.id FROM lw JOIN la ON la.n = (lw.n % (SELECT count(*) FROM la)) + 1;
INSERT INTO worker_preferred_areas (worker_id, area_id) SELECT lw.id, la.id FROM lw JOIN la ON la.n = ((lw.n + 1) % (SELECT count(*) FROM la)) + 1 WHERE lw.n % 2 = 0 ON CONFLICT DO NOTHING;
INSERT INTO worker_time_windows (id, worker_id, start_minute, end_minute) SELECT gen_random_uuid(), lw.id, 360, 840 FROM lw;
INSERT INTO worker_time_windows (id, worker_id, start_minute, end_minute) SELECT gen_random_uuid(), lw.id, 900, 1260 FROM lw WHERE lw.n % 2 = 0;
INSERT INTO worker_work_preferences (worker_id, engagement_preference, updated_at)
SELECT lw.id, (ARRAY['PART_TIME','FULL_TIME','LIVE_IN','HOURLY','DAILY'])[(lw.n % 5) + 1]::"EngagementPreference", now() FROM lw;
INSERT INTO worker_languages (worker_id, language_code) SELECT lw.id, 'en' FROM lw;
INSERT INTO worker_languages (worker_id, language_code) SELECT lw.id, 'hi' FROM lw WHERE lw.n % 2 = 0;
INSERT INTO worker_languages (worker_id, language_code) SELECT lw.id, 'te' FROM lw WHERE lw.n % 3 = 0;
INSERT INTO worker_verification_checks (id, worker_id, check_type, status, submitted_at, reviewed_at, reviewer_user_id, created_at, updated_at)
SELECT gen_random_uuid(), lw.id, 'IDENTITY', CASE WHEN lw.n % 10 < 7 THEN 'APPROVED' ELSE 'NOT_SUBMITTED' END::"VerificationCheckStatus",
       CASE WHEN lw.n % 10 < 7 THEN now() END, CASE WHEN lw.n % 10 < 7 THEN now() END, CASE WHEN lw.n % 10 < 7 THEN (SELECT id FROM users WHERE type = 'ADMIN' ORDER BY created_at LIMIT 1) END, now(), now() FROM lw;
INSERT INTO worker_rating_summaries (worker_id, rating_count, rating_sum, updated_at)
SELECT lw.id, 3 + (lw.n % 40), (3 + (lw.n % 40)) * (3 + (lw.n % 3)), now() FROM lw WHERE lw.n % 10 < 6;

-- bookings: history of every kind (30,000 completed, 10,000 cancelled, 12,000 confirmed/active holding a worker, 8,000 earlier stages)
CREATE TEMP TABLE lcu AS SELECT u.id, row_number() OVER (ORDER BY u.id) AS n FROM users u WHERE u.mobile LIKE '+9170%';
INSERT INTO bookings (id, customer_user_id, worker_id, category_id, area_id, engagement, from_minute, to_minute, status, start_date, cancel_reason, cancelled_at, cancelled_by_user_id, created_at, updated_at)
SELECT gen_random_uuid(), cu.id, lw.id, (SELECT id FROM lc WHERE n = (g % (SELECT count(*) FROM lc)) + 1), (SELECT id FROM la WHERE n = (g % (SELECT count(*) FROM la)) + 1),
       (ARRAY['PART_TIME','FULL_TIME','HOURLY','DAILY'])[(g % 4) + 1]::"EngagementPreference", 540 + (g % 6) * 60, 600 + (g % 6) * 60,
       CASE WHEN g <= 30000 THEN 'COMPLETED' WHEN g <= 40000 THEN 'CANCELLED' WHEN g <= 52000 THEN (CASE WHEN g % 2 = 0 THEN 'CONFIRMED' ELSE 'ACTIVE' END) ELSE 'MATCHED' END::"BookingStatus",
       CASE WHEN g <= 30000 OR (g > 40000 AND g <= 52000) THEN (current_date + ((g % 60) - 30)) ELSE NULL END,
       CASE WHEN g > 30000 AND g <= 40000 THEN 'load test' END, CASE WHEN g > 30000 AND g <= 40000 THEN now() END, CASE WHEN g > 30000 AND g <= 40000 THEN cu.id END,
       now() - ((g % 300) || ' days')::interval, now()
FROM generate_series(1, 60000) g
JOIN lcu cu ON cu.n = ((g * 7) % 80000) + 1
JOIN lw ON lw.n = ((g * 13) % 20000) + 1;
COMMIT;
ANALYZE;
SELECT 'users' AS t, count(*) FROM users UNION ALL SELECT 'worker_profiles', count(*) FROM worker_profiles UNION ALL SELECT 'bookings', count(*) FROM bookings UNION ALL SELECT 'holding bookings', count(*) FROM bookings WHERE status IN ('CONFIRMED','ACTIVE','PENDING_PAYMENT','REPLACEMENT_REQUESTED');
