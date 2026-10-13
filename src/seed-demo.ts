import { Client } from 'pg';

/**
 * `node dist/seed-demo` - LOCAL / DEVELOPMENT demo data for app developers: 6 customers (+9190000002xx, profile, address(es),
 * verified), 12 workers (+9190000001xx, submitted and identity-verified, two categories for some), service areas, completed bookings
 * with reviews, and shortlists. Written with plain SQL in one transaction; idempotent (does nothing when the demo accounts exist).
 *
 * It refuses NODE_ENV=production and any hosted database host. Demo accounts log in with the staging test OTP when ALLOW_TEST_OTP is
 * on (see .env.docker); nothing here is a real person.
 */
const mobile = (n: number): string => `+91900000${String(n).padStart(4, '0')}`;
const AREAS = ['Madhapur', 'Kondapur', 'Gachibowli', 'Hitech City', 'Kukatpally'];
const WORKERS: Array<[string, number]> = [
  ['Lakshmi Devi', 60],
  ['Sunita Yadav', 48],
  ['Padma Reddy', 84],
  ['Rekha Kumari', 24],
  ['Ramesh Naik', 36],
  ['Savitri Bai', 96],
  ['Anwar Hussain', 30],
  ['Geeta Sharma', 72],
  ['Mary Joseph', 18],
  ['Kavitha Rao', 54],
  ['Narsimha Goud', 40],
  ['Bhavani Devi', 12],
];
const CUSTOMERS = [
  'Anita Rao',
  'Vikram Singh',
  'Priya Menon',
  'Arjun Reddy',
  'Fatima Khan',
  'Suresh Iyer',
];
const REVIEWS: Array<[number, string]> = [
  [5, 'Punctual and very careful with the kitchen.'],
  [4, 'Good work, kids liked her.'],
  [5, 'Reliable. Would book again.'],
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-demo refuses to run with NODE_ENV=production');
  }
  if (!url || /supabase|render\.com|amazonaws|neon\.tech/i.test(url)) {
    throw new Error('seed-demo refuses to run against a hosted database');
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    if ((await db.query(`SELECT 1 FROM users WHERE mobile = $1`, [mobile(101)])).rowCount) {
      console.log('Demo data already present. Nothing done.');
      return;
    }
    await db.query('BEGIN');
    const q = (sql: string, params: unknown[] = []) => db.query<{ id: string }>(sql, params);

    for (const name of AREAS) {
      await q(
        `INSERT INTO service_areas (id, name, city, is_enabled, created_at, updated_at)
         SELECT gen_random_uuid(), $1, 'Hyderabad', true, now(), now()
         WHERE NOT EXISTS (SELECT 1 FROM service_areas WHERE name = $1 AND city = 'Hyderabad')`,
        [name],
      );
    }
    await q(
      `INSERT INTO verification_requirements (check_type, created_at) VALUES ('IDENTITY', now()) ON CONFLICT DO NOTHING`,
    );
    const admin = (await q(`SELECT id FROM users WHERE type = 'ADMIN' ORDER BY created_at LIMIT 1`))
      .rows[0]?.id as string | undefined;

    // customers
    for (let i = 0; i < CUSTOMERS.length; i++) {
      const u = (
        await q(
          `INSERT INTO users (id, type, mobile, status, created_at, updated_at) VALUES (gen_random_uuid(), 'CUSTOMER', $1, 'ACTIVE', now(), now()) RETURNING id`,
          [mobile(201 + i)],
        )
      ).rows[0].id;
      const p = (
        await q(
          `INSERT INTO customer_profiles (id, user_id, name, email, preferred_language, verification_status, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'en', 'VERIFIED', now(), now()) RETURNING id`,
          [u, CUSTOMERS[i], `demo.customer${i + 1}@example.com`],
        )
      ).rows[0].id;
      const area = AREAS[i % AREAS.length];
      await q(
        `INSERT INTO customer_addresses (id, customer_id, label, line, area, city, state, pincode, is_default, is_active, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'Home', $2, $3, 'Hyderabad', 'Telangana', '500081', true, true, now(), now())`,
        [p, `${20 + i} Road No. ${i + 1}`, area],
      );
      if (i === 0) {
        await q(
          `INSERT INTO customer_addresses (id, customer_id, label, line, line2, area, city, state, pincode, is_default, is_active, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'Office', '5 Cyber Towers', 'Floor 3', 'Hitech City', 'Hyderabad', 'Telangana', '500081', false, true, now(), now())`,
          [p],
        );
      }
    }

    // workers
    const workerIds: string[] = [];
    for (let i = 0; i < WORKERS.length; i++) {
      const [name, months] = WORKERS[i];
      const u = (
        await q(
          `INSERT INTO users (id, type, mobile, status, created_at, updated_at) VALUES (gen_random_uuid(), 'WORKER', $1, 'ACTIVE', now(), now()) RETURNING id`,
          [mobile(101 + i)],
        )
      ).rows[0].id;
      const submitted = i < 11; // the last stays a draft
      const w = (
        await q(
          `INSERT INTO worker_profiles (id, user_id, name, onboarding_status, submitted_at, experience_months, expected_salary, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3::"WorkerOnboardingStatus", $4, $5, $6, now(), now()) RETURNING id`,
          [
            u,
            name,
            submitted ? 'SUBMITTED' : 'DRAFT',
            submitted ? new Date() : null,
            months,
            12000 + (i % 6) * 1500,
          ],
        )
      ).rows[0].id;
      workerIds.push(w);
      await q(
        `INSERT INTO worker_skills (worker_id, category_id) SELECT $1, id FROM service_categories WHERE code = 'HOUSE_MAID'`,
        [w],
      );
      if (i % 3 === 2) {
        await q(
          `INSERT INTO worker_skills (worker_id, category_id) SELECT $1, id FROM service_categories WHERE code = 'COOK'`,
          [w],
        );
      }
      for (const k of [0, 1, 2]) {
        await q(
          `INSERT INTO worker_preferred_areas (worker_id, area_id) SELECT $1, id FROM service_areas WHERE name = $2 AND city = 'Hyderabad' ON CONFLICT DO NOTHING`,
          [w, AREAS[(i + k) % AREAS.length]],
        );
      }
      await q(
        `INSERT INTO worker_time_windows (id, worker_id, start_minute, end_minute) VALUES (gen_random_uuid(), $1, 420, 1140)`,
        [w],
      );
      await q(
        `INSERT INTO worker_work_preferences (worker_id, engagement_preference, updated_at) VALUES ($1, $2::"EngagementPreference", now())`,
        [w, ['PART_TIME', 'FULL_TIME', 'LIVE_IN'][i % 3]],
      );
      for (const lang of i % 3 === 0 ? ['en', 'hi', 'te'] : ['hi', 'te']) {
        await q(`INSERT INTO worker_languages (worker_id, language_code) VALUES ($1, $2)`, [
          w,
          lang,
        ]);
      }
      if (submitted && i < 9) {
        await q(
          `INSERT INTO worker_verification_checks (id, worker_id, check_type, status, submitted_at, reviewed_at, reviewer_user_id, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'IDENTITY', 'APPROVED', now(), now(), $2, now(), now())`,
          [w, admin ?? null],
        );
      }
    }

    // completed bookings with reviews for the first three verified workers, then the rating summaries
    for (let i = 0; i < REVIEWS.length; i++) {
      const customer = (await q(`SELECT id FROM users WHERE mobile = $1`, [mobile(201 + i)]))
        .rows[0].id;
      const b = (
        await q(
          `INSERT INTO bookings (id, customer_user_id, worker_id, category_id, area_id, engagement, from_minute, to_minute, status, start_date, created_at, updated_at)
           SELECT gen_random_uuid(), $1, $2, c.id, a.id, 'PART_TIME', 540, 720, 'COMPLETED', current_date - 20, now() - interval '25 days', now() - interval '2 days'
           FROM service_categories c, service_areas a WHERE c.code = 'HOUSE_MAID' AND a.name = $3 AND a.city = 'Hyderabad' RETURNING id`,
          [customer, workerIds[i], AREAS[i % AREAS.length]],
        )
      ).rows[0].id;
      await q(
        `INSERT INTO ratings (id, booking_id, customer_user_id, worker_id, score, review_text, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'VISIBLE', now() - interval '1 day', now())`,
        [b, customer, workerIds[i], REVIEWS[i][0], REVIEWS[i][1]],
      );
      await q(
        `INSERT INTO worker_rating_summaries (worker_id, rating_count, rating_sum, updated_at) VALUES ($1, 1, $2, now())
         ON CONFLICT (worker_id) DO UPDATE SET rating_count = 1, rating_sum = $2, updated_at = now()`,
        [workerIds[i], REVIEWS[i][0]],
      );
    }

    // shortlists: customer 1 -> workers 1, 2; customer 2 -> worker 1
    for (const [c, w] of [
      [0, 0],
      [0, 1],
      [1, 0],
    ]) {
      await q(
        `INSERT INTO customer_shortlist_items (customer_user_id, worker_id, created_at)
         SELECT id, $2, now() FROM users WHERE mobile = $1 ON CONFLICT DO NOTHING`,
        [mobile(201 + c), workerIds[w]],
      );
    }
    await db.query('COMMIT');
    console.log('Demo data created: 6 customers, 12 workers (9 verified), 3 reviews, shortlists.');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
