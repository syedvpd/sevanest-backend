/**
 * Identity/background verification partner abstraction. The partner is an OPEN decision (SRS §14 item 5) and a manual
 * review fallback is REQUIRED (FR-VER-011): the ManualReview adapter will implement this same interface by queueing
 * the case for a Verification Executive. This interface does NOT define verification states; those are unresolved
 * (conflict C-03) and owned by the Worker Verification module.
 */
export const VERIFICATION_PROVIDER = Symbol('VERIFICATION_PROVIDER');

export interface VerificationRequest {
  /** Our case identifier, echoed back by the partner. */
  caseReference: string;
  checkType: string;
  /** Provider-specific payload prepared by the adapter's caller. Must not be logged. */
  payload: Record<string, unknown>;
}

export interface VerificationProvider {
  /** True if this provider handles the check automatically; false for manual review. */
  readonly isAutomated: boolean;
  submit(request: VerificationRequest): Promise<{ providerReference: string }>;
  getResult(
    providerReference: string,
  ): Promise<{ completed: boolean; passed?: boolean; remarks?: string }>;
}
