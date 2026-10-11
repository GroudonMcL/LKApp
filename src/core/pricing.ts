/**
 * List prices (USD per million tokens) used only to *estimate* AI cost in reports.
 * Source: Anthropic's published API prices as of October 2026. They exclude prompt-cache
 * discounts and may change; the real charge is on your Anthropic bill. Unknown models get no
 * estimate rather than a guess.
 */
export const PRICES_AS_OF = 'October 2026'
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
}

export function estimateCostUsd(model: string | null, inputTokens: number, outputTokens: number): number | null {
  const price = model ? PRICES[model] : undefined
  if (!price) return null
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}
