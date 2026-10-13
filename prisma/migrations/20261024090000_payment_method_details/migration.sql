-- Display details of a payment: method, masked method detail, gateway failure code. Additive.
ALTER TABLE "payments"
  ADD COLUMN "failure_code" TEXT,
  ADD COLUMN "payment_method" TEXT,
  ADD COLUMN "payment_method_detail" TEXT;
