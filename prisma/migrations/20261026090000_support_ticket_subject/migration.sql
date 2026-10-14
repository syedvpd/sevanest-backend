-- Optional one-line ticket title (D-73). Additive and nullable: existing tickets and older clients are unaffected.
ALTER TABLE "support_tickets" ADD COLUMN "subject" TEXT;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_subject_chk"
  CHECK ("subject" IS NULL OR char_length("subject") BETWEEN 1 AND 120);
