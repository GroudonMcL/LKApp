import type { AiDraftOutput } from '@/core/ai-output'
import { AiError, type AiProvider, type AnalysisResponse, type TagSuggestResponse, type TranscribeRequest, type TranscribeResponse, type TransformRequest, type TransformResponse } from '@/server/ai/provider'
import { TRANSCRIBE_PROMPT_VERSION, type TranscriptionOutput } from '@/server/ai/prompts/transcribe'
import { TAGS_PROMPT_VERSION, type TagPromptInput, type TagSuggestionOutput } from '@/server/ai/prompts/tags'
import { buildUserPrompt, PROMPT_VERSION } from '@/server/ai/prompts/transform'
import { ANALYSIS_TASKS, type AnalysisTaskId } from '@/server/ai/prompts/analysis'

/** A scripted AI provider. Records the prompts it receives; never calls a real API. */
export class MockAiProvider implements AiProvider {
  readonly id = 'mock'
  readonly model = 'mock-model'
  requests: TransformRequest[] = []
  prompts: string[] = []
  next: AiDraftOutput | AiError | (() => unknown) | null = null
  transcriptions: TranscribeRequest[] = []
  tagRequests: TagPromptInput[] = []
  nextTags: TagSuggestionOutput | ((input: TagPromptInput) => TagSuggestionOutput) | AiError | null = null
  nextTranscription: TranscriptionOutput | AiError | null = null

  async transform(request: TransformRequest): Promise<TransformResponse> {
    this.requests.push(request)
    this.prompts.push(buildUserPrompt(request))
    const next = this.next
    if (next instanceof AiError) throw next
    if (next === null) throw new AiError('unknown', 'No scripted response')
    const output = typeof next === 'function' ? (next() as AiDraftOutput) : next
    return { output, model: this.model, servedByModel: this.model, promptVersion: PROMPT_VERSION, inputTokens: 1000, outputTokens: 500 }
  }

  async transcribe(request: TranscribeRequest): Promise<TranscribeResponse> {
    this.transcriptions.push(request)
    const next = this.nextTranscription
    if (next instanceof AiError) throw next
    if (next === null) throw new AiError('unknown', 'No scripted transcription')
    return { output: next, model: this.model, servedByModel: this.model, promptVersion: TRANSCRIBE_PROMPT_VERSION, inputTokens: 2000, outputTokens: 800 }
  }

  analysisRequests: { task: AnalysisTaskId; user: string }[] = []
  /** Scripted analysis replies by task: a value, a function of the prompt, or an error. */
  nextAnalysis: Partial<Record<AnalysisTaskId, unknown | ((user: string) => unknown) | AiError>> = {}

  async analyse<K extends AnalysisTaskId>(task: K, user: string): Promise<AnalysisResponse<K>> {
    this.analysisRequests.push({ task, user })
    const next = this.nextAnalysis[task]
    if (next instanceof AiError) throw next
    if (next === undefined) throw new AiError('unknown', `No scripted ${task} response`)
    const raw = typeof next === 'function' ? (next as (u: string) => unknown)(user) : next
    // Validated like a real reply.
    const output = ANALYSIS_TASKS[task].schema.parse(raw) as AnalysisResponse<K>['output']
    return { output, model: this.model, servedByModel: this.model, promptVersion: ANALYSIS_TASKS[task].version, inputTokens: 800, outputTokens: 300 }
  }

  async suggestTags(request: TagPromptInput): Promise<TagSuggestResponse> {
    this.tagRequests.push(request)
    const next = this.nextTags
    if (next instanceof AiError) throw next
    if (next === null) throw new AiError('unknown', 'No scripted tag suggestions')
    const output = typeof next === 'function' ? next(request) : next
    return { output, model: this.model, servedByModel: this.model, promptVersion: TAGS_PROMPT_VERSION, inputTokens: 300, outputTokens: 60 }
  }
}

export function aiOutput(partial: Partial<AiDraftOutput>): AiDraftOutput {
  return {
    pageName: 'Untitled',
    aliases: [],
    detectedPageType: 'npc',
    pageTypeConfidence: 'high',
    fields: [],
    sections: [],
    unmappedContent: [],
    entityMentions: [],
    tagSuggestions: [],
    reviewerNotes: [],
    suspectedInstructions: [],
    ...partial,
  }
}
