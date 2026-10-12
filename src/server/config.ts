import 'server-only'
import { z } from 'zod'
import { join } from 'node:path'
import { appHome, readSettingsFile } from './local-settings'
import { runtimeState } from './runtime'

/**
 * Server configuration, read from environment variables and the settings file on this
 * computer (`.env.local` in the source folder, or `settings.env` in `LKC_HOME`; see
 * local-settings.ts). Values in the settings file apply as soon as it changes.
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
  LKC_ALLOW_WRITES: boolFromEnv(true),
  LKC_SANDBOX_PARENT_ID: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  OPENROUTER_API_KEY: optionalString,
  /** `openrouter` or `anthropic`. Unset: OpenRouter when its key is set, otherwise Anthropic. */
  LKC_AI_PROVIDER: z
    .string()
    .optional()
    .transform((value) => {
      const v = value?.trim().toLowerCase()
      return v === 'openrouter' || v === 'anthropic' ? v : null
    }),
  /** OpenRouter model. Only free models are ever used (see ai/openrouter.ts). */
  LKC_OPENROUTER_MODEL: optionalString,
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
  LKC_MAX_DOCUMENT_BYTES: positiveInt(25_000_000),
})

export type KeySource = 'env' | 'memory' | null
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AiProviderId = 'openrouter' | 'anthropic'

export interface AppConfig {
  lk: {
    apiKey: string | null
    apiKeySource: KeySource
    baseUrl: string | null
    allowWrites: boolean
    sandboxParentId: string | null
  }
  ai: {
    /** Which AI service is used. */
    provider: AiProviderId
    /** How the provider was chosen. */
    providerSource: 'env' | 'settings' | 'default'
    /** The key and model of the chosen provider. */
    apiKey: string | null
    apiKeySource: KeySource
    /** False when switched off by environment variable (hard off) or in Settings. */
    enabled: boolean
    disabledByEnv: boolean
    model: string
    effort: AiEffort
    anthropic: { apiKey: string | null; apiKeySource: KeySource; model: string }
    openrouter: { apiKey: string | null; apiKeySource: KeySource; model: string }
  }
  databasePath: string
  limits: { maxUploadBytes: number; maxSourceChars: number; maxDocumentBytes: number }
}

export const DEFAULT_AI_MODEL = 'claude-opus-5-5'
/** OpenRouter's free-models router: picks an available free model for each request. */
export const DEFAULT_OPENROUTER_MODEL = 'openrouter/free'

/** The environment plus the settings file (re-read when it changes). Tests pass their own environment. */
function effectiveEnv(): NodeJS.ProcessEnv {
  if (process.env.NODE_ENV === 'test') return process.env
  return { ...process.env, ...readSettingsFile(process.env) }
}

export function getConfig(env: NodeJS.ProcessEnv = effectiveEnv()): AppConfig {
  const parsed = EnvSchema.parse(env)
  const home = appHome(env)
  const runtime = runtimeState()
  const lkKey = runtime.lkApiKey ?? parsed.LEGENDKEEPER_API_KEY
  const anthropic = {
    apiKey: runtime.anthropicApiKey ?? parsed.ANTHROPIC_API_KEY,
    apiKeySource: (runtime.anthropicApiKey ? 'memory' : parsed.ANTHROPIC_API_KEY ? 'env' : null) as KeySource,
    model: parsed.LKC_AI_MODEL ?? DEFAULT_AI_MODEL,
  }
  const openrouter = {
    apiKey: runtime.openrouterApiKey ?? parsed.OPENROUTER_API_KEY,
    apiKeySource: (runtime.openrouterApiKey ? 'memory' : parsed.OPENROUTER_API_KEY ? 'env' : null) as KeySource,
    model: parsed.LKC_OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL,
  }
  const provider: AiProviderId = runtime.aiProvider ?? parsed.LKC_AI_PROVIDER ?? (openrouter.apiKey || !anthropic.apiKey ? 'openrouter' : 'anthropic')
  const providerSource = runtime.aiProvider ? 'settings' : parsed.LKC_AI_PROVIDER ? 'env' : 'default'
  const active = provider === 'openrouter' ? openrouter : anthropic
  return {
    lk: {
      apiKey: lkKey,
      apiKeySource: runtime.lkApiKey ? 'memory' : parsed.LEGENDKEEPER_API_KEY ? 'env' : null,
      baseUrl: parsed.LEGENDKEEPER_BASE_URL,
      allowWrites: parsed.LKC_ALLOW_WRITES,
      sandboxParentId: parsed.LKC_SANDBOX_PARENT_ID,
    },
    ai: {
      provider,
      providerSource,
      apiKey: active.apiKey,
      apiKeySource: active.apiKeySource,
      enabled: parsed.LKC_AI_ENABLED && runtime.aiEnabled !== false,
      disabledByEnv: !parsed.LKC_AI_ENABLED,
      model: active.model,
      effort: parsed.LKC_AI_EFFORT,
      anthropic,
      openrouter,
    },
    databasePath: parsed.LKC_DATABASE_PATH ?? (home ? join(home, 'lk-companion.db') : './data/lk-companion.db'),
    limits: { maxUploadBytes: parsed.LKC_MAX_UPLOAD_BYTES, maxSourceChars: parsed.LKC_MAX_SOURCE_CHARS, maxDocumentBytes: parsed.LKC_MAX_DOCUMENT_BYTES },
  }
}

/** Values of configured secrets, so logs and stored details can be scrubbed of them. */
export function configuredSecrets(): string[] {
  const config = getConfig()
  return [config.lk.apiKey, config.ai.anthropic.apiKey, config.ai.openrouter.apiKey].filter((v): v is string => typeof v === 'string' && v.length >= 8)
}
