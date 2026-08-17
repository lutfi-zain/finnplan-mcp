/**
 * Utility functions for ISO-8601 Timestamps with Timezone support
 */

/**
 * Returns current timestamp in ISO-8601 format with UTC indicator (e.g. 2026-08-17T03:31:42.000Z)
 */
export function currentIsoTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Validates whether a string is a valid ISO-8601 Date or Timestamp (with optional timezone offset)
 * Matches:
 * - YYYY-MM-DD
 * - YYYY-MM-DDTHH:mm:ssZ
 * - YYYY-MM-DDTHH:mm:ss.sssZ
 * - YYYY-MM-DDTHH:mm:ss+07:00
 * - YYYY-MM-DDTHH:mm:ss-05:00
 */
export function isValidIsoDateOrTimestamp(dateStr: unknown): boolean {
  if (typeof dateStr !== 'string' || dateStr.trim().length === 0) return false;
  const trimmed = dateStr.trim();

  // Basic ISO regex check
  const isoRegex = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
  if (!isoRegex.test(trimmed)) return false;

  const timestamp = Date.parse(trimmed);
  return !isNaN(timestamp);
}

/**
 * Normalizes input date/timestamp to a standard ISO-8601 timestamp string.
 * If input is "YYYY-MM-DD", normalizes to "YYYY-MM-DDT00:00:00.000Z".
 * If input is already an ISO timestamp with timezone, validates and returns as trimmed string.
 * If input is empty/undefined, returns current ISO timestamp.
 */
export function normalizeToIsoTimestamp(input?: string): string {
  if (!input || input.trim().length === 0) {
    return currentIsoTimestamp();
  }
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }
  if (isValidIsoDateOrTimestamp(trimmed)) {
    return trimmed;
  }
  throw new Error(`Validation Error: Invalid ISO timestamp with timezone '${input}'`);
}
