/**
 * Agent Event Type System — typed event registry with runtime validation.
 *
 * `AgentEvents` is the single source of truth: each event type maps to a
 * metadata record holding its TypeBox schema, whether it's externally
 * ingestable, and an optional human-readable description.
 *
 * `AgentEventSchemas` and `isExternalEventType` are derived views exposed
 * for ergonomics and backward compatibility.
 *
 * Adding a new event type:
 *   1. Define its payload interface
 *   2. Add it to `AgentEventMap`
 *   3. Add an entry to `AgentEvents` with schema + (optional) external/description
 */

import { Type, type TSchema } from '@sinclair/typebox'
import AjvPkg from 'ajv'

// Re-export CronFirePayload from its canonical location
export type { CronFirePayload } from '../task/cron/engine.js'

// ==================== Payload Interfaces ====================

export interface CronDonePayload {
  jobId: string
  jobName: string
  reply: string
  durationMs: number
}

export interface CronErrorPayload {
  jobId: string
  jobName: string
  error: string
  durationMs: number
}

export interface HeartbeatDonePayload {
  reply: string
  reason: string
  durationMs: number
  delivered: boolean
}

export interface HeartbeatSkipPayload {
  reason: string
  parsedReason?: string
}

export interface HeartbeatErrorPayload {
  error: string
  durationMs: number
}

export interface MessageReceivedPayload {
  channel: string
  to: string
  prompt: string
}

export interface MessageSentPayload {
  channel: string
  to: string
  prompt: string
  reply: string
  durationMs: number
}

// ==================== Event Map ====================

// Import the actual CronFirePayload type for use in the map
import type { CronFirePayload } from '../task/cron/engine.js'

export interface AgentEventMap {
  'cron.fire': CronFirePayload
  'cron.done': CronDonePayload
  'cron.error': CronErrorPayload
  'heartbeat.done': HeartbeatDonePayload
  'heartbeat.skip': HeartbeatSkipPayload
  'heartbeat.error': HeartbeatErrorPayload
  'message.received': MessageReceivedPayload
  'message.sent': MessageSentPayload
}

// ==================== TypeBox Schemas ====================

const CronFireSchema = Type.Object({
  jobId: Type.String(),
  jobName: Type.String(),
  payload: Type.String(),
})

const CronDoneSchema = Type.Object({
  jobId: Type.String(),
  jobName: Type.String(),
  reply: Type.String(),
  durationMs: Type.Number(),
})

const CronErrorSchema = Type.Object({
  jobId: Type.String(),
  jobName: Type.String(),
  error: Type.String(),
  durationMs: Type.Number(),
})

const HeartbeatDoneSchema = Type.Object({
  reply: Type.String(),
  reason: Type.String(),
  durationMs: Type.Number(),
  delivered: Type.Boolean(),
})

const HeartbeatSkipSchema = Type.Object({
  reason: Type.String(),
  parsedReason: Type.Optional(Type.String()),
})

const HeartbeatErrorSchema = Type.Object({
  error: Type.String(),
  durationMs: Type.Number(),
})

const MessageReceivedSchema = Type.Object({
  channel: Type.String(),
  to: Type.String(),
  prompt: Type.String(),
})

const MessageSentSchema = Type.Object({
  channel: Type.String(),
  to: Type.String(),
  prompt: Type.String(),
  reply: Type.String(),
  durationMs: Type.Number(),
})

// ==================== AgentEvents — metadata registry ====================

export interface AgentEventMeta {
  /** TypeBox schema for runtime payload validation. */
  schema: TSchema
  /** If true, this event type may be ingested from outside the process
   *  (HTTP webhook, external API). Internal-only types cannot be
   *  forged by external callers. Default: false. */
  external?: boolean
  /** Optional human-readable description — surfaced in topology UI tooltips. */
  description?: string
}

/** Single source of truth — metadata for every registered event type. */
export const AgentEvents: { [K in keyof AgentEventMap]: AgentEventMeta } = {
  'cron.fire': {
    schema: CronFireSchema,
    description: 'Cron scheduler timer fired for a registered job.',
  },
  'cron.done': {
    schema: CronDoneSchema,
    description: 'Cron job was routed through the AI and completed successfully.',
  },
  'cron.error': {
    schema: CronErrorSchema,
    description: 'Cron job routing through the AI failed.',
  },
  'heartbeat.done': {
    schema: HeartbeatDoneSchema,
    description: 'Heartbeat produced content and (attempted to) deliver a notification.',
  },
  'heartbeat.skip': {
    schema: HeartbeatSkipSchema,
    description: 'Heartbeat fired but no notification was sent (HEARTBEAT_OK, duplicate, outside active hours, or empty).',
  },
  'heartbeat.error': {
    schema: HeartbeatErrorSchema,
    description: 'Heartbeat invocation errored.',
  },
  'message.received': {
    schema: MessageReceivedSchema,
    description: 'A user message arrived on a connector (Web chat, Telegram, etc.).',
  },
  'message.sent': {
    schema: MessageSentSchema,
    description: 'An assistant reply was dispatched on a connector.',
  },
}

// ==================== Derived views ====================

/** Schemas-only map — derived for Ajv compilation and existing consumers. */
export const AgentEventSchemas: { [K in keyof AgentEventMap]: TSchema } =
  Object.fromEntries(
    (Object.keys(AgentEvents) as Array<keyof AgentEventMap>).map(
      (k) => [k, AgentEvents[k].schema],
    ),
  ) as { [K in keyof AgentEventMap]: TSchema }

/** Whether this event type may be ingested from outside the process. */
export function isExternalEventType(type: string): boolean {
  return (
    type in AgentEvents &&
    AgentEvents[type as keyof AgentEventMap].external === true
  )
}

// ==================== Runtime Validation ====================

// Ajv ESM interop (same pattern as openclaw/gateway/protocol)
const ajv = new (AjvPkg as unknown as new (opts?: object) => import('ajv').default)({
  allErrors: true,
  strict: false,
})

const validators = new Map<string, ReturnType<typeof ajv.compile>>()
for (const [type, meta] of Object.entries(AgentEvents)) {
  validators.set(type, ajv.compile(meta.schema))
}

/**
 * Validate a payload against its registered schema.
 * - Registered type + valid payload → returns silently
 * - Registered type + invalid payload → throws Error
 * - Unregistered type → returns silently (no schema to check)
 */
export function validateEventPayload(type: string, payload: unknown): void {
  const validate = validators.get(type)
  if (!validate) return
  if (!validate(payload)) {
    const errors = validate.errors?.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')
    throw new Error(`Invalid payload for event "${type}": ${errors}`)
  }
}
