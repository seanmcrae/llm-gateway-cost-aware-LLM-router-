/**
 * Errors that cross the HTTP boundary carry an OpenAI-style `type` and `code`, so existing
 * OpenAI clients surface them the same way they surface errors from the upstream API.
 */
export type GatewayErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "rate_limit_error"
  | "insufficient_quota"
  | "upstream_error"
  | "server_error";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly type: GatewayErrorType,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }

  toBody(): { error: { message: string; type: string; code: string; param: null } } {
    return { error: { message: this.message, type: this.type, code: this.code, param: null } };
  }
}

export type ProviderErrorKind =
  "rate_limited" | "overloaded" | "server" | "timeout" | "network" | "auth" | "bad_request";

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limited",
  "overloaded",
  "server",
  "timeout",
  "network",
]);

/** A failed upstream call, classified so the gateway can decide between retry, fallback and abort. */
export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Maps an upstream HTTP status to an error kind. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status === 503 || status === 529) return "overloaded";
  if (status >= 500) return "server";
  return "bad_request";
}

/** Parses a Retry-After header given in seconds or as an HTTP date. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
