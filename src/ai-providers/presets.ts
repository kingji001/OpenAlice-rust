/**
 * AI Provider Presets — schema-driven templates for profile creation.
 *
 * Each preset produces a JSON Schema that tells the frontend exactly
 * how to render the creation/edit form:
 *   - const fields → hidden (value baked in)
 *   - oneOf fields → dropdown with labels
 *   - writeOnly fields → password input
 *   - required / default / description → form behavior
 *
 * Frontend is a pure renderer — no field logic, no hardcoded options.
 */

import { z } from 'zod'
// AIBackend type used implicitly via z.literal() values

// ==================== Serialized Preset (sent to frontend) ====================

export interface SerializedPreset {
  id: string
  label: string
  description: string
  category: 'official' | 'third-party' | 'custom'
  hint?: string
  defaultName: string
  schema: Record<string, unknown>
}

// ==================== Model option with label ====================

interface ModelOption {
  id: string
  label: string
}

// ==================== Internal preset definition ====================

interface PresetDef {
  id: string
  label: string
  description: string
  category: 'official' | 'third-party' | 'custom'
  hint?: string
  defaultName: string
  zodSchema: z.ZodType
  /** Models with human-readable labels. Post-processed into oneOf. */
  models?: ModelOption[]
  /** Property name for the model field (default: 'model'). */
  modelField?: string
  /** If true, model can be left empty. */
  modelOptional?: boolean
  /** Properties that should be rendered as password fields. */
  writeOnlyFields?: string[]
}

// ==================== Schema post-processing ====================

/** Convert a Zod schema to JSON Schema, then apply preset-specific transforms. */
function buildJsonSchema(def: PresetDef): Record<string, unknown> {
  const raw = z.toJSONSchema(def.zodSchema) as Record<string, unknown>
  const props = (raw.properties ?? {}) as Record<string, Record<string, unknown>>

  // Inject oneOf for model field (replace plain enum with labeled options)
  const mf = def.modelField ?? 'model'
  if (def.models?.length && props[mf]) {
    const oneOf = def.models.map(m => ({ const: m.id, title: m.label }))
    if (def.modelOptional) {
      oneOf.unshift({ const: '', title: 'Auto (based on subscription plan)' })
    }
    const { enum: _e, ...rest } = props[mf]
    props[mf] = { ...rest, oneOf }
  }

  // Mark writeOnly fields (rendered as password inputs)
  for (const field of def.writeOnlyFields ?? []) {
    if (props[field]) props[field].writeOnly = true
  }

  raw.properties = props
  return raw
}

// ==================== Preset definitions ====================

const PRESET_DEFS: PresetDef[] = [
  // ── Official: Claude ──
  {
    id: 'claude-oauth',
    label: 'Claude (Subscription)',
    description: 'Use your Claude Pro/Max subscription',
    category: 'official',
    defaultName: 'Claude (Pro/Max)',
    hint: 'Requires Claude Code CLI login. Run `claude login` in your terminal first.',
    zodSchema: z.object({
      backend: z.literal('agent-sdk' as const),
      loginMethod: z.literal('claudeai' as const),
      model: z.string().optional().default('').describe('Leave empty to auto-select based on your plan'),
    }),
    models: [
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    ],
    modelOptional: true,
  },
  {
    id: 'claude-api',
    label: 'Claude (API Key)',
    description: 'Pay per token via Anthropic API',
    category: 'official',
    defaultName: 'Claude (API Key)',
    zodSchema: z.object({
      backend: z.literal('agent-sdk' as const),
      loginMethod: z.literal('api-key' as const),
      model: z.string().default('claude-sonnet-4-6').describe('Model'),
      apiKey: z.string().min(1).describe('Anthropic API key'),
    }),
    models: [
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    writeOnlyFields: ['apiKey'],
  },

  // ── Official: OpenAI / Codex ──
  {
    id: 'codex-oauth',
    label: 'OpenAI / Codex (Subscription)',
    description: 'Use your ChatGPT subscription',
    category: 'official',
    defaultName: 'OpenAI / Codex (Subscription)',
    hint: 'Requires Codex CLI login. Run `codex login` in your terminal first.',
    zodSchema: z.object({
      backend: z.literal('codex' as const),
      loginMethod: z.literal('codex-oauth' as const),
      model: z.string().optional().default('gpt-5.4').describe('Leave empty to auto-select'),
    }),
    models: [
      { id: 'gpt-5.4', label: 'GPT 5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT 5.4 Mini' },
    ],
    modelOptional: true,
  },
  {
    id: 'codex-api',
    label: 'OpenAI (API Key)',
    description: 'Pay per token via OpenAI API',
    category: 'official',
    defaultName: 'OpenAI (API Key)',
    zodSchema: z.object({
      backend: z.literal('codex' as const),
      loginMethod: z.literal('api-key' as const),
      model: z.string().default('gpt-5.4').describe('Model'),
      apiKey: z.string().min(1).describe('OpenAI API key'),
    }),
    models: [
      { id: 'gpt-5.4', label: 'GPT 5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT 5.4 Mini' },
    ],
    writeOnlyFields: ['apiKey'],
  },

  // ── Official: Gemini ──
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Google AI via API key',
    category: 'official',
    defaultName: 'Google Gemini',
    zodSchema: z.object({
      backend: z.literal('vercel-ai-sdk' as const),
      provider: z.literal('google' as const),
      model: z.string().default('gemini-2.5-flash').describe('Model'),
      apiKey: z.string().min(1).describe('Google AI API key'),
    }),
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    writeOnlyFields: ['apiKey'],
  },

  // ── Third-party: MiniMax ──
  {
    id: 'minimax',
    label: 'MiniMax',
    description: 'MiniMax models via Claude Agent SDK (Anthropic-compatible)',
    category: 'third-party',
    defaultName: 'MiniMax',
    hint: 'Get your API key at minimaxi.com',
    zodSchema: z.object({
      backend: z.literal('agent-sdk' as const),
      loginMethod: z.literal('api-key' as const),
      baseUrl: z.literal('https://api.minimaxi.com/anthropic').describe('MiniMax API endpoint'),
      model: z.string().default('MiniMax-M2.7').describe('Model'),
      apiKey: z.string().min(1).describe('MiniMax API key'),
    }),
    models: [
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
    ],
    writeOnlyFields: ['apiKey'],
  },

  // ── Custom ──
  {
    id: 'custom',
    label: 'Custom',
    description: 'Full control — any provider, model, and endpoint',
    category: 'custom',
    defaultName: '',
    zodSchema: z.object({
      backend: z.enum(['agent-sdk', 'codex', 'vercel-ai-sdk']).default('vercel-ai-sdk').describe('Backend engine'),
      provider: z.string().optional().default('openai').describe('SDK provider (for Vercel AI SDK)'),
      loginMethod: z.string().optional().default('api-key').describe('Authentication method'),
      model: z.string().describe('Model ID'),
      baseUrl: z.string().optional().describe('Custom API endpoint (leave empty for official)'),
      apiKey: z.string().optional().describe('API key'),
    }),
    writeOnlyFields: ['apiKey'],
  },
]

// ==================== Exported: serialized presets ====================

export const BUILTIN_PRESETS: SerializedPreset[] = PRESET_DEFS.map(def => ({
  id: def.id,
  label: def.label,
  description: def.description,
  category: def.category,
  hint: def.hint,
  defaultName: def.defaultName,
  schema: buildJsonSchema(def),
}))
