import type { AiDraftOutput } from '@/core/ai-output'
import type { PageTypeDefinition } from '@/core/page-types'
import type { RecipeDefinition } from '@/core/recipe'
import type { TemplateDefinition } from '@/core/template'
import type { TranscriptionOutput } from './prompts/transcribe'

/**
 * The AI provider abstraction. The rest of the app asks for a transformation and gets back
 * validated, structured data; it never sees provider-specific details. Claude is the first
 * implementation; tests use a mock.
 *
 * The provider only returns data. It has no tools and cannot call LegendKeeper.
 */

export interface TransformRequest {
  sourceText: string
  sourceFormat: 'text' | 'markdown' | 'json'
  sourceName: string
  pageType: PageTypeDefinition
  template: TemplateDefinition
  recipe: RecipeDefinition
  /** Existing project tag names (no counts, no page content), so suggestions can reuse them. */
  existingTags: string[]
}

export interface TransformResponse {
  output: AiDraftOutput
  model: string
  /** The model that actually served the request (may differ after a server-side fallback). */
  servedByModel: string
  promptVersion: string
  inputTokens: number | null
  outputTokens: number | null
}

export type AiErrorKind = 'not_configured' | 'disabled' | 'authentication' | 'permission' | 'rate_limited' | 'overloaded' | 'connection' | 'refusal' | 'truncated' | 'invalid_output' | 'bad_request' | 'unknown'

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly details: { requestId?: string | null; status?: number; issues?: string[] } = {},
  ) {
    super(message)
    this.name = 'AiError'
  }
  toJSON() {
    return { kind: this.kind, message: this.message, ...this.details }
  }
}

export interface TranscribeRequest {
  kind: 'image' | 'pdf'
  /** e.g. image/png, image/jpeg, application/pdf */
  mediaType: string
  /** File contents, base64-encoded. */
  base64: string
  name: string
}

export interface TranscribeResponse {
  output: TranscriptionOutput
  model: string
  servedByModel: string
  promptVersion: string
  inputTokens: number | null
  outputTokens: number | null
}

export interface AiProvider {
  readonly id: string
  readonly model: string
  transform(request: TransformRequest, signal?: AbortSignal): Promise<TransformResponse>
  /** Verbatim transcription of an image or scanned PDF. Only called when the user asks for it. */
  transcribe(request: TranscribeRequest, signal?: AbortSignal): Promise<TranscribeResponse>
}
