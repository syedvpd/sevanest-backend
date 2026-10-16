-- DEC-03: a ticket can be escalated by the system when its SLA is missed, so a history event may have no staff actor.
-- Additive (drops a NOT NULL); reverse by backfilling and re-adding NOT NULL in a follow-up migration.
ALTER TABLE "support_ticket_events" ALTER COLUMN "actor_user_id" DROP NOT NULL;
