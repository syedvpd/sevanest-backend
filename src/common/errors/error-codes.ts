/** Machine-readable error codes returned in the API error envelope. Modules may add their own domain codes. */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode] | (string & {});

export interface ApiErrorDetail {
  field: string;
  messages: string[];
}

/** The single error body returned to every client (BEA p2). Never contains stack traces. */
export interface ApiErrorBody {
  code: ErrorCodeValue;
  message: string;
  details?: ApiErrorDetail[];
  requestId?: string;
}
