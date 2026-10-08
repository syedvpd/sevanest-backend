/**
 * Payment gateway abstraction (FR-PAY-009, EIR-SW-002). Adapters for Razorpay / Cashfree / PayU implement this; the
 * provider choice is an OPEN decision (SRS §14 item 9). Foundation contract: refine together with the Payment module.
 * Amounts are integer minor units (paise). The provider-reported outcome is NOT our payment state machine; the
 * Payment module maps it onto its own (still undefined) states.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export type ProviderPaymentOutcome = 'SUCCEEDED' | 'FAILED' | 'PENDING';

export interface CreateProviderOrderInput {
  amountMinor: number;
  currency: string;
  /** Our internal reference, echoed back by the provider for reconciliation. */
  reference: string;
  /** Makes provider-side creation safe to retry. */
  idempotencyKey: string;
}

export interface ProviderOrder {
  providerOrderId: string;
  /** Opaque data the client SDK / hosted checkout needs. */
  checkoutPayload: Record<string, unknown>;
}

export interface ProviderPayment {
  providerPaymentId: string;
  providerOrderId: string;
  outcome: ProviderPaymentOutcome;
  amountMinor: number;
}

export interface ProviderRefund {
  providerRefundId: string;
  outcome: ProviderPaymentOutcome;
}

export interface PaymentProvider {
  createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder>;
  /** Server-side verification of a client-reported payment. The client's "success" is only a hint (BEA p7). */
  verifyPayment(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): Promise<ProviderPayment>;
  /** Must use the RAW request body and a constant-time comparison. */
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
  /** Source of truth for reconciliation jobs. */
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  refund(input: {
    providerPaymentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<ProviderRefund>;
}
