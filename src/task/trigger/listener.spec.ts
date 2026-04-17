import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog } from '../../core/event-log.js'
import { createListenerRegistry, type ListenerRegistry } from '../../core/listener-registry.js'
import { createTriggerListener, type TriggerListener } from './listener.js'
import { SessionStore } from '../../core/session.js'
import type { TriggerPayload } from '../../core/agent-event.js'
import { ConnectorCenter } from '../../core/connector-center.js'

function tempPath(ext: string): string {
  return join(tmpdir(), `trigger-listener-test-${randomUUID()}.${ext}`)
}

// ==================== Mock Engine ====================

function createMockEngine(response = 'AI reply') {
  const calls: Array<{ prompt: string; session: SessionStore }> = []
  let shouldFail = false

  return {
    calls,
    setResponse(text: string) { response = text },
    setShouldFail(val: boolean) { shouldFail = val },
    askWithSession: vi.fn(async (prompt: string, session: SessionStore) => {
      calls.push({ prompt, session })
      if (shouldFail) throw new Error('engine error')
      return { text: response, media: [] }
    }),
    ask: vi.fn(),
  }
}

describe('trigger listener', () => {
  let eventLog: EventLog
  let registry: ListenerRegistry
  let triggerListener: TriggerListener
  let mockEngine: ReturnType<typeof createMockEngine>
  let session: SessionStore
  let connectorCenter: ConnectorCenter

  beforeEach(async () => {
    const logPath = tempPath('jsonl')
    eventLog = await createEventLog({ logPath })
    registry = createListenerRegistry(eventLog)
    mockEngine = createMockEngine()
    session = new SessionStore(`test/trigger-${randomUUID()}`)
    connectorCenter = new ConnectorCenter()

    triggerListener = createTriggerListener({
      connectorCenter,
      agentCenter: mockEngine as any,
      registry,
      session,
    })
    await triggerListener.start()
    await registry.start()
  })

  afterEach(async () => {
    await registry.stop()
    await eventLog._resetForTest()
  })

  // ==================== Basic handling ====================

  describe('event handling', () => {
    it('should call agentCenter.askWithSession on trigger', async () => {
      await eventLog.append('trigger', {
        source: 'tradingview',
        name: 'btc-breakout',
        data: { symbol: 'BTC', price: 105000 },
      } satisfies TriggerPayload)

      await vi.waitFor(() => {
        expect(mockEngine.askWithSession).toHaveBeenCalledTimes(1)
      })

      const [prompt] = mockEngine.askWithSession.mock.calls[0]
      expect(prompt).toContain('Source: tradingview')
      expect(prompt).toContain('Name:   btc-breakout')
      expect(prompt).toContain('"symbol": "BTC"')
      expect(prompt).toContain('"price": 105000')
    })

    it('should write trigger.done on success with causedBy', async () => {
      const triggerEntry = await eventLog.append('trigger', {
        source: 'webhook', name: 'test', data: {},
      } satisfies TriggerPayload)

      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'trigger.done' })
        expect(done).toHaveLength(1)
      })

      const [done] = eventLog.recent({ type: 'trigger.done' })
      expect(done.payload).toMatchObject({
        source: 'webhook',
        name: 'test',
        reply: 'AI reply',
      })
      expect(done.causedBy).toBe(triggerEntry.seq)
    })

    it('should not react to other event types', async () => {
      await eventLog.append('some.other.event', { data: 'hello' })

      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })
  })

  // ==================== Delivery ====================

  describe('delivery', () => {
    it('should deliver reply through ConnectorCenter', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'test', to: 'u1',
        capabilities: { push: true, media: false },
        send: async (p) => { delivered.push(p.text); return { delivered: true } },
      })

      await eventLog.append('trigger', {
        source: 'test', name: 'ping', data: {},
      } satisfies TriggerPayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(delivered[0]).toBe('AI reply')
    })

    it('should still log trigger.done when delivery fails', async () => {
      connectorCenter.register({
        channel: 'test', to: 'u1',
        capabilities: { push: true, media: false },
        send: async () => { throw new Error('send failed') },
      })

      await eventLog.append('trigger', {
        source: 'test', name: 'ping', data: {},
      } satisfies TriggerPayload)

      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'trigger.done' })
        expect(done).toHaveLength(1)
      })
    })
  })

  // ==================== Error handling ====================

  describe('error handling', () => {
    it('should write trigger.error on engine failure with causedBy', async () => {
      mockEngine.setShouldFail(true)

      const triggerEntry = await eventLog.append('trigger', {
        source: 'test', name: 'will-fail', data: {},
      } satisfies TriggerPayload)

      await vi.waitFor(() => {
        const errors = eventLog.recent({ type: 'trigger.error' })
        expect(errors).toHaveLength(1)
      })

      const [err] = eventLog.recent({ type: 'trigger.error' })
      expect(err.payload).toMatchObject({
        source: 'test',
        name: 'will-fail',
        error: 'engine error',
      })
      expect(err.causedBy).toBe(triggerEntry.seq)
    })
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('should stop receiving events after stop()', async () => {
      triggerListener.stop()

      await eventLog.append('trigger', {
        source: 'test', name: 'ignored', data: {},
      } satisfies TriggerPayload)

      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })

    it('should be idempotent on repeated start()', async () => {
      await triggerListener.start()  // second call should be no-op
      // No error
    })
  })
})
