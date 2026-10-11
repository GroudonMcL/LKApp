import 'server-only'
import type { AppContext } from '../context'
import type { AuditEventInput } from '../db/repositories'
import { redactSecrets } from '../redact'
import { configuredSecrets } from '../config'

/**
 * Records an audit event. Every value is passed through secret redaction first, so an API
 * key can never end up in the audit log even if a caller passes one by mistake.
 * Callers record ids, counts and outcomes — never full source documents.
 */
export function recordAudit(ctx: Pick<AppContext, 'repos'>, event: AuditEventInput): number {
  let secrets: string[] = []
  try {
    secrets = configuredSecrets()
  } catch {
    secrets = []
  }
  return ctx.repos.audit.insert(redactSecrets(event, secrets))
}
