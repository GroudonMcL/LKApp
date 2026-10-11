import 'server-only'
import type { AppContext } from '../context'
import { ConnectorError, toConnectorError } from '../lk/errors'
import type { ProjectInfo } from '../lk/types'
import { recordAudit } from './audit'

export interface ConnectionCheck {
  ok: boolean
  checkedAt: string
  project: ProjectInfo | null
  error: ReturnType<ConnectorError['toJSON']> | null
}

const LAST_CHECK = Symbol.for('lk-companion.last-connection-check')
type Store = Record<symbol, ConnectionCheck | undefined>

export function lastConnectionCheck(): ConnectionCheck | null {
  return (globalThis as unknown as Store)[LAST_CHECK] ?? null
}

/**
 * Tests the LegendKeeper connection with two live reads: `lk.project()` (which project the
 * key belongs to) and `projects.get` (a fresh request that bypasses the SDK's cache).
 */
export async function testConnection(ctx: AppContext): Promise<ConnectionCheck> {
  const checkedAt = ctx.now().toISOString()
  let check: ConnectionCheck
  try {
    const connector = ctx.connector()
    const project = await connector.getProject()
    const fresh = await connector.pingProject(project.id)
    ctx.repos.settings.set('lk.lastProjectId', fresh.id)
    ctx.repos.settings.set('lk.lastProjectName', fresh.name)
    check = { ok: true, checkedAt, project: fresh, error: null }
    recordAudit(ctx, { operation: 'connection.test', outcome: 'success', projectId: fresh.id, message: `Connected to ${fresh.name}` })
  } catch (error) {
    const failure = toConnectorError(error)
    check = { ok: false, checkedAt, project: null, error: failure.toJSON() }
    recordAudit(ctx, { operation: 'connection.test', outcome: 'failure', errorCode: failure.details.code ?? failure.kind, requestId: failure.details.requestId ?? null, message: failure.message })
  }
  ;(globalThis as unknown as Store)[LAST_CHECK] = check
  return check
}

/** The project id from the last successful connection, used to scope the local index. */
export function knownProjectId(ctx: AppContext): string | null {
  return ctx.repos.settings.get<string>('lk.lastProjectId')
}

/** Returns the current project id, contacting LegendKeeper if it is not known yet. */
export async function requireProjectId(ctx: AppContext): Promise<string> {
  const known = knownProjectId(ctx)
  if (known) return known
  const project = await ctx.connector().getProject()
  ctx.repos.settings.set('lk.lastProjectId', project.id)
  ctx.repos.settings.set('lk.lastProjectName', project.name)
  return project.id
}

export function connectionSummary(ctx: AppContext) {
  const config = ctx.config()
  const projectId = knownProjectId(ctx)
  const verification = projectId ? ctx.repos.verifications.latest(projectId, ctx.sdkVersion) : null
  return {
    legendkeeper: {
      keyConfigured: config.lk.apiKey !== null,
      keySource: config.lk.apiKeySource,
      baseUrl: config.lk.baseUrl ?? 'https://www.legendkeeper.com (default)',
      sdkVersion: ctx.sdkVersion,
      lastCheck: lastConnectionCheck(),
      knownProject: projectId ? { id: projectId, name: ctx.repos.settings.get<string>('lk.lastProjectName') } : null,
    },
    writes: {
      allowedByConfig: config.lk.allowWrites,
      sandboxParentId: config.lk.sandboxParentId,
      verification: verification
        ? { verifiedAt: verification.verifiedAt, resourceId: verification.resourceId, sdkVersion: verification.sdkVersion }
        : null,
    },
    ai: {
      enabled: config.ai.enabled,
      disabledByEnv: config.ai.disabledByEnv,
      keyConfigured: config.ai.apiKey !== null,
      keySource: config.ai.apiKeySource,
      model: config.ai.model,
      effort: config.ai.effort,
    },
    limits: config.limits,
  }
}
