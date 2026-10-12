import 'server-only'
import { z } from 'zod'
import { AiDraftOutput } from '@/core/ai-output'
import { AiError, type AiProvider, type TagSuggestResponse, type TranscribeRequest, type TranscribeResponse, type TransformRequest, type TransformResponse } from './provider'
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompts/transform'
import { TAGS_PROMPT_VERSION, TAGS_SYSTEM_PROMPT, TagSuggestionOutput, tagsUserPrompt, type TagPromptInput } from './prompts/tags'
import { TRANSCRIBE_PROMPT_VERSION, TRANSCRIBE_SYSTEM_PROMPT, TranscriptionOutput, transcribeUserPrompt } from './prompts/transcribe'

/**
 * OpenRouter implementation of the AI provider, restricted to FREE models.
 *
 * Three independent locks keep it free:
 * 1. Only free model ids are accepted (`openrouter/free`, OpenRouter's free-models router, or
 *    an id ending in `:free`), and the live model list must show the model at a price of 0.
 * 2. Every request carries `provider.max_price` of 0, so OpenRouter itself refuses to route it
 *    to anything that costs money (verified live: a paid model is refused with 404).
 * 3. Every reply is checked: the model that answered must be a free model and the cost
 *    OpenRouter reports must be 0. Otherwise the reply is discarded and an error is raised.
 * Your OpenRouter key can add a fourth: a credit limit of $0 on the key.
 *
 * Free models are rate-limited by OpenRouter (per minute and per day; 50 requests a day on
 * accounts that have not bought credits). Prompts sent to free models may be logged or used
 * for training by the model provider, depending on your OpenRouter privacy settings.
 *
 * The model gets no tools and returns JSON that is validated with Zod before use. Neither the
 * prompt nor the source is logged.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
export const FREE_ROUTER_MODEL = 'openrouter/free'

/** Free by name: OpenRouter's free router, or a model id with the `:free` suffix. */
export function isFreeModelId(id: string): boolean {
  return id === FREE_ROUTER_MODEL || /:free$/.test(id)
}

interface CatalogueModel {
  id: string
  pricing?: Record<string, string | number | undefined>
  architecture?: { input_modalities?: string[] }
}

/** The free check against OpenRouter's live model list (cached for an hour). */
export class FreeModelCatalogue {
  private cache: { at: number; models: Map<string, CatalogueModel> } | null = null
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly baseUrl = OPENROUTER_BASE_URL,
  ) {}

  async get(id: string): Promise<CatalogueModel | null> {
    if (!this.cache || Date.now() - this.cache.at > 60 * 60 * 1000) {
      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseUrl}/models`)
      } catch {
        throw new AiError('connection', 'Could not reach OpenRouter to check that the model is free. Check your internet connection.')
      }
      if (!response.ok) throw new AiError('overloaded', `OpenRouter's model list is unavailable (HTTP ${response.status}), so the free check cannot be made. Try again shortly.`)
      const body = (await response.json()) as { data?: CatalogueModel[] }
      this.cache = { at: Date.now(), models: new Map((body.data ?? []).map((model) => [model.id, model])) }
    }
    return this.cache.models.get(id) ?? null
  }

  /** Throws unless the model is free by name and listed at a price of 0. */
  async requireFree(id: string, needs: { image?: boolean } = {}): Promise<void> {
    if (!isFreeModelId(id)) {
      throw new AiError('permission', `“${id}” is not a free OpenRouter model. This app only uses free models: “${FREE_ROUTER_MODEL}” or a model whose id ends in “:free”.`)
    }
    const model = await this.get(id)
    if (!model) throw new AiError('bad_request', `OpenRouter does not list the model “${id}” (any more). Choose another free model, or use “${FREE_ROUTER_MODEL}”.`)
    const prices = Object.entries(model.pricing ?? {}).filter(([key]) => ['prompt', 'completion', 'request', 'image', 'web_search', 'internal_reasoning'].includes(key))
    const paid = prices.filter(([, value]) => Number(value ?? 0) !== 0)
    if (paid.length) throw new AiError('permission', `OpenRouter lists “${id}” with a price (${paid.map(([key]) => key).join(', ')}), so it is not used.`)
    if (needs.image && !(model.architecture?.input_modalities ?? []).includes('image')) {
      throw new AiError('bad_request', `The free model “${id}” cannot read images. Use “${FREE_ROUTER_MODEL}”, which picks a free model that can.`)
    }
  }
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

interface ChatResponse {
  id?: string
  model?: string
  error?: { message?: string; code?: number | string; metadata?: unknown }
  choices?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
}

export interface OpenRouterProviderOptions {
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  baseUrl?: string
  maxTokens?: number
  catalogue?: FreeModelCatalogue
}

export class OpenRouterProvider implements AiProvider {
  readonly id = 'openrouter'
  readonly model: string
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly maxTokens: number
  private readonly catalogue: FreeModelCatalogue

  constructor(options: OpenRouterProviderOptions) {
    this.apiKey = options.apiKey
    this.model = options.model
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl ?? OPENROUTER_BASE_URL
    this.maxTokens = options.maxTokens ?? 32_000
    this.catalogue = options.catalogue ?? new FreeModelCatalogue(this.fetchImpl, this.baseUrl)
  }

  async transform(request: TransformRequest): Promise<TransformResponse> {
    const result = await this.run(AiDraftOutput, 'page_draft', SYSTEM_PROMPT, buildUserPrompt(request), {
      refusal: 'The AI declined to process this source. Try the structural (no-AI) transformation, or edit the source.',
      truncated: 'The AI reply was cut off. Split the source into smaller sections and import them one at a time.',
    })
    return { output: result.data, model: this.model, servedByModel: result.servedBy, promptVersion: PROMPT_VERSION, inputTokens: result.inputTokens, outputTokens: result.outputTokens }
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResponse> {
    if (request.kind === 'pdf') {
      throw new AiError('bad_request', 'Free OpenRouter models cannot read scanned PDFs (OpenRouter’s PDF reading for scans is a paid service). Export the pages as images and add those instead, or use an Anthropic key for PDFs.')
    }
    const parts: ContentPart[] = [
      { type: 'image_url', image_url: { url: `data:${request.mediaType};base64,${request.base64}` } },
      { type: 'text', text: transcribeUserPrompt(request.kind, request.name) },
    ]
    const result = await this.run(TranscriptionOutput, 'transcription', TRANSCRIBE_SYSTEM_PROMPT, parts, { refusal: 'The AI declined to transcribe this file.', truncated: 'The transcription was cut off. Try a smaller image.' }, { image: true })
    return { output: result.data, model: this.model, servedByModel: result.servedBy, promptVersion: TRANSCRIBE_PROMPT_VERSION, inputTokens: result.inputTokens, outputTokens: result.outputTokens }
  }

  async suggestTags(request: TagPromptInput): Promise<TagSuggestResponse> {
    const result = await this.run(TagSuggestionOutput, 'tag_suggestions', TAGS_SYSTEM_PROMPT, tagsUserPrompt(request), { refusal: 'The AI declined to suggest tags for this page.', truncated: 'The AI reply was cut off. Try again.' })
    return { output: result.data, model: this.model, servedByModel: result.servedBy, promptVersion: TAGS_PROMPT_VERSION, inputTokens: result.inputTokens, outputTokens: result.outputTokens }
  }

  /**
   * One structured request. Free models are less reliable at following a schema, so a reply
   * that is not valid JSON of the right shape is retried once with the problem explained.
   */
  private async run<T extends z.ZodType>(
    schema: T,
    name: string,
    system: string,
    content: string | ContentPart[],
    messages: { refusal: string; truncated: string },
    needs: { image?: boolean } = {},
  ): Promise<{ data: z.infer<T>; servedBy: string; inputTokens: number | null; outputTokens: number | null }> {
    await this.catalogue.requireFree(this.model, needs)
    const jsonSchema = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
    delete jsonSchema.$schema
    const chat: { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }[] = [
      { role: 'system', content: `${system}\n\nReply with one JSON object that matches the given JSON schema, and nothing else.` },
      { role: 'user', content },
    ]
    let inputTokens = 0
    let outputTokens = 0
    for (let attempt = 1; ; attempt++) {
      const reply = await this.post({
        model: this.model,
        messages: chat,
        response_format: { type: 'json_schema', json_schema: { name, strict: false, schema: jsonSchema } },
        // Lock 2: OpenRouter refuses to route to anything that is not free.
        provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, require_parameters: true },
        max_tokens: this.maxTokens,
      })
      inputTokens += reply.usage?.prompt_tokens ?? 0
      outputTokens += reply.usage?.completion_tokens ?? 0
      const servedBy = reply.model ?? this.model
      // Lock 3: never use a reply that came from a paid model or cost anything.
      const cost = reply.usage?.cost
      if (!isFreeModelId(servedBy) && cost !== 0) {
        throw new AiError('permission', `OpenRouter answered with “${servedBy}”, which is not marked free, and did not confirm a cost of 0. The reply was discarded.`, { requestId: reply.id })
      }
      if (cost !== undefined && cost !== 0) {
        throw new AiError('permission', `OpenRouter reported a cost of ${reply.usage?.cost} for this request. The reply was discarded and no more requests will be made with this setting. Check your OpenRouter account.`, { requestId: reply.id })
      }
      const choice = reply.choices?.[0]
      if (!choice) throw new AiError('unknown', 'OpenRouter returned no answer. Try again.', { requestId: reply.id })
      if (choice.finish_reason === 'content_filter' || choice.message?.refusal) throw new AiError('refusal', messages.refusal, { requestId: reply.id })
      if (choice.finish_reason === 'length') throw new AiError('truncated', messages.truncated, { requestId: reply.id })
      const text = choice.message?.content ?? ''
      const problem = parseStructured(text, schema)
      if (problem.ok) return { data: problem.data, servedBy, inputTokens, outputTokens }
      if (attempt >= 2) throw new AiError('invalid_output', 'The free AI model did not return valid structured data (after one retry). Run it again, or use the structural (no-AI) transformation.', { requestId: reply.id, issues: problem.issues })
      chat.push({ role: 'assistant', content: text.slice(0, 20_000) }, { role: 'user', content: `That reply could not be used: ${problem.issues.slice(0, 5).join('; ')}. Reply again with only one JSON object that matches the schema.` })
    }
  }

  private async post(body: unknown): Promise<ChatResponse> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          // Optional attribution headers OpenRouter asks for; no personal data.
          'http-referer': 'http://127.0.0.1',
          'x-title': 'LK Companion',
        },
        body: JSON.stringify(body),
      })
    } catch {
      throw new AiError('connection', 'Could not reach OpenRouter. Check your internet connection.')
    }
    let parsed: ChatResponse = {}
    try {
      parsed = (await response.json()) as ChatResponse
    } catch {
      parsed = {}
    }
    if (!response.ok || parsed.error) throw toAiError(response.status, parsed)
    return parsed
  }
}

function parseStructured<T extends z.ZodType>(text: string, schema: T): { ok: true; data: z.infer<T> } | { ok: false; issues: string[] } {
  // Some models wrap JSON in ``` fences or add a sentence around it.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let raw: unknown
  try {
    raw = JSON.parse(candidate)
  } catch {
    return { ok: false, issues: ['the reply was not valid JSON'] }
  }
  const result = schema.safeParse(raw)
  if (!result.success) return { ok: false, issues: result.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.') || '(top)'}: ${issue.message}`) }
  return { ok: true, data: result.data }
}

function toAiError(status: number, body: ChatResponse): AiError {
  const message = body.error?.message ?? ''
  const code = Number(body.error?.code ?? status)
  if (code === 401) return new AiError('authentication', 'OpenRouter rejected the API key. Check OPENROUTER_API_KEY.', { status: 401 })
  if (code === 402) return new AiError('permission', 'OpenRouter refused the request for lack of credit. Free models need a non-negative balance; check your OpenRouter account.', { status: 402 })
  if (code === 403) return new AiError('refusal', `OpenRouter's moderation declined the request: ${message}`, { status: 403 })
  if (code === 429) return new AiError('rate_limited', 'The free-model limit was reached (OpenRouter allows a set number of free requests per minute and per day; 50 a day without purchased credits). Wait and try again later, or use the structural (no-AI) option.', { status: 429 })
  if (code === 404 && /max price/i.test(message)) return new AiError('permission', 'No free provider is available for this model right now (paid ones are never used). Try again later or choose another free model.', { status: 404 })
  if (code === 404 && /data policy|privacy/i.test(message)) return new AiError('permission', 'OpenRouter has no free endpoint that matches your privacy settings. In OpenRouter → Settings → Privacy, allow free endpoints (they may log prompts), or use an Anthropic key.', { status: 404 })
  if (code === 404) return new AiError('bad_request', `OpenRouter: ${message || 'no endpoint available for this request'}.`, { status: 404 })
  if (code === 400) return new AiError('bad_request', `OpenRouter rejected the request: ${message}`, { status: 400 })
  if (code >= 500) return new AiError('overloaded', 'OpenRouter or the free model is temporarily unavailable. Try again shortly.', { status: code })
  return new AiError('unknown', `OpenRouter returned an error (HTTP ${status}): ${message}`, { status })
}
