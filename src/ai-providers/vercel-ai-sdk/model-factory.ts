/**
 * Model factory — creates Vercel AI SDK LanguageModel instances from a resolved profile.
 *
 * Uses dynamic imports so unused provider packages don't prevent startup.
 */

import type { LanguageModel } from 'ai'
import type { ResolvedProfile } from '../../core/config.js'

/** Result includes the model plus a cache key for change detection. */
export interface ModelFromConfig {
  model: LanguageModel
  /** `provider:modelId:baseUrl` — use this to detect config changes. */
  key: string
}

export async function createModelFromProfile(profile: ResolvedProfile): Promise<ModelFromConfig> {
  const p = profile.provider ?? 'anthropic'
  const m = profile.model
  const url = profile.baseUrl
  const apiKey = profile.apiKey
  const key = `${p}:${m}:${url ?? ''}`

  switch (p) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const client = createAnthropic({ apiKey: apiKey || undefined, baseURL: url || undefined })
      return { model: client(m), key }
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const client = createOpenAI({ apiKey: apiKey || undefined, baseURL: url || undefined })
      return { model: client(m), key }
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const client = createGoogleGenerativeAI({ apiKey: apiKey || undefined, baseURL: url || undefined })
      return { model: client(m), key }
    }
    default:
      throw new Error(`Unsupported model provider: "${p}". Supported: anthropic, openai, google`)
  }
}
