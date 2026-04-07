import { describe, it, expect, vi } from 'vitest'
import { StreamableResult, type ProviderEvent, type ProviderResult, GenerateRouter, type AIProvider } from './ai-provider-manager.js'
import { createChannel } from './async-channel.js'

// ==================== Helpers ====================

function makeEvents(...texts: string[]): ProviderEvent[] {
  const events: ProviderEvent[] = texts.map(t => ({ type: 'text' as const, text: t }))
  events.push({ type: 'done', result: { text: texts.join(''), media: [] } })
  return events
}

async function* asyncOf<T>(...items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

// ==================== StreamableResult ====================

describe('StreamableResult', () => {
  it('should resolve as PromiseLike with the result', async () => {
    const events = makeEvents('hello')
    const sr = new StreamableResult(asyncOf(...events))
    const result = await sr
    expect(result.text).toBe('hello')
    expect(result.media).toEqual([])
  })

  it('should iterate all events including done', async () => {
    const events = makeEvents('a', 'b')
    const sr = new StreamableResult(asyncOf(...events))
    const collected = await collect(sr)
    expect(collected).toHaveLength(3) // text 'a', text 'b', done
    expect(collected[0]).toEqual({ type: 'text', text: 'a' })
    expect(collected[1]).toEqual({ type: 'text', text: 'b' })
    expect(collected[2].type).toBe('done')
  })

  it('should support multiple independent iterators', async () => {
    const ch = createChannel<ProviderEvent>()

    const sr = new StreamableResult(ch)

    ch.push({ type: 'text', text: 'x' })
    ch.push({ type: 'done', result: { text: 'x', media: [] } })
    ch.close()

    const iter1 = collect(sr)
    const iter2 = collect(sr)

    const [r1, r2] = await Promise.all([iter1, iter2])
    expect(r1).toEqual(r2)
    expect(r1).toHaveLength(2)
  })

  it('should buffer events for late consumers', async () => {
    const events = makeEvents('hello')
    const sr = new StreamableResult(asyncOf(...events))

    // Wait for drain to complete
    await sr

    // Now iterate — should still get all events from buffer
    const collected = await collect(sr)
    expect(collected).toHaveLength(2)
    expect(collected[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('should reject when source throws', async () => {
    async function* failing(): AsyncIterable<ProviderEvent> {
      yield { type: 'text', text: 'ok' }
      throw new Error('source error')
    }

    const sr = new StreamableResult(failing())
    await expect(sr.then(r => r)).rejects.toThrow('source error')
  })

  it('should end iteration gracefully when source errors (error surfaces via await)', async () => {
    async function* failing(): AsyncIterable<ProviderEvent> {
      yield { type: 'text', text: 'ok' }
      throw new Error('iter error')
    }

    const sr = new StreamableResult(failing())

    // The promise rejects with the source error
    await expect(sr.then(r => r)).rejects.toThrow('iter error')

    // But the iterator ends gracefully — _done is set in finally before _error is checked
    const iter = sr[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.value).toEqual({ type: 'text', text: 'ok' })
    const second = await iter.next()
    expect(second.done).toBe(true)
  })

  it('should throw if stream ends without done event', async () => {
    const sr = new StreamableResult(asyncOf({ type: 'text' as const, text: 'hi' }))
    await expect(sr.then(r => r)).rejects.toThrow('stream ended without done event')
  })

  it('should support then chaining', async () => {
    const events = makeEvents('chain')
    const sr = new StreamableResult(asyncOf(...events))
    const upper = await sr.then(r => r.text.toUpperCase())
    expect(upper).toBe('CHAIN')
  })

  it('should include tool events in iteration', async () => {
    const events: ProviderEvent[] = [
      { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/tmp' } },
      { type: 'tool_result', tool_use_id: 't1', content: 'file contents' },
      { type: 'text', text: 'done' },
      { type: 'done', result: { text: 'done', media: [] } },
    ]
    const sr = new StreamableResult(asyncOf(...events))
    const collected = await collect(sr)
    expect(collected).toHaveLength(4)
    expect(collected[0].type).toBe('tool_use')
    expect(collected[1].type).toBe('tool_result')
  })
})

// ==================== GenerateRouter ====================

vi.mock('./config.js', () => ({
  resolveProfile: vi.fn(),
}))

import { resolveProfile } from './config.js'
const mockResolveProfile = vi.mocked(resolveProfile)

describe('GenerateRouter', () => {
  function makeProvider(tag: AIProvider['providerTag']): AIProvider {
    return {
      providerTag: tag,
      ask: vi.fn(async () => ({ text: `from-${tag}`, media: [] })),
      async *generate() { yield { type: 'done' as const, result: { text: '', media: [] } } },
    }
  }

  it('should resolve profile and pick matching provider', async () => {
    const vercel = makeProvider('vercel-ai')
    const agentSdk = makeProvider('agent-sdk')
    const router = new GenerateRouter(vercel, agentSdk)

    mockResolveProfile.mockResolvedValue({ backend: 'agent-sdk', label: 'Claude', model: 'claude-sonnet-4-6' })
    const { provider } = await router.resolve('claude-main')
    expect(provider).toBe(agentSdk)
  })

  it('should resolve active profile when no slug given', async () => {
    const vercel = makeProvider('vercel-ai')
    const router = new GenerateRouter(vercel, null)

    mockResolveProfile.mockResolvedValue({ backend: 'vercel-ai-sdk', label: 'Vercel', model: 'claude-sonnet-4-6', provider: 'anthropic' })
    const { provider } = await router.resolve()
    expect(provider).toBe(vercel)
  })

  it('should throw when backend has no registered provider', async () => {
    const vercel = makeProvider('vercel-ai')
    const router = new GenerateRouter(vercel, null) // no agent-sdk

    mockResolveProfile.mockResolvedValue({ backend: 'agent-sdk', label: 'Claude', model: 'x' })
    await expect(router.resolve('test')).rejects.toThrow('No provider registered for backend')
  })

  it('should resolve codex provider', async () => {
    const vercel = makeProvider('vercel-ai')
    const codex = makeProvider('codex')
    const router = new GenerateRouter(vercel, null, codex)

    mockResolveProfile.mockResolvedValue({ backend: 'codex', label: 'GPT', model: 'gpt-5.4' })
    const { provider, profile } = await router.resolve('gpt-main')
    expect(provider).toBe(codex)
    expect(profile.model).toBe('gpt-5.4')
  })

  it('should delegate ask to active profile provider', async () => {
    const vercel = makeProvider('vercel-ai')
    const router = new GenerateRouter(vercel, null)

    mockResolveProfile.mockResolvedValue({ backend: 'vercel-ai-sdk', label: 'V', model: 'x', provider: 'anthropic' })
    const result = await router.ask('test prompt')
    expect(result.text).toBe('from-vercel-ai')
    expect(vercel.ask).toHaveBeenCalledWith('test prompt')
  })
})
