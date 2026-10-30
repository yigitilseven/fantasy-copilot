export type YahooErrorCode = "AUTH" | "RATE_LIMIT" | "NETWORK" | "NOT_FOUND" | "PARSE";

/** All Yahoo failures surface as this type so callers can degrade to manual mode. */
export class YahooError extends Error {
  constructor(
    public readonly code: YahooErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "YahooError";
  }
}

export function isYahooError(e: unknown): e is YahooError {
  return e instanceof YahooError;
}

/** Errors for which a different request shape may succeed (used by import fallbacks). */
export function isShapeError(e: unknown): boolean {
  return isYahooError(e) && (e.code === "NOT_FOUND" || e.code === "PARSE");
}
