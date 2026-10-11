/**
 * Identifier helpers.
 *
 * LegendKeeper accepts a client-chosen resource id on create when it is a cuid2-style id:
 * a lowercase letter followed by 7 or 23 lowercase letters or digits (see the API's
 * "Identifiers" section). We choose the id *before* the write and store it with the draft,
 * so after an interrupted write we can ask LegendKeeper whether that exact id exists.
 * A second create with the same id fails with 409 DUPLICATE_ID, so a page can never be
 * created twice from one draft.
 */

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const LOWER_AND_DIGITS = 'abcdefghijklmnopqrstuvwxyz0123456789'

export const LK_RESOURCE_ID_PATTERN = /^[a-z](?:[0-9a-z]{7}|[0-9a-z]{23})$/

function randomChars(alphabet: string, length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  // 256 is not a multiple of 36, so reject the top values to avoid bias.
  const limit = 256 - (256 % alphabet.length)
  for (let i = 0; i < length; i++) {
    let byte = bytes[i]!
    while (byte >= limit) {
      const retry = new Uint8Array(1)
      crypto.getRandomValues(retry)
      byte = retry[0]!
    }
    out += alphabet[byte % alphabet.length]
  }
  return out
}

/** A new 24-character LegendKeeper-compatible resource id. */
export function newLkResourceId(): string {
  return randomChars(LOWER, 1) + randomChars(LOWER_AND_DIGITS, 23)
}

export function isLkResourceId(value: string): boolean {
  return LK_RESOURCE_ID_PATTERN.test(value)
}

/** An id for this app's own records, e.g. `job_k3j…`. */
export function newAppId(prefix: string): string {
  return `${prefix}_${randomChars(LOWER_AND_DIGITS, 16)}`
}

/** Idempotency keys allow 1–255 characters from A-Z a-z 0-9 . _ - */
export function idempotencyKeyFor(...parts: string[]): string {
  return parts
    .join('.')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 255)
}
