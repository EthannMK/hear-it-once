/** Consistent, safe error model. `safeMessage` is the only text that may reach clients. */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_MISMATCH'
  | 'VERIFICATION_REQUIRED'
  | 'CONSENT_REQUIRED'
  | 'POLICY_DENIED'
  | 'SOURCE_DATA_UNSAFE'
  | 'OPERATION_OUTCOME_UNKNOWN'
  | 'RATE_LIMITED'
  | 'ASSISTANT_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_MISMATCH: 409,
  VERIFICATION_REQUIRED: 403,
  CONSENT_REQUIRED: 422,
  POLICY_DENIED: 422,
  SOURCE_DATA_UNSAFE: 422,
  OPERATION_OUTCOME_UNKNOWN: 409,
  RATE_LIMITED: 429,
  ASSISTANT_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly safeMessage: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${safeMessage}`);
    this.status = STATUS[code];
  }
}
export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
