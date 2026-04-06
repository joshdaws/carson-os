/**
 * Telegram error classifier -- pure functions for categorizing Grammy errors.
 *
 * Classifies errors from the Telegram Bot API into actionable categories
 * so the relay can respond appropriately: silent retry, restart, back off,
 * or surface a message to the user.
 *
 * Grammy error types:
 *   - GrammyError: Telegram API returned an error (has error_code, description, parameters)
 *   - HttpError:   Network-level failure (wraps the underlying fetch/socket error)
 *   - BotError:    Middleware wrapper (has .error with the real cause)
 */

import { GrammyError, HttpError, BotError } from "grammy";

// ── Types ───────────────────────────────────────────────────────────

export type ErrorCategory =
  | "retriable_network"
  | "conflict_409"
  | "rate_limit_429"
  | "dead_token_401"
  | "telegram_server_5xx"
  | "client_error_4xx"
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  retryAfterMs?: number;
  userMessage?: string;
  shouldRestartBot?: boolean;
  shouldMarkAgentIdle?: boolean;
}

// ── Constants ───────────────────────────────────────────────────────

const NETWORK_ERROR_CODES = [
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ENETUNREACH",
];

const NETWORK_ERROR_NAMES = ["AbortError", "TimeoutError", "FetchError"];

const MAX_BACKOFF_MS = 30_000;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Unwrap a BotError to get the real cause. Grammy wraps middleware errors
 * in BotError, so the actual GrammyError or HttpError is inside .error.
 */
function unwrap(error: unknown): unknown {
  if (error instanceof BotError) {
    return error.error;
  }
  return error;
}

/**
 * Check if an error message contains any of the known network error codes.
 */
function hasNetworkErrorCode(message: string): boolean {
  return (
    NETWORK_ERROR_CODES.some((code) => message.includes(code)) ||
    NETWORK_ERROR_NAMES.some((name) => message.includes(name))
  );
}

/**
 * Calculate exponential backoff delay for a given attempt number.
 * Attempt 0 = 1s, attempt 1 = 2s, attempt 2 = 4s, capped at MAX_BACKOFF_MS.
 */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

// ── Classifiers ─────────────────────────────────────────────────────

/**
 * Classify a GrammyError (Telegram API responded with an error code).
 */
function classifyGrammyError(err: GrammyError): ClassifiedError {
  const code = err.error_code;
  const retryAfterSeconds = err.parameters?.retry_after;

  // 409: another getUpdates is polling
  if (code === 409) {
    return {
      category: "conflict_409",
      retryable: false,
      retryAfterMs: 5_000,
      shouldRestartBot: true,
    };
  }

  // 429: rate limited
  if (code === 429) {
    const waitSeconds = retryAfterSeconds ?? 10;
    const waitMs = waitSeconds * 1000;
    return {
      category: "rate_limit_429",
      retryable: true,
      retryAfterMs: waitMs,
      userMessage: waitSeconds > 10 ? "I'm busy, give me a moment." : undefined,
    };
  }

  // 401 / 403: dead or revoked token
  if (code === 401 || code === 403) {
    return {
      category: "dead_token_401",
      retryable: false,
      shouldMarkAgentIdle: true,
    };
  }

  // 5xx: Telegram server error
  if (code >= 500 && code <= 599) {
    return {
      category: "telegram_server_5xx",
      retryable: true,
      retryAfterMs: 5_000,
    };
  }

  // Other 4xx: client error (bug in our code)
  if (code >= 400 && code < 500) {
    return {
      category: "client_error_4xx",
      retryable: false,
      userMessage: "Something went wrong.",
    };
  }

  return {
    category: "unknown",
    retryable: false,
    userMessage: "Something went wrong.",
  };
}

/**
 * Classify an HttpError (network-level failure before Telegram could respond).
 */
function classifyHttpError(err: HttpError): ClassifiedError {
  const innerMessage =
    err.error instanceof Error ? err.error.message : String(err.error);
  const combinedMessage = `${err.message} ${innerMessage}`;

  if (hasNetworkErrorCode(combinedMessage)) {
    return {
      category: "retriable_network",
      retryable: true,
      retryAfterMs: 1_000, // caller should use backoffMs(attempt) instead
    };
  }

  // HttpError without a recognized network code -- still likely transient
  // but we don't know for sure. Treat as retriable once.
  return {
    category: "retriable_network",
    retryable: true,
    retryAfterMs: 2_000,
  };
}

/**
 * Classify a raw Error that isn't a Grammy type (e.g. Node fetch errors
 * that escaped Grammy's wrapping, or errors from our own code).
 */
function classifyRawError(err: Error): ClassifiedError {
  const message = err.message || "";
  const name = err.name || "";

  if (hasNetworkErrorCode(message) || hasNetworkErrorCode(name)) {
    return {
      category: "retriable_network",
      retryable: true,
      retryAfterMs: 1_000,
    };
  }

  return {
    category: "unknown",
    retryable: false,
    userMessage: "Something went wrong.",
  };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Classify any error thrown during Telegram bot operation into an
 * actionable category with retry/restart/user-message guidance.
 *
 * Handles Grammy's error hierarchy (BotError > GrammyError / HttpError)
 * as well as raw JS errors from network failures.
 */
export function classifyTelegramError(error: unknown): ClassifiedError {
  const unwrapped = unwrap(error);

  if (unwrapped instanceof GrammyError) {
    return classifyGrammyError(unwrapped);
  }

  if (unwrapped instanceof HttpError) {
    return classifyHttpError(unwrapped);
  }

  if (unwrapped instanceof Error) {
    return classifyRawError(unwrapped);
  }

  // Non-Error throw (string, number, etc.)
  return {
    category: "unknown",
    retryable: false,
    userMessage: "Something went wrong.",
  };
}

/**
 * Check specifically for a 409 conflict on getUpdates polling.
 * This is the "terminated by other getUpdates" scenario where another
 * process is polling the same bot token.
 *
 * Use this in the bot.catch() handler or getUpdates error callback
 * to decide whether to restart the bot.
 */
export function isGetUpdatesConflict(error: unknown): boolean {
  const unwrapped = unwrap(error);

  if (!(unwrapped instanceof GrammyError)) {
    return false;
  }

  if (unwrapped.error_code !== 409) {
    return false;
  }

  // Telegram's description for this case
  const desc = unwrapped.description?.toLowerCase() ?? "";
  return (
    desc.includes("terminated by other getupdates") ||
    desc.includes("conflict") ||
    // Fallback: any 409 on getUpdates is likely this
    unwrapped.method === "getUpdates"
  );
}

/**
 * Given a classified error that failed on a 5xx, determine the user message
 * for the second (final) attempt. First attempt is always silent.
 */
export function serverErrorUserMessage(attemptNumber: number): string | undefined {
  return attemptNumber >= 1 ? "Telegram is having issues. Try again shortly." : undefined;
}

/**
 * Maximum number of retries for each error category.
 */
export function maxRetries(category: ErrorCategory): number {
  switch (category) {
    case "retriable_network":
      return 3;
    case "rate_limit_429":
      return 3;
    case "telegram_server_5xx":
      return 1;
    case "conflict_409":
    case "dead_token_401":
    case "client_error_4xx":
    case "unknown":
      return 0;
  }
}
