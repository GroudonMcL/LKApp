import type { AiDraftOutput } from '@/core/ai-output'
import { AiError, type AiProvider, type TransformRequest, type TransformResponse } from '@/server/ai/provider'
import { buildUserPrompt, PROMPT_VERSION } from '@/server/ai/prompts/transform'

/** A scripted AI provider. Records the prompts it receives; never calls a real API. */
export class MockAiProvider implements AiProvider {
  readonly id = 'mock'
  readonly model = 'mock-model'
  requests: TransformRequest[] = []
  prompts: string[] = []
  next: AiDraftOutput | AiError | (() => unknown) | null = null

  async transform(request: TransformRequest): Promise<TransformResponse> {
    this.requests.push(request)
    this.prompts.push(buildUserPrompt(request))
    const next = this.next
    if (next instanceof AiError) throw next
    if (next === null) throw new AiError('unknown', 'No scripted response')
    const output = typeof next === 'function' ? (next() as AiDraftOutput) : next
    return { output, model: this.model, servedByModel: this.model, promptVersion: PROMPT_VERSION, inputTokens: 1000, outputTokens: 500 }
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
