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
  /** ISO currency as the gateway reports it; when present it must equal what we asked for. */
  currency?: string;
}

export interface ProviderRefund {
  providerRefundId: string;
  outcome: ProviderPaymentOutcome;
  amountMinor?: number;
}

/** A provider notification reduced to what the Payment module needs. Produced only AFTER the signature was verified. */
export interface ProviderWebhookEvent {
  /** PAYMENT (default) = a payment outcome; REFUND = a refund outcome; IGNORED = authentic but of no interest (acknowledge only). */
  kind?: 'PAYMENT' | 'REFUND' | 'IGNORED';
  /** Unique per notification at the provider; the basis of duplicate protection. */
  eventId: string;
  providerOrderId: string;
  providerPaymentId: string;
  /** Present for REFUND events. */
  providerRefundId?: string;
  outcome: ProviderPaymentOutcome;
  amountMinor: number;
  currency?: string;
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
  /** Adapter-specific parsing of a verified webhook; null if it is malformed. Headers carry the event id for some gateways. */
  parseWebhookEvent(
    rawBody: Buffer,
    headers?: Record<string, string | undefined>,
  ): ProviderWebhookEvent | null;
  /** Source of truth for reconciliation jobs. */
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  /**
   * Authoritative lookup by the order we created (the merchant-side reference): the answer to a lost callback, because we
   * know the order id even when we never learned the payment id. Empty list = the customer has not attempted payment.
   */
  findPaymentsForOrder(providerOrderId: string): Promise<ProviderPayment[]>;
  /** Refunds the gateway holds for a payment (to adopt a refund whose creation response was lost). */
  findRefundsForPayment(providerPaymentId: string): Promise<ProviderRefund[]>;
  /** Authoritative state of one refund. */
  getRefund(providerRefundId: string): Promise<ProviderRefund>;
  refund(input: {
    providerPaymentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<ProviderRefund>;
}
