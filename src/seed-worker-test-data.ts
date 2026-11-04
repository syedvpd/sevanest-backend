import { Client } from 'pg';

/**
 * `npm run seed:workers` (or `node dist/seed-worker-test-data`)
 *
 * Deterministic test worker accounts & booking assignments for Flutter Worker App integration:
 * - Worker A (+919000000001): Active & Verified (signed off, activated, pending opportunity + active job)
 * - Worker B (+919000000002): Pending Verification (checks submitted / under review)
 * - Worker C (+919000000003): Verification Rejected (check rejected with reason)
 * - Worker D (+919000000004): Draft Profile (incomplete onboarding)
 * - Worker E (+919000000005): Suspended / Blacklisted
 * - Customer (+919000000009): Active customer with Hyderabad service address
 *
 * Refuses NODE_ENV=production and any hosted database host.
 * Idempotent: can be rerun safely.
 */
const NUMBERS = {
  workerA: '+919000000001',
  workerB: '+919000000002',
  workerC: '+919000000003',
  workerD: '+919000000004',
  workerE: '+919000000005',
  customer: '+919000000009',
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-worker-test-data refuses to run with NODE_ENV=production');
  }
  if (!url || /supabase|render\.com|amazonaws|neon\.tech/i.test(url)) {
    throw new Error('seed-worker-test-data refuses to run against a hosted database');
  }

  const db = new Client({ connectionString: url });
  await db.connect();

  try {
    await db.query('BEGIN');
    const q = (sql: string, params: unknown[] = []) => db.query<{ id: string }>(sql, params);

    // 1. Ensure required Service Areas exist in Hyderabad
    const areas = ['Madhapur', 'Kondapur', 'Gachibowli', 'Hitech City'];
    for (const name of areas) {
      await q(
        `INSERT INTO service_areas (id, name, city, is_enabled, created_at, updated_at)
         SELECT gen_random_uuid(), $1, 'Hyderabad', true, now(), now()
         WHERE NOT EXISTS (SELECT 1 FROM service_areas WHERE name = $1 AND city = 'Hyderabad')`,
        [name],
      );
    }
    const madhapurAreaId = (
      await q(`SELECT id FROM service_areas WHERE name = 'Madhapur' AND city = 'Hyderabad' LIMIT 1`)
    ).rows[0].id;

    // 2. Ensure Category HOUSE_MAID exists
    const maidCat = (await q(`SELECT id FROM service_categories WHERE code = 'HOUSE_MAID' LIMIT 1`))
      .rows[0]?.id;
    if (!maidCat) {
      throw new Error('Service category HOUSE_MAID not found. Run "npm run seed" first.');
    }

    const cookCat = (await q(`SELECT id FROM service_categories WHERE code = 'COOK' LIMIT 1`))
      .rows[0]?.id;

    // 3. Clean up existing test accounts if present (ensures idempotent fresh state)
    const testMobiles = Object.values(NUMBERS);
    const existingUsers = (
      await q(`SELECT id FROM users WHERE mobile = ANY($1::text[])`, [testMobiles])
    ).rows.map((r) => r.id);

    if (existingUsers.length > 0) {
      await q(`DELETE FROM bookings WHERE customer_user_id = ANY($1::uuid[])`, [existingUsers]);
      const existingWorkerProfileIds = (
        await q(`SELECT id FROM worker_profiles WHERE user_id = ANY($1::uuid[])`, [existingUsers])
      ).rows.map((r) => r.id);

      if (existingWorkerProfileIds.length > 0) {
        await q(`DELETE FROM bookings WHERE worker_id = ANY($1::uuid[])`, [
          existingWorkerProfileIds,
        ]);
        await q(`DELETE FROM worker_verification_checks WHERE worker_id = ANY($1::uuid[])`, [
          existingWorkerProfileIds,
        ]);
        await q(`DELETE FROM worker_skills WHERE worker_id = ANY($1::uuid[])`, [
          existingWorkerProfileIds,
        ]);
        await q(`DELETE FROM worker_preferred_areas WHERE worker_id = ANY($1::uuid[])`, [
          existingWorkerProfileIds,
        ]);
        await q(`DELETE FROM worker_time_windows WHERE worker_id = ANY($1::uuid[])`, [
          existingWorkerProfileIds,
        ]);
        await q(`DELETE FROM worker_work_preferences WHERE worker_id = ANY($1::uuid[])`, [
          existingWorkerProfileIds,
        ]);
        await q(`DELETE FROM worker_languages WHERE worker_id = ANY($1::uuid[])`, [
          existingWorkerProfileIds,
        ]);
        await q(`DELETE FROM worker_profiles WHERE id = ANY($1::uuid[])`, [
          existingWorkerProfileIds,
        ]);
      }

      await q(
        `DELETE FROM customer_addresses WHERE customer_id IN (
        SELECT id FROM customer_profiles WHERE user_id = ANY($1::uuid[])
      )`,
        [existingUsers],
      );
      await q(`DELETE FROM customer_profiles WHERE user_id = ANY($1::uuid[])`, [existingUsers]);
      await q(`DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])`, [existingUsers]);
      await q(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [existingUsers]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [existingUsers]);
    }

    const adminUserId =
      (await q(`SELECT id FROM users WHERE type = 'ADMIN' ORDER BY created_at LIMIT 1`)).rows[0]
        ?.id ?? null;

    // 4. Create Test Customer
    const customerUserId = (
      await q(
        `INSERT INTO users (id, type, mobile, status, created_at, updated_at)
         VALUES (gen_random_uuid(), 'CUSTOMER', $1, 'ACTIVE', now(), now()) RETURNING id`,
        [NUMBERS.customer],
      )
    ).rows[0].id;

    const customerProfileId = (
      await q(
        `INSERT INTO customer_profiles (id, user_id, name, email, preferred_language, verification_status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'Rajesh Demo Customer', 'customer.demo@sevanest.test', 'en', 'VERIFIED', now(), now()) RETURNING id`,
        [customerUserId],
      )
    ).rows[0].id;

    const addressId = (
      await q(
        `INSERT INTO customer_addresses (id, customer_id, label, line, area, city, state, pincode, is_default, is_active, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'Home', 'Villa 42, Green Valley', 'Madhapur', 'Hyderabad', 'Telangana', '500081', true, true, now(), now()) RETURNING id`,
        [customerProfileId],
      )
    ).rows[0].id;

    // 5. Create Worker A: Active & Verified
    const workerAUserId = (
      await q(
        `INSERT INTO users (id, type, mobile, status, created_at, updated_at)
         VALUES (gen_random_uuid(), 'WORKER', $1, 'ACTIVE', now(), now()) RETURNING id`,
        [NUMBERS.workerA],
      )
    ).rows[0].id;

    const workerAProfileId = (
      await q(
        `INSERT INTO worker_profiles (
          id, user_id, name, onboarding_status, submitted_at, application_reference,
          experience_months, expected_salary, preferred_language,
          address_line, address_area, address_city, address_pincode,
          emergency_contact_name, emergency_contact_mobile,
          criminal_record_declared, criminal_declared_at,
          verification_signed_off_at, verification_signed_off_by_user_id,
          activated_at, activated_by_user_id,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, 'Worker A (Active Verified)', 'SUBMITTED', now(), 'SEVA10000001',
          48, 15000, 'en',
          'Flat 401, Nilgiri Block', 'Madhapur', 'Hyderabad', '500081',
          'Emergency Contact', '+919876543210',
          false, now(),
          now(), $2,
          now(), $2,
          now(), now()
        ) RETURNING id`,
        [workerAUserId, adminUserId],
      )
    ).rows[0].id;

    // Skills, Areas, Windows, Languages for Worker A
    await q(`INSERT INTO worker_skills (worker_id, category_id) VALUES ($1, $2)`, [
      workerAProfileId,
      maidCat,
    ]);
    if (cookCat) {
      await q(`INSERT INTO worker_skills (worker_id, category_id) VALUES ($1, $2)`, [
        workerAProfileId,
        cookCat,
      ]);
    }
    await q(`INSERT INTO worker_preferred_areas (worker_id, area_id) VALUES ($1, $2)`, [
      workerAProfileId,
      madhapurAreaId,
    ]);
    await q(
      `INSERT INTO worker_time_windows (id, worker_id, start_minute, end_minute) VALUES (gen_random_uuid(), $1, 420, 1140)`,
      [workerAProfileId],
    );
    await q(
      `INSERT INTO worker_work_preferences (worker_id, engagement_preference, updated_at) VALUES ($1, 'FULL_TIME', now())`,
      [workerAProfileId],
    );
    await q(
      `INSERT INTO worker_languages (worker_id, language_code) VALUES ($1, 'en'), ($1, 'hi'), ($1, 'te')`,
      [workerAProfileId],
    );

    // Checks for Worker A: Identity, Address, Police, Skill Certificate all APPROVED
    for (const checkType of ['IDENTITY', 'ADDRESS', 'POLICE_VERIFICATION', 'SKILL_CERTIFICATE']) {
      await q(
        `INSERT INTO worker_verification_checks (id, worker_id, check_type, status, submitted_at, reviewed_at, reviewer_user_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'APPROVED', now(), now(), $3, now(), now())`,
        [workerAProfileId, checkType, adminUserId],
      );
    }

    // 6. Create Worker B: Verification Pending
    const workerBUserId = (
      await q(
        `INSERT INTO users (id, type, mobile, status, created_at, updated_at)
         VALUES (gen_random_uuid(), 'WORKER', $1, 'ACTIVE', now(), now()) RETURNING id`,
        [NUMBERS.workerB],
      )
    ).rows[0].id;

    const workerBProfileId = (
      await q(
        `INSERT INTO worker_profiles (
          id, user_id, name, onboarding_status, submitted_at, application_reference,
          experience_months, expected_salary, preferred_language,
          address_line, address_area, address_city, address_pincode,
          criminal_record_declared, criminal_declared_at,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, 'Worker B (Pending Verification)', 'SUBMITTED', now(), 'SEVA10000002',
          24, 12000, 'te',
          'House 12, Main Road', 'Madhapur', 'Hyderabad', '500081',
          false, now(),
          now(), now()
        ) RETURNING id`,
        [workerBUserId],
      )
    ).rows[0].id;

    await q(`INSERT INTO worker_skills (worker_id, category_id) VALUES ($1, $2)`, [
      workerBProfileId,
      maidCat,
    ]);
    await q(`INSERT INTO worker_preferred_areas (worker_id, area_id) VALUES ($1, $2)`, [
      workerBProfileId,
      madhapurAreaId,
    ]);
    await q(
      `INSERT INTO worker_time_windows (id, worker_id, start_minute, end_minute) VALUES (gen_random_uuid(), $1, 480, 1080)`,
      [workerBProfileId],
    );
    await q(
      `INSERT INTO worker_work_preferences (worker_id, engagement_preference, updated_at) VALUES ($1, 'PART_TIME', now())`,
      [workerBProfileId],
    );

    // Checks for Worker B: Submitted / In Review
    await q(
      `INSERT INTO worker_verification_checks (id, worker_id, check_type, status, submitted_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'IDENTITY', 'SUBMITTED', now(), now(), now()),
              (gen_random_uuid(), $1, 'SKILL_CERTIFICATE', 'SUBMITTED', now(), now(), now())`,
      [workerBProfileId],
    );

    // 7. Create Worker C: Verification Rejected
    const workerCUserId = (
      await q(
        `INSERT INTO users (id, type, mobile, status, created_at, updated_at)
         VALUES (gen_random_uuid(), 'WORKER', $1, 'ACTIVE', now(), now()) RETURNING id`,
        [NUMBERS.workerC],
      )
    ).rows[0].id;

    const workerCProfileId = (
      await q(
        `INSERT INTO worker_profiles (
          id, user_id, name, onboarding_status, submitted_at, application_reference,
          experience_months, expected_salary, preferred_language,
          address_line, address_area, address_city, address_pincode,
          criminal_record_declared, criminal_declared_at,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, 'Worker C (Rejected)', 'SUBMITTED', now(), 'SEVA10000003',
          18, 10000, 'hi',
          'Block C, Road 5', 'Madhapur', 'Hyderabad', '500081',
          false, now(),
          now(), now()
        ) RETURNING id`,
        [workerCUserId],
      )
    ).rows[0].id;

    await q(`INSERT INTO worker_skills (worker_id, category_id) VALUES ($1, $2)`, [
      workerCProfileId,
      maidCat,
    ]);
    await q(`INSERT INTO worker_preferred_areas (worker_id, area_id) VALUES ($1, $2)`, [
      workerCProfileId,
      madhapurAreaId,
    ]);
    await q(
      `INSERT INTO worker_verification_checks (id, worker_id, check_type, status, submitted_at, reviewed_at, reviewer_user_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'IDENTITY', 'APPROVED', now(), now(), $2, now(), now())`,
      [workerCProfileId, adminUserId],
    );
    await q(
      `INSERT INTO worker_verification_checks (id, worker_id, check_type, status, rejection_code, remarks, submitted_at, reviewed_at, reviewer_user_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'POLICE_VERIFICATION', 'REJECTED', 'UNREADABLE_IMAGE', 'Police certificate document is blurry and unreadable', now(), now(), $2, now(), now())`,
      [workerCProfileId, adminUserId],
    );

    // 8. Create Worker D: Incomplete / Draft
    const workerDUserId = (
      await q(
        `INSERT INTO users (id, type, mobile, status, created_at, updated_at)
         VALUES (gen_random_uuid(), 'WORKER', $1, 'ACTIVE', now(), now()) RETURNING id`,
        [NUMBERS.workerD],
      )
    ).rows[0].id;

    await q(
      `INSERT INTO worker_profiles (
        id, user_id, name, onboarding_status, submitted_at,
        created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, 'Worker D (Draft)', 'DRAFT', null,
        now(), now()
      ) RETURNING id`,
      [workerDUserId],
    );

    // 9. Create Worker E: Suspended / Blacklisted
    const workerEUserId = (
      await q(
        `INSERT INTO users (id, type, mobile, status, created_at, updated_at)
         VALUES (gen_random_uuid(), 'WORKER', $1, 'SUSPENDED', now(), now()) RETURNING id`,
        [NUMBERS.workerE],
      )
    ).rows[0].id;

    const workerEProfileId = (
      await q(
        `INSERT INTO worker_profiles (
          id, user_id, name, onboarding_status, submitted_at, application_reference,
          experience_months, expected_salary, preferred_language,
          blacklisted_at, blacklist_reason, blacklisted_by_user_id,
          verification_signed_off_at, verification_signed_off_by_user_id,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, 'Worker E (Suspended Blacklisted)', 'SUBMITTED', now(), 'SEVA10000005',
          36, 14000, 'en',
          now(), 'Policy violation and background check failure', $2,
          now(), $2,
          now(), now()
        ) RETURNING id`,
        [workerEUserId, adminUserId],
      )
    ).rows[0].id;

    await q(`INSERT INTO worker_skills (worker_id, category_id) VALUES ($1, $2)`, [
      workerEProfileId,
      maidCat,
    ]);
    await q(`INSERT INTO worker_preferred_areas (worker_id, area_id) VALUES ($1, $2)`, [
      workerEProfileId,
      madhapurAreaId,
    ]);

    // 10. Booking Opportunity for Worker A (Awaiting Response)
    // status: MATCHED, workerRespondedAt: null -> appears in GET /workers/me/opportunities
    const opportunityBookingId = (
      await q(
        `INSERT INTO bookings (
          id, customer_user_id, worker_id, category_id, area_id, address_id,
          engagement, from_minute, to_minute, status, worker_responded_at, respond_by,
          start_date, requirement_note, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          'PART_TIME', 540, 720, 'MATCHED', null, now() + interval '24 hours',
          current_date + 2, 'Need daily morning house cleaning and utensil washing.', now(), now()
        ) RETURNING id`,
        [customerUserId, workerAProfileId, maidCat, madhapurAreaId, addressId],
      )
    ).rows[0].id;

    await q(
      `INSERT INTO booking_events (id, booking_id, from_status, to_status, actor_kind, created_at)
       VALUES (gen_random_uuid(), $1, null, 'MATCHED', 'CUSTOMER', now())`,
      [opportunityBookingId],
    );

    // 11. Active Booking for Worker A (Already accepted and started)
    const activeBookingId = (
      await q(
        `INSERT INTO bookings (
          id, customer_user_id, worker_id, category_id, area_id, address_id,
          engagement, from_minute, to_minute, status, worker_responded_at,
          start_date, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5,
          'FULL_TIME', 480, 1020, 'ACTIVE', now() - interval '3 days',
          current_date - 1, now() - interval '4 days', now() - interval '1 day'
        ) RETURNING id`,
        [customerUserId, workerAProfileId, maidCat, madhapurAreaId, addressId],
      )
    ).rows[0].id;

    await q(
      `INSERT INTO booking_events (id, booking_id, from_status, to_status, actor_kind, created_at)
       VALUES (gen_random_uuid(), $1, 'CONFIRMED', 'ACTIVE', 'CUSTOMER', now() - interval '1 day')`,
      [activeBookingId],
    );

    await db.query('COMMIT');

    console.log('Deterministic test worker data seeded successfully:');
    console.log(
      `- Worker A (Active & Verified): ${NUMBERS.workerA} (Opportunities booking: ${opportunityBookingId}, Active booking: ${activeBookingId})`,
    );
    console.log(`- Worker B (Pending Verification): ${NUMBERS.workerB}`);
    console.log(`- Worker C (Verification Rejected): ${NUMBERS.workerC}`);
    console.log(`- Worker D (Draft Profile): ${NUMBERS.workerD}`);
    console.log(`- Worker E (Suspended / Blacklisted): ${NUMBERS.workerE}`);
    console.log(`- Customer: ${NUMBERS.customer}`);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error('Seed test workers failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
