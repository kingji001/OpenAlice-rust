/**
 * Tool bridge — converts ToolCenter's Vercel AI SDK tools to OpenAI Responses API format.
 *
 * Much simpler than the Agent SDK bridge (no MCP server needed) — just JSON Schema objects.
 */

import { z } from 'zod'
import type { Tool } from 'ai'

// ==================== Types ====================

export interface ResponsesApiTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: boolean | null
}

// ==================== Conversion ====================

/**
 * Convert Vercel AI SDK tools to OpenAI Responses API tool definitions.
 *
 * @param tools  Record<name, Tool> from ToolCenter.getVercelTools()
 * @param disabledTools  Optional list of tool names to exclude
 */
export function convertTools(
  tools: Record<string, Tool>,
  disabledTools?: string[],
): ResponsesApiTool[] {
  const disabledSet = new Set(disabledTools ?? [])

  return Object.entries(tools)
    .filter(([name, t]) => t.execute && !disabledSet.has(name))
    .map(([name, t]) => {
      let parameters: Record<string, unknown>
      try {
        parameters = z.toJSONSchema(t.inputSchema as z.ZodType)
      } catch {
        parameters = { type: 'object', properties: {} }
      }
      return {
        type: 'function' as const,
        name,
        description: t.description ?? name,
        parameters,
        strict: null,
      }
    })
}
