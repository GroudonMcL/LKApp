import { afterEach, describe, expect, it } from 'vitest'
import { FreeModelCatalogue, OpenRouterProvider, isFreeModelId } from '@/server/ai/openrouter'
import { configuredSecrets, getConfig } from '@/server/config'
import { runtimeState, setRuntimeAiProvider } from '@/server/runtime'

/**
 * A fake OpenRouter: answers GET /models with a small catalogue and POST /chat/completions
 * with queued replies, recording every request. Nothing reaches the network.
 */
function fakeOpenRouter(replies: { status?: number; body: unknown }[]) {
  const requests: { url: string; body: Record<string, unknown> | null }[] = []
  const catalogue = {
    data: [
      { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] } },
      { id: 'vendor/text-only:free', pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'] } },
      { id: 'vendor/sneaky:free', pricing: { prompt: '0.000001', completion: '0' } },
      { id: 'openai/gpt-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
    ],
  }
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    requests.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (u.endsWith('/models')) return new Response(JSON.stringify(catalogue), { status: 200 })
    const next = replies.shift()
    if (!next) throw new Error('no more fake replies')
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
  }) as typeof fetch
  return { fetchImpl, requests, chats: () => requests.filter((r) => r.url.endsWith('/chat/completions')) }
}

const tagReply = (content: string, extra: Record<string, unknown> = {}) => ({
  body: { id: 'gen-1', model: 'nvidia/nemotron-3-super-120b-a12b:free', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0 }, ...extra },
})
const goodTags = JSON.stringify({ suggestions: [{ tag: 'Location', reason: 'It is a town.', certainty: 'likely' }], questionable: [], notes: [] })
const tagInput = { name: 'Saltreach', path: null, currentTags: [], pageType: 'Location', policy: 'existing_only' as const, allowedTags: [{ tag: 'Location' }], maxSuggestions: 3, text: 'A fishing town.' }

const provider = (fake: ReturnType<typeof fakeOpenRouter>, model = 'openrouter/free') =>
  new OpenRouterProvider({ apiKey: 'sk-or-test-key', model, fetchImpl: fake.fetchImpl, catalogue: new FreeModelCatalogue(fake.fetchImpl) })

describe('OpenRouter: free models only', () => {
  it('knows free model ids', () => {
    expect(isFreeModelId('openrouter/free')).toBe(true)
    expect(isFreeModelId('google/gemma-4-31b-it:free')).toBe(true)
    expect(isFreeModelId('openai/gpt-4o')).toBe(false)
    expect(isFreeModelId('openrouter/auto')).toBe(false)
  })

  it('refuses a paid model before sending anything', async () => {
    const fake = fakeOpenRouter([])
    await expect(provider(fake, 'openai/gpt-4o').suggestTags(tagInput)).rejects.toMatchObject({ kind: 'permission', message: expect.stringMatching(/not a free OpenRouter model/) })
    expect(fake.chats()).toHaveLength(0)
  })

  it('refuses a ":free" model that the live list shows with a price', async () => {
    const fake = fakeOpenRouter([])
    await expect(provider(fake, 'vendor/sneaky:free').suggestTags(tagInput)).rejects.toMatchObject({ kind: 'permission', message: expect.stringMatching(/with a price/) })
    expect(fake.chats()).toHaveLength(0)
  })

  it('asks OpenRouter for a maximum price of 0 and a JSON schema, and validates the reply', async () => {
    const fake = fakeOpenRouter([tagReply('```json\n' + goodTags + '\n```')])
    const result = await provider(fake).suggestTags(tagInput)
    expect(result.output.suggestions[0]!.tag).toBe('Location')
    expect(result.servedByModel).toBe('nvidia/nemotron-3-super-120b-a12b:free')
    const body = fake.chats()[0]!.body!
    expect(body.provider).toMatchObject({ max_price: { prompt: 0, completion: 0, request: 0, image: 0 } })
    expect((body.response_format as { type: string }).type).toBe('json_schema')
    expect(body.model).toBe('openrouter/free')
  })

  it('discards a reply that cost money, or that came from a model not confirmed free', async () => {
    let fake = fakeOpenRouter([tagReply(goodTags, { usage: { cost: 0.0004 } })])
    await expect(provider(fake).suggestTags(tagInput)).rejects.toMatchObject({ kind: 'permission', message: expect.stringMatching(/reported a cost/) })
    fake = fakeOpenRouter([tagReply(goodTags, { model: 'openai/gpt-4o', usage: {} })])
    await expect(provider(fake).suggestTags(tagInput)).rejects.toMatchObject({ kind: 'permission', message: expect.stringMatching(/not marked free/) })
  })

  it('retries once when the reply is not valid structured data, then gives up', async () => {
    let fake = fakeOpenRouter([tagReply('Sure! Here are some tags: Location'), tagReply(goodTags)])
    expect((await provider(fake).suggestTags(tagInput)).output.suggestions).toHaveLength(1)
    expect(fake.chats()).toHaveLength(2)
    fake = fakeOpenRouter([tagReply('{"suggestions": "oops"}'), tagReply('not json')])
    await expect(provider(fake).suggestTags(tagInput)).rejects.toMatchObject({ kind: 'invalid_output' })
    expect(fake.chats()).toHaveLength(2)
  })

  it('explains the free daily limit, and a refusal to use a paid route', async () => {
    let fake = fakeOpenRouter([{ status: 429, body: { error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } } }])
    await expect(provider(fake).suggestTags(tagInput)).rejects.toMatchObject({ kind: 'rate_limited', message: expect.stringMatching(/free-model limit/) })
    fake = fakeOpenRouter([{ status: 404, body: { error: { code: 404, message: 'No endpoints found that satisfy the max price for this request' } } }])
    await expect(provider(fake).suggestTags(tagInput)).rejects.toMatchObject({ message: expect.stringMatching(/paid ones are never used/) })
  })

  it('transcribes images only with a model that reads images; never PDFs', async () => {
    const fake = fakeOpenRouter([])
    await expect(provider(fake).transcribe({ kind: 'pdf', mediaType: 'application/pdf', base64: 'AAAA', name: 'scan.pdf' })).rejects.toMatchObject({ kind: 'bad_request', message: expect.stringMatching(/scanned PDFs/) })
    await expect(provider(fake, 'vendor/text-only:free').transcribe({ kind: 'image', mediaType: 'image/png', base64: 'AAAA', name: 'map.png' })).rejects.toMatchObject({ message: expect.stringMatching(/cannot read images/) })
    expect(fake.chats()).toHaveLength(0)
  })
})

describe('choosing the AI provider', () => {
  afterEach(() => {
    setRuntimeAiProvider(null)
  })
  const env = (extra: Record<string, string>) => ({ NODE_ENV: 'test', ...extra }) as unknown as NodeJS.ProcessEnv

  it('uses OpenRouter by default when its key is set, Anthropic when only that key is set, and an explicit choice otherwise', () => {
    expect(getConfig(env({ OPENROUTER_API_KEY: 'sk-or-aaaaaaaa', ANTHROPIC_API_KEY: 'sk-ant-bbbbbbbb' })).ai).toMatchObject({ provider: 'openrouter', providerSource: 'default', model: 'openrouter/free', apiKey: 'sk-or-aaaaaaaa' })
    expect(getConfig(env({ ANTHROPIC_API_KEY: 'sk-ant-bbbbbbbb' })).ai).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' })
    expect(getConfig(env({ OPENROUTER_API_KEY: 'sk-or-aaaaaaaa', ANTHROPIC_API_KEY: 'sk-ant-bbbbbbbb', LKC_AI_PROVIDER: 'anthropic' })).ai).toMatchObject({ provider: 'anthropic', providerSource: 'env' })
    setRuntimeAiProvider('anthropic')
    expect(getConfig(env({ OPENROUTER_API_KEY: 'sk-or-aaaaaaaa' })).ai).toMatchObject({ provider: 'anthropic', providerSource: 'settings', apiKey: null })
    expect(runtimeState().aiProvider).toBe('anthropic')
  })

  it('scrubs both AI keys from logs and exports', () => {
    const previous = { ...process.env }
    process.env.OPENROUTER_API_KEY = 'sk-or-secret-value-123'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-value-456'
    try {
      expect(configuredSecrets()).toEqual(expect.arrayContaining(['sk-or-secret-value-123', 'sk-ant-secret-value-456']))
    } finally {
      process.env = previous
    }
  })
})
