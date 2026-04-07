/**
 * AI Provider abstraction — StreamableResult + GenerateRouter.
 *
 * Provider interface types (AIProvider, ProviderEvent, etc.) live in
 * ai-providers/types.ts alongside the implementations. This file holds the
 * core infrastructure that orchestrates providers.
 */

import { resolveProfile } from './config.js'
import type { ResolvedProfile } from './config.js'
import type { ProviderEvent, ProviderResult, AIProvider } from '../ai-providers/types.js'

export type {
  ProviderEvent, ProviderResult, AIProvider,
  GenerateOpts,
} from '../ai-providers/types.js'

// ==================== StreamableResult ====================

/**
 * A result that is both PromiseLike (for backward-compatible `await`)
 * and AsyncIterable (for real-time event streaming).
 *
 * Internally drains the source AsyncIterable in the background, buffering
 * events. Multiple consumers can iterate independently (each gets its own cursor).
 */
export class StreamableResult implements PromiseLike<ProviderResult>, AsyncIterable<ProviderEvent> {
  private _events: ProviderEvent[] = []
  private _done = false
  private _result: ProviderResult | null = null
  private _error: Error | null = null
  private _waiters: Array<() => void> = []
  private _promise: Promise<ProviderResult>

  constructor(source: AsyncIterable<ProviderEvent>) {
    this._promise = this._drain(source)
  }

  private async _drain(source: AsyncIterable<ProviderEvent>): Promise<ProviderResult> {
    try {
      for await (const event of source) {
        this._events.push(event)
        if (event.type === 'done') this._result = event.result
        this._notify()
      }
    } catch (err) {
      this._error = err instanceof Error ? err : new Error(String(err))
      this._notify()
      throw this._error
    } finally {
      this._done = true
      this._notify()
    }
    if (!this._result) throw new Error('StreamableResult: stream ended without done event')
    return this._result
  }

  private _notify(): void {
    for (const w of this._waiters.splice(0)) w()
  }

  then<T1 = ProviderResult, T2 = never>(
    onfulfilled?: ((value: ProviderResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this._promise.then(onfulfilled, onrejected)
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<ProviderEvent> {
    let cursor = 0
    while (true) {
      while (cursor < this._events.length) {
        yield this._events[cursor++]
      }
      if (this._done) return
      if (this._error) throw this._error
      await new Promise<void>((resolve) => this._waiters.push(resolve))
    }
  }
}

// ==================== Types ====================

export interface AskOptions {
  /** Preamble text describing the conversation context. */
  historyPreamble?: string
  /** System prompt override for this call. */
  systemPrompt?: string
  /** Max text history entries to include in context (text providers only). */
  maxHistoryEntries?: number
  /** Tool names to disable for this call. */
  disabledTools?: string[]
  /** Profile slug override. Falls back to global activeProfile if omitted. */
  profileSlug?: string
}

// ==================== GenerateRouter ====================

/** Resolves profile → AIProvider instance + resolved config. */
export class GenerateRouter {
  private providers: Record<string, AIProvider>

  constructor(
    vercel: AIProvider,
    agentSdk: AIProvider | null = null,
    codex: AIProvider | null = null,
  ) {
    this.providers = { 'vercel-ai-sdk': vercel }
    if (agentSdk) this.providers['agent-sdk'] = agentSdk
    if (codex) this.providers['codex'] = codex
  }

  /** Resolve profile and pick the matching provider. */
  async resolve(profileSlug?: string): Promise<{ provider: AIProvider; profile: ResolvedProfile }> {
    const profile = await resolveProfile(profileSlug)
    const provider = this.providers[profile.backend]
    if (!provider) throw new Error(`No provider registered for backend: ${profile.backend}`)
    return { provider, profile }
  }

  /** Stateless ask — delegates to the active profile's provider. */
  async ask(prompt: string): Promise<ProviderResult> {
    const { provider } = await this.resolve()
    return provider.ask(prompt)
  }
}
