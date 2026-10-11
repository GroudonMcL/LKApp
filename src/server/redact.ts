/**
 * Removes secrets from anything that is about to be logged, stored in the audit log, or
 * returned in an API response.
 *
 * - Object keys that look secret (apiKey, token, authorization, password…) are replaced.
 * - String values are scrubbed of LegendKeeper keys (`lk_…`), Anthropic keys (`sk-ant-…`),
 *   bearer tokens, and any exact secret values passed in.
 */

// Field names that hold secrets. Deliberately specific: counts such as `inputTokens` and the
// one-time `approvalToken` (which the user's own browser must receive) are not secrets.
const SECRET_KEY = /^(?:x-)?(?:.*(?:api[-_]?key|secret|password|passwd|authorization|cookie|credentials?)|(?:access|refresh|auth|bearer|session|id)[-_]?token|token)$/i
const SECRET_PATTERNS: RegExp[] = [
  /\blk_[A-Za-z0-9_\-]{6,}/g,
  /\bsk-ant-[A-Za-z0-9_\-]{6,}/g,
  /\bBearer\s+[A-Za-z0-9._\-]{8,}/gi,
]
const REDACTED = '[redacted]'

export function redactString(value: string, secrets: string[] = []): string {
  let out = value
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTED)
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

export function redactSecrets<T>(value: T, secrets: string[] = [], depth = 0): T {
  if (depth > 20) return '[too deep]' as T
  if (typeof value === 'string') return redactString(value, secrets) as T
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets, depth + 1)) as T
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: redactString(value.message, secrets) } as T
    }
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactSecrets(inner, secrets, depth + 1)
    }
    return out as T
  }
  return value
}
