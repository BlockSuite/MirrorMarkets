export const ErrorCodes = {
  // Auth
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_TOKEN: 'INVALID_TOKEN',

  // Provisioning
  PROVISIONING_INCOMPLETE: 'PROVISIONING_INCOMPLETE',
  WALLET_ALREADY_EXISTS: 'WALLET_ALREADY_EXISTS',
  PROXY_DEPLOY_FAILED: 'PROXY_DEPLOY_FAILED',

  // Copy Trading
  COPY_ALREADY_ENABLED: 'COPY_ALREADY_ENABLED',
  COPY_NOT_ENABLED: 'COPY_NOT_ENABLED',
  GUARDRAIL_VIOLATION: 'GUARDRAIL_VIOLATION',
  CIRCUIT_BREAKER_OPEN: 'CIRCUIT_BREAKER_OPEN',
  DUPLICATE_COPY: 'DUPLICATE_COPY',

  // Orders
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_SUBMIT_FAILED: 'ORDER_SUBMIT_FAILED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',

  // Follows
  ALREADY_FOLLOWING: 'ALREADY_FOLLOWING',
  NOT_FOLLOWING: 'NOT_FOLLOWING',
  LEADER_NOT_FOUND: 'LEADER_NOT_FOUND',

  // Funds
  WITHDRAWAL_FAILED: 'WITHDRAWAL_FAILED',
  DEPOSIT_ADDRESS_UNAVAILABLE: 'DEPOSIT_ADDRESS_UNAVAILABLE',

  // Claims
  NOTHING_TO_CLAIM: 'NOTHING_TO_CLAIM',
  CLAIM_FAILED: 'CLAIM_FAILED',

  // Signing (Phase 2A)
  SIGNING_UNAVAILABLE: 'SIGNING_UNAVAILABLE',
  SERVER_WALLET_NOT_READY: 'SERVER_WALLET_NOT_READY',
  SERVER_WALLET_CREATION_FAILED: 'SERVER_WALLET_CREATION_FAILED',

  // System
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(ErrorCodes.UNAUTHORIZED, message, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(ErrorCodes.NOT_FOUND, `${resource} not found`, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCodes.VALIDATION_ERROR, message, 400, details);
  }
}

export class ConflictError extends AppError {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 409);
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(ErrorCodes.RATE_LIMITED, 'Too many requests', 429);
  }
}
