#!/usr/bin/env node
/**
 * Applies the agreed engagement types (RECOMMENDED_ENGAGEMENTS, read from the compiled app so there is one source) to the six
 * service categories that have NONE yet. A category an administrator already configured, even with an explicit list, is never
 * changed. Writes category_engagements rows and one audit_logs row per category, in one transaction.
 *
 *   npm run build
 *   DATABASE_URL=... node scripts/apply-category-engagements.mjs            # dry run (rolls back)
 *   DATABASE_URL=... CONFIRM_HOSTED=yes node scripts/apply-category-engagements.mjs --apply
 *
 * Undo for one category: PUT /api/v1/admin/service-categories/{id}/engagements with {"engagements": []} (unrestricted again).
 */
import pg from 'pg';
import { RECOMMENDED_ENGAGEMENTS } from '../dist/modules/service-categories/category-seed.service.js';

const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL ?? '';
if (!url) throw new Error('Set DATABASE_URL');
const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
if (!local && process.env.CONFIRM_HOSTED !== 'yes') {
  throw new Error('Hosted database: set CONFIRM_HOSTED=yes after taking a backup');
}

const db = new pg.Client({
  connectionString: url,
  ssl: local ? undefined : { rejectUnauthorized: false },
});

async function main() {
  await db.connect();
  await db.query('BEGIN');
  const lines = [];
  try {
    for (const [code, engagements] of Object.entries(RECOMMENDED_ENGAGEMENTS)) {
      const cat = (
        await db.query(`SELECT id FROM service_categories WHERE code = $1 FOR UPDATE`, [code])
      ).rows[0];
      if (!cat) {
        lines.push(`${code}: category missing, skipped`);
        continue;
      }
      const has = (
        await db.query(`SELECT 1 FROM category_engagements WHERE category_id = $1 LIMIT 1`, [
          cat.id,
        ])
      ).rowCount;
      if (has) {
        const current = (
          await db.query(
            `SELECT engagement FROM category_engagements WHERE category_id = $1 ORDER BY 1`,
            [cat.id],
          )
        ).rows.map((r) => r.engagement);
        lines.push(`${code}: already configured (${current.join(', ')}), left as is`);
        continue;
      }
      const list = [...engagements].sort();
      for (const e of list) {
        await db.query(
          `INSERT INTO category_engagements (category_id, engagement) VALUES ($1, $2::"EngagementPreference")`,
          [cat.id, e],
        );
      }
      await db.query(
        `INSERT INTO audit_logs (id, action, entity_type, entity_id, actor_id, metadata, created_at)
         VALUES (gen_random_uuid(), 'service_category.engagements_seeded', 'service_category', $1, NULL, $2::jsonb, now())`,
        [cat.id, JSON.stringify({ code, to: list })],
      );
      lines.push(`${code}: set to ${list.join(', ')}`);
    }
    await db.query(APPLY ? 'COMMIT' : 'ROLLBACK');
    lines.push(APPLY ? 'APPLIED (committed)' : 'DRY RUN: rolled back, nothing written');
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
    console.log(lines.join('\n'));
  }
}

main().catch((error) => {
  console.error('ERROR:', error.message.replace(/postgres(ql)?:\/\/[^@\s]+@/g, 'postgres://***@'));
  process.exit(1);
});
