/**
 * Provider failure classification + retry policy shared by the engine and every
 * provider implementation (Anthropic, OpenAI-compatible, demo/tests).
 *
 * Retryable: HTTP 429, HTTP 5xx/408, transient network failures, and provider
 * request timeouts. Permanent: any other 4xx, aborts, and unknown errors.
 */

export type ProviderErrorKind =
  | "rate_limited"
  | "server"
  | "network"
  | "timeout"
  | "permanent"
  | "aborted";

export type ProviderErrorOptions = {
  kind: ProviderErrorKind;
  retryable: boolean;
  status?: number;
  /** Server-requested delay (Retry-After header) in ms. */
  retryAfterMs?: number;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = "ProviderError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export type RetryPolicy = {
  /** Total attempts including the first one. `1` disables retries. */
  maxAttempts: number;
  /** First backoff delay in ms. */
  initialDelayMs: number;
  /** Backoff cap in ms. */
  maxDelayMs: number;
  /** Exponential factor between attempts. */
  factor: number;
  /** Jitter as a fraction of the computed delay (0…1). */
  jitter: number;
  /** Per-attempt request timeout in ms; aborts a hung stream. */
  timeoutMs: number;
};

export const DEFAULT_PROVIDER_RETRY: RetryPolicy = {
  maxAttempts: 4,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: 0.25,
  timeoutMs: 120_000,
};

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function statusOf(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = (value as { status?: unknown; statusCode?: unknown }).status ??
    (value as { statusCode?: unknown }).statusCode;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return Math.trunc(candidate);
  }
  return undefined;
}

function codeOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Build the classified error a provider throws for a non-2xx HTTP response. */
export function providerHttpError(
  providerId: string,
  status: number,
  body: string,
  retryAfterHeader?: string | null,
): ProviderError {
  const detail = body.trim().slice(0, 800);
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  const base = `${providerId} HTTP ${status}`;
  if (status === 429) {
    return new ProviderError(
      `${base} (rate limited)${detail ? `: ${detail}` : ""}`,
      { kind: "rate_limited", retryable: true, status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }
  if (status >= 500 || status === 408) {
    return new ProviderError(
      `${base} (server error)${detail ? `: ${detail}` : ""}`,
      { kind: "server", retryable: true, status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }
  return new ProviderError(`${base}${detail ? `: ${detail}` : ""}`, {
    kind: "permanent",
    retryable: false,
    status,
  });
}

/** Classify any thrown provider/stream error into a retryable or permanent one. */
export function classifyProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const code = codeOf(error);
  const status = statusOf(error) ?? /\b(4\d{2}|5\d{2})\b/.exec(message)?.[1] ? Number(/\b(4\d{2}|5\d{2})\b/.exec(message)?.[1]) : undefined;

  if (name === "AbortError") {
    return new ProviderError("Provider request was aborted.", {
      kind: "aborted",
      retryable: false,
      cause: error,
    });
  }
  if (status === 429 || /rate[\s_-]?limit/i.test(message)) {
    return new ProviderError(message, {
      kind: "rate_limited",
      retryable: true,
      ...(status !== undefined ? { status } : {}),
      cause: error,
    });
  }
  if (status !== undefined && (status >= 500 || status === 408)) {
    return new ProviderError(message, {
      kind: "server",
      retryable: true,
      status,
      cause: error,
    });
  }
  if (status !== undefined) {
    return new ProviderError(message, {
      kind: "permanent",
      retryable: false,
      status,
      cause: error,
    });
  }
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return new ProviderError(message, {
      kind: "network",
      retryable: true,
      cause: error,
    });
  }
  if (
    error instanceof TypeError ||
    /fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|timed? ?out|timeout/i.test(
      message,
    )
  ) {
    return new ProviderError(message, {
      kind: "network",
      retryable: true,
      cause: error,
    });
  }
  return new ProviderError(message, {
    kind: "permanent",
    retryable: false,
    cause: error,
  });
}

/** Timeout error raised by the engine's per-attempt request deadline. */
export function providerTimeoutError(timeoutMs: number): ProviderError {
  return new ProviderError(
    `Provider request timed out after ${timeoutMs}ms.`,
    { kind: "timeout", retryable: true },
  );
}

/** Exponential backoff with jitter for the next attempt (1 = first retry). */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * policy.factor ** exponent,
  );
  const spread = base * Math.max(0, Math.min(1, policy.jitter));
  const delay = base - spread + random() * spread * 2;
  return Math.max(0, Math.round(delay));
}
