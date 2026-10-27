#!/usr/bin/env node
/**
 * Demo-data refresh: replaces the repeated demo people with varied, realistic, FICTIONAL ones and gives every service category
 * three workers. Touches ONLY the demo accounts below (mobiles +919000000101..120 and +919000000201..206). Any other account
 * (developers, testers, real users) is never read or written. Nothing is deleted except moving duplicate area associations.
 *
 *   DATABASE_URL=... node scripts/seed-demo-refresh.mjs            # dry run: prints the plan, writes nothing
 *   DATABASE_URL=... node scripts/seed-demo-refresh.mjs --apply    # one transaction, row-count checked
 *
 * Idempotent: a second --apply finds every row already refreshed and changes nothing. A hosted (non-local) database needs
 * CONFIRM_HOSTED=yes; take a backup first (pg_dump). Names, e-mails (example.com) and prices are invented; no real person,
 * document or phone number is used.
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL ?? '';
if (!url) throw new Error('Set DATABASE_URL');
const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
if (!local && process.env.CONFIRM_HOSTED !== 'yes') {
  throw new Error('Hosted database: set CONFIRM_HOSTED=yes after taking a backup');
}

const m = (n) => `+91900000${String(n).padStart(4, '0')}`;

/** mobile -> refreshed worker. `was` is the name the seed gave them (guard: only that or the new name is accepted). */
const EXISTING_WORKERS = [
  {
    n: 101,
    was: 'Lakshmi Devi',
    name: 'Sarojini Kolla',
    months: 60,
    pay: 12000,
    langs: ['te', 'hi'],
  },
  {
    n: 102,
    was: 'Sunita Yadav',
    name: 'Shabana Begum',
    months: 48,
    pay: 13500,
    langs: ['ur', 'hi', 'te'],
  },
  {
    n: 103,
    was: 'Padma Reddy',
    name: 'Jyothi Mandava',
    months: 84,
    pay: 15000,
    langs: ['te', 'hi', 'en'],
  },
  {
    n: 104,
    was: 'Rekha Kumari',
    name: 'Rukmini Pandey',
    months: 24,
    pay: 11500,
    langs: ['hi', 'te'],
  },
  {
    n: 105,
    was: 'Ramesh Naik',
    name: 'Venkat Rao Pasham',
    months: 108,
    pay: 22000,
    langs: ['te', 'hi', 'en'],
    to: 'DRIVER',
  },
  {
    n: 106,
    was: 'Savitri Bai',
    name: 'Sakuntala Varma',
    months: 96,
    pay: 17000,
    langs: ['te', 'en'],
  },
  {
    n: 107,
    was: 'Anwar Hussain',
    name: 'Zainab Sultana',
    months: 30,
    pay: 12500,
    langs: ['ur', 'hi', 'te'],
  },
  {
    n: 108,
    was: 'Geeta Sharma',
    name: 'Pushpa Lingam',
    months: 72,
    pay: 13000,
    langs: ['te', 'ta', 'hi'],
  },
  {
    n: 109,
    was: 'Mary Joseph',
    name: 'Mercy Dsouza',
    months: 18,
    pay: 14000,
    langs: ['en', 'te', 'hi'],
  },
  {
    n: 110,
    was: 'Kavitha Rao',
    name: 'Anusha Vemuri',
    months: 42,
    pay: 18000,
    langs: ['en', 'te'],
    to: 'BABYSITTER',
  },
  {
    n: 111,
    was: 'Narsimha Goud',
    name: 'Mohammed Irfan',
    months: 72,
    pay: 21000,
    langs: ['ur', 'hi', 'te', 'en'],
    to: 'DRIVER',
  },
  {
    n: 112,
    was: 'Bhavani Devi',
    name: 'Vijaya Kumari Pothula',
    months: 90,
    pay: 19000,
    langs: ['te', 'hi'],
    to: 'ELDERLY_CARE_HELPER',
  },
];

const PROFILE = {
  DRIVER: { pref: 'FULL_TIME', window: [360, 1200], areas: ['Madhapur', 'Gachibowli', 'Kondapur'] },
  BABYSITTER: {
    pref: 'FULL_TIME',
    window: [480, 1260],
    areas: ['Banjara Hills', 'Jubilee Hills', 'HITEC City'],
  },
  ELDERLY_CARE_HELPER: {
    pref: 'FULL_TIME',
    window: [360, 1260],
    areas: ['Kukatpally', 'Miyapur', 'Madhapur'],
  },
  CLEANING_HELPER: {
    pref: 'HOURLY',
    window: [480, 1080],
    areas: ['Kondapur', 'Gachibowli', 'HITEC City'],
  },
};

const NEW_WORKERS = [
  {
    n: 113,
    name: 'Srinivas Gadde',
    cat: 'DRIVER',
    months: 120,
    pay: 24000,
    langs: ['te', 'hi', 'en'],
  },
  {
    n: 114,
    name: 'Deepika Nair',
    cat: 'BABYSITTER',
    months: 30,
    pay: 17000,
    langs: ['en', 'hi', 'ml'],
  },
  {
    n: 115,
    name: 'Farida Khatoon',
    cat: 'BABYSITTER',
    months: 54,
    pay: 16000,
    langs: ['ur', 'hi', 'te'],
  },
  {
    n: 116,
    name: 'Annamma Thomas',
    cat: 'ELDERLY_CARE_HELPER',
    months: 66,
    pay: 20000,
    langs: ['en', 'ml', 'te'],
  },
  {
    n: 117,
    name: 'Rehana Parveen',
    cat: 'ELDERLY_CARE_HELPER',
    months: 48,
    pay: 18500,
    langs: ['ur', 'hi', 'te'],
  },
  {
    n: 118,
    name: 'Bharathi Gundla',
    cat: 'CLEANING_HELPER',
    months: 36,
    pay: 11000,
    langs: ['te', 'hi'],
  },
  {
    n: 119,
    name: 'Saidulu Banoth',
    cat: 'CLEANING_HELPER',
    months: 28,
    pay: 12000,
    langs: ['te', 'hi'],
  },
  {
    n: 120,
    name: 'Kamala Mudiraj',
    cat: 'CLEANING_HELPER',
    months: 60,
    pay: 10500,
    langs: ['te', 'hi', 'en'],
  },
];

/** mobile -> refreshed customer and the address text for the default (Home) address; the first also keeps its Office address. */
const CUSTOMERS = [
  {
    n: 201,
    was: 'Anita Rao',
    name: 'Sneha Kulkarni',
    email: 'sneha.kulkarni@example.com',
    line: 'Flat 402, Aditya Heights, Road No. 36',
    pin: '500081',
  },
  {
    n: 202,
    was: 'Vikram Singh',
    name: 'Rajesh Agarwal',
    email: 'rajesh.agarwal@example.com',
    line: 'Villa 18, Lanco Hills Road',
    pin: '500084',
  },
  {
    n: 203,
    was: 'Priya Menon',
    name: 'Meera Subramanian',
    email: 'meera.subramanian@example.com',
    line: '12-5-77, Gachibowli Main Road',
    pin: '500032',
  },
  {
    n: 204,
    was: 'Arjun Reddy',
    name: 'Imran Qureshi',
    email: 'imran.qureshi@example.com',
    line: 'Flat 7B, Sri Sai Residency, Hitech Road',
    pin: '500081',
  },
  {
    n: 205,
    was: 'Fatima Khan',
    name: 'Divya Chowdary',
    email: 'divya.chowdary@example.com',
    line: 'H.No 8-2-120, Road No. 45',
    pin: '500033',
  },
  {
    n: 206,
    was: 'Suresh Iyer',
    name: 'Harish Balakrishnan',
    email: 'harish.balakrishnan@example.com',
    line: 'Plot 31, Road No. 12',
    pin: '500034',
  },
];

const DUP_AREA = 'Hitech City';
const KEEP_AREA = 'HITEC City';

const db = new pg.Client({
  connectionString: url,
  ssl: local ? undefined : { rejectUnauthorized: false },
});
const report = [];
const say = (line) => report.push(line);

async function one(sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0];
}

/** The D-90 steps that make a worker live: application reference, verification sign-off and activation (set only when still empty). */
async function goLive(workerId, admin) {
  await db.query(
    `UPDATE worker_profiles SET
       application_reference = COALESCE(application_reference, 'SEVA' || lpad(nextval('worker_application_reference_seq')::text, 8, '0')),
       verification_signed_off_at = COALESCE(verification_signed_off_at, now()),
       verification_signed_off_by_user_id = COALESCE(verification_signed_off_by_user_id, $2),
       activated_at = COALESCE(activated_at, now()),
       activated_by_user_id = COALESCE(activated_by_user_id, $2),
       updated_at = now()
     WHERE id = $1`,
    [workerId, admin],
  );
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  try {
    const admin =
      (await one(`SELECT id FROM users WHERE type = 'ADMIN' ORDER BY created_at LIMIT 1`))?.id ??
      null;
    const cat = Object.fromEntries(
      (await db.query(`SELECT code, id FROM service_categories`)).rows.map((r) => [r.code, r.id]),
    );
    const area = Object.fromEntries(
      (await db.query(`SELECT name, id FROM service_areas WHERE city = 'Hyderabad'`)).rows.map(
        (r) => [r.name, r.id],
      ),
    );
    for (const c of [
      'HOUSE_MAID',
      'COOK',
      'DRIVER',
      'BABYSITTER',
      'ELDERLY_CARE_HELPER',
      'CLEANING_HELPER',
    ]) {
      if (!cat[c]) throw new Error(`Category ${c} is missing; run npm run seed first`);
    }

    // ---- 1. duplicate area ---------------------------------------------------------------------------------------------
    if (area[DUP_AREA] && area[KEEP_AREA]) {
      const src = area[DUP_AREA];
      const dst = area[KEEP_AREA];
      const moved = {
        preferred: (
          await one(`SELECT count(*)::int n FROM worker_preferred_areas WHERE area_id = $1`, [src])
        ).n,
        bookings: (await one(`SELECT count(*)::int n FROM bookings WHERE area_id = $1`, [src])).n,
        pricing: (
          await one(`SELECT count(*)::int n FROM pricing_guidance WHERE area_id = $1`, [src])
        ).n,
        addresses: (
          await one(`SELECT count(*)::int n FROM customer_addresses WHERE area = $1`, [DUP_AREA])
        ).n,
      };
      if (moved.pricing > 0)
        throw new Error('pricing_guidance rows reference the duplicate area: review by hand');
      await db.query(
        `INSERT INTO worker_preferred_areas (worker_id, area_id) SELECT worker_id, $2 FROM worker_preferred_areas WHERE area_id = $1 ON CONFLICT DO NOTHING`,
        [src, dst],
      );
      await db.query(`DELETE FROM worker_preferred_areas WHERE area_id = $1`, [src]);
      await db.query(`UPDATE bookings SET area_id = $2 WHERE area_id = $1`, [src, dst]);
      await db.query(`UPDATE customer_addresses SET area = $2 WHERE area = $1`, [
        DUP_AREA,
        KEEP_AREA,
      ]);
      await db.query(
        `UPDATE service_areas SET is_enabled = false, updated_at = now() WHERE id = $1`,
        [src],
      );
      say(`area: "${DUP_AREA}" merged into "${KEEP_AREA}" and disabled ${JSON.stringify(moved)}`);
    } else {
      say(
        `area: nothing to merge (${DUP_AREA} present: ${Boolean(area[DUP_AREA])}, ${KEEP_AREA} present: ${Boolean(area[KEEP_AREA])})`,
      );
    }

    // ---- 2. existing demo workers --------------------------------------------------------------------------------------
    for (const w of EXISTING_WORKERS) {
      const row = await one(
        `SELECT wp.id, wp.name, wp.onboarding_status st FROM worker_profiles wp JOIN users u ON u.id = wp.user_id WHERE u.mobile = $1`,
        [m(w.n)],
      );
      if (!row) {
        say(`worker ${m(w.n)}: not found, skipped`);
        continue;
      }
      if (row.name !== w.was && row.name !== w.name) {
        throw new Error(
          `${m(w.n)} is named "${row.name}", expected "${w.was}" or "${w.name}": not a demo row, stopping`,
        );
      }
      await db.query(
        `UPDATE worker_profiles SET name = $2, experience_months = $3, expected_salary = $4, updated_at = now() WHERE id = $1`,
        [row.id, w.name, w.months, w.pay],
      );
      await db.query(`DELETE FROM worker_languages WHERE worker_id = $1`, [row.id]);
      for (const l of w.langs)
        await db.query(`INSERT INTO worker_languages (worker_id, language_code) VALUES ($1, $2)`, [
          row.id,
          l,
        ]);
      if (w.to) {
        const p = PROFILE[w.to];
        await db.query(`DELETE FROM worker_skills WHERE worker_id = $1`, [row.id]);
        await db.query(`INSERT INTO worker_skills (worker_id, category_id) VALUES ($1, $2)`, [
          row.id,
          cat[w.to],
        ]);
        await db.query(`DELETE FROM worker_preferred_areas WHERE worker_id = $1`, [row.id]);
        for (const a of p.areas) {
          await db.query(
            `INSERT INTO worker_preferred_areas (worker_id, area_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [row.id, area[a]],
          );
        }
        await db.query(`DELETE FROM worker_time_windows WHERE worker_id = $1`, [row.id]);
        await db.query(
          `INSERT INTO worker_time_windows (id, worker_id, start_minute, end_minute) VALUES (gen_random_uuid(), $1, $2, $3)`,
          [row.id, ...p.window],
        );
        await db.query(
          `INSERT INTO worker_work_preferences (worker_id, engagement_preference, updated_at) VALUES ($1, $2::"EngagementPreference", now())
           ON CONFLICT (worker_id) DO UPDATE SET engagement_preference = EXCLUDED.engagement_preference, updated_at = now()`,
          [row.id, p.pref],
        );
        if (row.st !== 'SUBMITTED') {
          await db.query(
            `UPDATE worker_profiles SET onboarding_status = 'SUBMITTED'::"WorkerOnboardingStatus", submitted_at = now() WHERE id = $1`,
            [row.id],
          );
        }
        const check = await one(
          `SELECT id, status FROM worker_verification_checks WHERE worker_id = $1 AND check_type = 'IDENTITY'`,
          [row.id],
        );
        if (!check) {
          await db.query(
            `INSERT INTO worker_verification_checks (id, worker_id, check_type, status, submitted_at, reviewed_at, reviewer_user_id, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, 'IDENTITY', 'APPROVED', now(), now(), $2, now(), now())`,
            [row.id, admin],
          );
        } else if (check.status !== 'APPROVED') {
          await db.query(
            `UPDATE worker_verification_checks SET status = 'APPROVED', reviewed_at = now(), reviewer_user_id = $2, updated_at = now() WHERE id = $1`,
            [check.id, admin],
          );
        }
      }
      if (w.to) await goLive(row.id, admin);
      say(`worker ${m(w.n)}: ${row.name} -> ${w.name}${w.to ? ` (now ${w.to})` : ''}`);
    }

    // ---- 3. new workers ------------------------------------------------------------------------------------------------
    for (const w of NEW_WORKERS) {
      const exists = await one(
        `SELECT wp.id FROM users u JOIN worker_profiles wp ON wp.user_id = u.id WHERE u.mobile = $1`,
        [m(w.n)],
      );
      if (exists) {
        await goLive(exists.id, admin);
        say(`new worker ${m(w.n)}: already present (go-live steps ensured)`);
        continue;
      }
      const p = PROFILE[w.cat];
      const u = (
        await one(
          `INSERT INTO users (id, type, mobile, status, created_at, updated_at) VALUES (gen_random_uuid(), 'WORKER', $1, 'ACTIVE', now(), now()) RETURNING id`,
          [m(w.n)],
        )
      ).id;
      const id = (
        await one(
          `INSERT INTO worker_profiles (id, user_id, name, onboarding_status, submitted_at, experience_months, expected_salary, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'SUBMITTED'::"WorkerOnboardingStatus", now(), $3, $4, now(), now()) RETURNING id`,
          [u, w.name, w.months, w.pay],
        )
      ).id;
      await db.query(`INSERT INTO worker_skills (worker_id, category_id) VALUES ($1, $2)`, [
        id,
        cat[w.cat],
      ]);
      for (const a of p.areas)
        await db.query(
          `INSERT INTO worker_preferred_areas (worker_id, area_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, area[a]],
        );
      await db.query(
        `INSERT INTO worker_time_windows (id, worker_id, start_minute, end_minute) VALUES (gen_random_uuid(), $1, $2, $3)`,
        [id, ...p.window],
      );
      await db.query(
        `INSERT INTO worker_work_preferences (worker_id, engagement_preference, updated_at) VALUES ($1, $2::"EngagementPreference", now())`,
        [id, p.pref],
      );
      for (const l of w.langs)
        await db.query(`INSERT INTO worker_languages (worker_id, language_code) VALUES ($1, $2)`, [
          id,
          l,
        ]);
      await db.query(
        `INSERT INTO worker_verification_checks (id, worker_id, check_type, status, submitted_at, reviewed_at, reviewer_user_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'IDENTITY', 'APPROVED', now(), now(), $2, now(), now())`,
        [id, admin],
      );
      await goLive(id, admin);
      say(`new worker ${m(w.n)}: ${w.name} (${w.cat})`);
    }

    // ---- 4. demo customers ---------------------------------------------------------------------------------------------
    for (const c of CUSTOMERS) {
      const row = await one(
        `SELECT cp.id, cp.name FROM customer_profiles cp JOIN users u ON u.id = cp.user_id WHERE u.mobile = $1`,
        [m(c.n)],
      );
      if (!row) {
        say(`customer ${m(c.n)}: not found, skipped`);
        continue;
      }
      if (row.name !== c.was && row.name !== c.name) {
        throw new Error(
          `${m(c.n)} is named "${row.name}", expected "${c.was}" or "${c.name}": not a demo row, stopping`,
        );
      }
      await db.query(
        `UPDATE customer_profiles SET name = $2, email = $3, updated_at = now() WHERE id = $1`,
        [row.id, c.name, c.email],
      );
      const home = await one(
        `SELECT id, area FROM customer_addresses WHERE customer_id = $1 AND is_default AND is_active LIMIT 1`,
        [row.id],
      );
      if (home) {
        await db.query(
          `UPDATE customer_addresses SET line = $2, pincode = $3, updated_at = now() WHERE id = $1`,
          [home.id, c.line, c.pin],
        );
      }
      say(`customer ${m(c.n)}: ${row.name} -> ${c.name}`);
    }

    // ---- 5. result checks (inside the transaction) ---------------------------------------------------------------------
    const perCategory = (
      await db.query(
        `SELECT sc.code, count(DISTINCT wp.id)::int n
         FROM service_categories sc
         LEFT JOIN worker_skills ws ON ws.category_id = sc.id
         LEFT JOIN worker_profiles wp ON wp.id = ws.worker_id AND wp.onboarding_status = 'SUBMITTED'
         LEFT JOIN worker_verification_checks vc ON vc.worker_id = wp.id AND vc.check_type = 'IDENTITY' AND vc.status = 'APPROVED'
         WHERE vc.id IS NOT NULL OR wp.id IS NULL
         GROUP BY sc.code ORDER BY sc.code`,
      )
    ).rows;
    say(`verified workers per category after refresh: ${JSON.stringify(perCategory)}`);
    const names = (
      await db.query(
        `SELECT name FROM worker_profiles WHERE user_id IN (SELECT id FROM users WHERE mobile LIKE '+91900000%')`,
      )
    ).rows.map((r) => r.name);
    if (new Set(names).size !== names.length)
      throw new Error('duplicate demo worker names after refresh');

    if (APPLY) {
      await db.query('COMMIT');
      say('APPLIED (committed)');
    } else {
      await db.query('ROLLBACK');
      say('DRY RUN: everything above was rolled back, nothing was written');
    }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
    console.log(report.join('\n'));
  }
}

main().catch((error) => {
  console.error('ERROR:', error.message.replace(/postgres(ql)?:\/\/[^@\s]+@/g, 'postgres://***@'));
  process.exit(1);
});
