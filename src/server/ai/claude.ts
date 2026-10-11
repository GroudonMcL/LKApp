import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { AiDraftOutput } from '@/core/ai-output'
import { AiError, type AiProvider, type TransformRequest, type TransformResponse } from './provider'
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompts/transform'
import type { AiEffort } from '../config'

/**
 * Models that accept LegendKeeper-independent server-side refusal fallbacks
 * (`fallbacks: "default"`). If a safety classifier declines a request, the API re-runs it
 * on a fallback model in the same call, and `servedByModel` records which model answered.
 */
const FALLBACK_CAPABLE = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'])

export interface ClaudeProviderOptions {
  apiKey: string
  model: string
  effort: AiEffort
  maxTokens?: number
}

/**
 * Claude implementation of the AI provider.
 *
 * - Structured outputs (`output_config.format`) constrain the reply to the AiDraftOutput
 *   JSON schema; the reply is then validated again with Zod in application code.
 * - Streaming is used because long sources can produce long replies.
 * - The model gets no tools. It returns data, nothing more.
 * - Neither the prompt nor the source is logged. Only token counts and ids are recorded.
 */
export class ClaudeProvider implements AiProvider {
  readonly id = 'anthropic'
  readonly model: string
  private readonly client: Anthropic
  private readonly effort: AiEffort
  private readonly maxTokens: number

  constructor(options: ClaudeProviderOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, maxRetries: 2 })
    this.model = options.model
    this.effort = options.effort
    this.maxTokens = options.maxTokens ?? 64_000
  }

  async transform(request: TransformRequest, signal?: AbortSignal): Promise<TransformResponse> {
    const useFallbacks = FALLBACK_CAPABLE.has(this.model)
    let message
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          system: SYSTEM_PROMPT,
          output_config: { effort: this.effort, format: betaZodOutputFormat(AiDraftOutput) },
          messages: [{ role: 'user', content: buildUserPrompt(request) }],
        },
        { signal },
      )
      message = await stream.finalMessage()
    } catch (error) {
      throw toAiError(error)
    }

    if (message.stop_reason === 'refusal') {
      throw new AiError('refusal', 'The AI declined to process this source. Try the structural (no-AI) transformation, or edit the source.', { requestId: message.id })
    }
    if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
      throw new AiError('truncated', 'The AI reply was cut off because the source is too long for one pass. Split the source into smaller sections and import them one at a time.', {
        requestId: message.id,
      })
    }

    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new AiError('invalid_output', 'The AI reply was not valid JSON. Run the transformation again.', { requestId: message.id })
    }
    const parsed = AiDraftOutput.safeParse(raw)
    if (!parsed.success) {
      throw new AiError('invalid_output', 'The AI reply did not match the expected structure. Run the transformation again.', {
        requestId: message.id,
        issues: parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      })
    }

    return {
      output: parsed.data,
      model: this.model,
      servedByModel: message.model,
      promptVersion: PROMPT_VERSION,
      inputTokens: message.usage?.input_tokens ?? null,
      outputTokens: message.usage?.output_tokens ?? null,
    }
  }
}

function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error
  const requestId = (error as { requestID?: string | null }).requestID ?? null
  if (error instanceof Anthropic.AuthenticationError) {
    return new AiError('authentication', 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY.', { requestId, status: 401 })
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new AiError('permission', 'The Anthropic API key is not allowed to use this model or feature.', { requestId, status: 403 })
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError('rate_limited', 'Anthropic rate limit reached. Wait a minute and try again.', { requestId, status: 429 })
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new AiError('bad_request', `Anthropic rejected the request: ${error.message}`, { requestId, status: 400 })
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new AiError('overloaded', 'Anthropic is temporarily unavailable or overloaded. Try again shortly.', { requestId, status: error.status })
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiError('connection', 'Could not reach the Anthropic API. Check your internet connection.', {})
  }
  if (error instanceof Anthropic.APIError) {
    return new AiError('unknown', `Anthropic returned an error (HTTP ${error.status ?? '?'}).`, { requestId, status: error.status ?? undefined })
  }
  return new AiError('unknown', `Unexpected AI error: ${(error as Error)?.message ?? String(error)}`)
}
