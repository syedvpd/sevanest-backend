-- Reviewer claim time for a verification check (worker verification gap work). Additive, nullable.
ALTER TABLE "worker_verification_checks" ADD COLUMN "claimed_at" TIMESTAMPTZ(6);
