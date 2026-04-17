import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog } from '../../core/event-log.js'
import { createListenerRegistry, type ListenerRegistry } from '../../core/listener-registry.js'
import { createCronListener, type CronListener } from './listener.js'
import { SessionStore } from '../../core/session.js'
import type { CronFirePayload } from './engine.js'
import { ConnectorCenter } from '../../core/connector-center.js'

function tempPath(ext: string): string {
  return join(tmpdir(), `cron-listener-test-${randomUUID()}.${ext}`)
}

// ==================== Mock Engine ====================

function createMockEngine(response = 'AI reply') {
  const calls: Array<{ prompt: string; session: SessionStore }> = []
  let shouldFail = false

  return {
    calls,
    setResponse(text: string) { response = text },
    setShouldFail(val: boolean) { shouldFail = val },
    // Partial Engine mock — only askWithSession is needed
    askWithSession: vi.fn(async (prompt: string, session: SessionStore) => {
      calls.push({ prompt, session })
      if (shouldFail) throw new Error('engine error')
      return { text: response, media: [] }
    }),
    // Stubs for other Engine methods
    ask: vi.fn(),
  }
}

describe('cron listener', () => {
  let eventLog: EventLog
  let registry: ListenerRegistry
  let cronListener: CronListener
  let mockEngine: ReturnType<typeof createMockEngine>
  let session: SessionStore
  let logPath: string
  let connectorCenter: ConnectorCenter

  beforeEach(async () => {
    logPath = tempPath('jsonl')
    eventLog = await createEventLog({ logPath })
    registry = createListenerRegistry(eventLog)
    mockEngine = createMockEngine()
    session = new SessionStore(`test/cron-${randomUUID()}`)
    connectorCenter = new ConnectorCenter()

    cronListener = createCronListener({
      connectorCenter,
      agentCenter: mockEngine as any,
      registry,
      session,
    })
    await cronListener.start()
    await registry.start()
  })

  afterEach(async () => {
    await registry.stop()
    await eventLog._resetForTest()
  })

  // ==================== Basic functionality ====================

  describe('event handling', () => {
    it('should call engine.askWithSession on cron.fire', async () => {
      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Check the market',
      } satisfies CronFirePayload)

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockEngine.askWithSession).toHaveBeenCalledTimes(1)
      })

      expect(mockEngine.askWithSession).toHaveBeenCalledWith(
        'Check the market',
        session,
        expect.objectContaining({ historyPreamble: expect.any(String) }),
      )
    })

    it('should write cron.done event on success', async () => {
      const fireEntry = await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Do something',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'cron.done' })
      expect(done[0].payload).toMatchObject({
        jobId: 'abc12345',
        jobName: 'test-job',
        reply: 'AI reply',
      })
      expect((done[0].payload as any).durationMs).toBeGreaterThanOrEqual(0)
      expect(done[0].causedBy).toBe(fireEntry.seq)
    })

    it('should not react to other event types', async () => {
      await eventLog.append('some.other.event', { data: 'hello' })

      // Give it a moment
      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })
  })

  // ==================== Delivery ====================

  describe('delivery', () => {
    it('should deliver reply through connector registry', async () => {
      const delivered: string[] = []
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async (payload) => { delivered.push(payload.text); return { delivered: true } },
      })

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(delivered).toHaveLength(1)
      })

      expect(delivered[0]).toBe('AI reply')
    })

    it('should handle delivery failure gracefully', async () => {
      connectorCenter.register({
        channel: 'test',
        to: 'user1',
        capabilities: { push: true, media: false },
        send: async () => { throw new Error('send failed') },
      })

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      // Should still write cron.done (delivery failure is non-fatal)
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })
    })

    it('should handle no connectors gracefully', async () => {
      // No connectors registered
      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      // Should still write cron.done
      await vi.waitFor(() => {
        const done = eventLog.recent({ type: 'cron.done' })
        expect(done).toHaveLength(1)
      })
    })
  })

  // ==================== Error handling ====================

  describe('error handling', () => {
    it('should write cron.error on engine failure', async () => {
      mockEngine.setShouldFail(true)

      const fireEntry = await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Will fail',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        const errors = eventLog.recent({ type: 'cron.error' })
        expect(errors).toHaveLength(1)
      })

      const errors = eventLog.recent({ type: 'cron.error' })
      expect(errors[0].payload).toMatchObject({
        jobId: 'abc12345',
        jobName: 'test-job',
        error: 'engine error',
      })
      expect((errors[0].payload as any).durationMs).toBeGreaterThanOrEqual(0)
      expect(errors[0].causedBy).toBe(fireEntry.seq)
    })
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('should stop receiving events after registry.stop()', async () => {
      await registry.stop()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Should not fire',
      } satisfies CronFirePayload)

      // Give it a moment
      await new Promise((r) => setTimeout(r, 50))

      expect(mockEngine.askWithSession).not.toHaveBeenCalled()
    })

    it('should be idempotent on repeated start()', async () => {
      await cronListener.start()  // second call — should be a no-op
      // No error
    })
  })
})
