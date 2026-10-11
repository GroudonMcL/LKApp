import 'server-only'
import { z } from 'zod'
import { runtimeState } from './runtime'

/**
 * Server configuration, read from environment variables (`.env.local`).
 *
 * Secrets are read here and only here, and never leave the server: API responses expose
 * only whether a key is configured and where it came from, never the key itself.
 */

const boolFromEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? fallback : value.trim().toLowerCase() === 'true'))

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? null : value.trim()))

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      const n = value ? Number.parseInt(value, 10) : NaN
      return Number.isFinite(n) && n > 0 ? n : fallback
    })

const EnvSchema = z.object({
  LEGENDKEEPER_API_KEY: optionalString,
  LEGENDKEEPER_BASE_URL: optionalString,
  LKC_ALLOW_WRITES: boolFromEnv(false),
  LKC_SANDBOX_PARENT_ID: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  LKC_AI_ENABLED: boolFromEnv(true),
  LKC_AI_MODEL: optionalString,
  LKC_AI_EFFORT: z
    .string()
    .optional()
    .transform((value) => {
      const effort = value?.trim().toLowerCase()
      return effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max' ? effort : 'high'
    }),
  LKC_DATABASE_PATH: optionalString,
  LKC_MAX_UPLOAD_BYTES: positiveInt(2_000_000),
  LKC_MAX_SOURCE_CHARS: positiveInt(150_000),
})

export type KeySource = 'env' | 'memory' | null
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AppConfig {
  lk: {
    apiKey: string | null
    apiKeySource: KeySource
    baseUrl: string | null
    allowWrites: boolean
    sandboxParentId: string | null
  }
  ai: {
    apiKey: string | null
    apiKeySource: KeySource
    /** False when switched off by environment variable (hard off) or in Settings. */
    enabled: boolean
    disabledByEnv: boolean
    model: string
    effort: AiEffort
  }
  databasePath: string
  limits: { maxUploadBytes: number; maxSourceChars: number }
}

export const DEFAULT_AI_MODEL = 'claude-opus-5-5'

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env)
  const runtime = runtimeState()
  const lkKey = runtime.lkApiKey ?? parsed.LEGENDKEEPER_API_KEY
  const aiKey = runtime.anthropicApiKey ?? parsed.ANTHROPIC_API_KEY
  return {
    lk: {
      apiKey: lkKey,
      apiKeySource: runtime.lkApiKey ? 'memory' : parsed.LEGENDKEEPER_API_KEY ? 'env' : null,
      baseUrl: parsed.LEGENDKEEPER_BASE_URL,
      allowWrites: parsed.LKC_ALLOW_WRITES,
      sandboxParentId: parsed.LKC_SANDBOX_PARENT_ID,
    },
    ai: {
      apiKey: aiKey,
      apiKeySource: runtime.anthropicApiKey ? 'memory' : parsed.ANTHROPIC_API_KEY ? 'env' : null,
      enabled: parsed.LKC_AI_ENABLED && runtime.aiEnabled !== false,
      disabledByEnv: !parsed.LKC_AI_ENABLED,
      model: parsed.LKC_AI_MODEL ?? DEFAULT_AI_MODEL,
      effort: parsed.LKC_AI_EFFORT,
    },
    databasePath: parsed.LKC_DATABASE_PATH ?? './data/lk-companion.db',
    limits: { maxUploadBytes: parsed.LKC_MAX_UPLOAD_BYTES, maxSourceChars: parsed.LKC_MAX_SOURCE_CHARS },
  }
}

/** Values of configured secrets, so logs and stored details can be scrubbed of them. */
export function configuredSecrets(): string[] {
  const config = getConfig()
  return [config.lk.apiKey, config.ai.apiKey].filter((v): v is string => typeof v === 'string' && v.length >= 8)
}
