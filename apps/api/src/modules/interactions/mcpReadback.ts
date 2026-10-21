import { createHash } from 'node:crypto'
import {
  McpInteractionSummarySchema,
  type DurableInteraction,
} from '@foreman-code/contracts'
import { z } from 'zod'
import { toolResult } from '../../mcp/shared/results.js'
import { DomainError } from '../errors.js'

// Includes both JSON representations and escaping, with room for HTTP/SSE framing and the RPC id.
export const INTERACTION_MCP_RESPONSE_BYTES = 384 * 1024
// Keep options and cursors within the bounded tool-text response.
export const INTERACTION_MCP_TEXT_BYTES = 24 * 1024
const ContentCursorSchema = z.object({
  interactionId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().nonnegative(),
}).strict()

export function fitsInteractionMcpResponse(value: unknown): boolean {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > INTERACTION_MCP_TEXT_BYTES) return false
  const envelope = { jsonrpc: '2.0', id: 'x'.repeat(1000), result: toolResult(value) }
  return Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= INTERACTION_MCP_RESPONSE_BYTES
}

export function interactionMcpSummary(interaction: DurableInteraction) {
  const { id, revision, workspaceId, workflowId, runId, executionId, harness, status,
    deliveryState, approval } = interaction
  const responseOptions: DurableInteraction['responseOptions'] = []
  for (const option of interaction.responseOptions) {
    if (Buffer.byteLength(JSON.stringify([...responseOptions, option]), 'utf8') > 16 * 1024) break
    responseOptions.push(option)
  }
  return McpInteractionSummarySchema.parse({
    id, revision, workspaceId, workflowId, runId, executionId, harness, status, deliveryState, approval,
    ...(interaction.kind ? { kind: interaction.kind } : {}),
    ...(interaction.continuationRunId ? { continuationRunId: interaction.continuationRunId } : {}),
    ...(interaction.selectedOptionId ? { selectedOptionId: interaction.selectedOptionId } : {}),
    ...(interaction.selectedSemantic ? { selectedSemantic: interaction.selectedSemantic } : {}),
    ...(interaction.decidedAt ? { decidedAt: interaction.decidedAt } : {}),
    ...(interaction.deliveredAt ? { deliveredAt: interaction.deliveredAt } : {}),
    responseOptions, responseOptionsComplete: responseOptions.length === interaction.responseOptions.length,
    contentOmitted: true, retrieval: { tool: 'interaction_get', interactionId: id },
  })
}

export function interactionMcpView(interaction: DurableInteraction) {
  return fitsInteractionMcpResponse({ interaction }) ? interaction : interactionMcpSummary(interaction)
}

export function interactionMcpGet(
  value: { interaction: DurableInteraction; activity?: unknown }, contentCursor?: string,
) {
  if (!contentCursor && fitsInteractionMcpResponse(value)) return value
  const json = JSON.stringify(value)
  const sha256 = createHash('sha256').update(json).digest('hex')
  let offset = 0
  if (contentCursor) {
    let cursor: z.infer<typeof ContentCursorSchema>
    try {
      cursor = ContentCursorSchema.parse(JSON.parse(Buffer.from(contentCursor, 'base64url').toString('utf8')))
    } catch {
      throw new DomainError('INVALID_CURSOR', 'The interaction content cursor is invalid.', 400)
    }
    if (cursor.interactionId !== value.interaction.id || cursor.sha256 !== sha256) {
      throw new DomainError('INTERACTION_CONTENT_CHANGED', 'The interaction content changed. Read it again without a content cursor.', 409)
    }
    offset = cursor.offset
    if (offset >= json.length || isSurrogateBoundary(json, offset)) {
      throw new DomainError('INVALID_CURSOR', 'The interaction content cursor is invalid.', 400)
    }
  }
  const interaction = interactionMcpSummary(value.interaction)
  function contentPage(end: number) {
    const nextCursor = end < json.length ? Buffer.from(JSON.stringify({
      interactionId: value.interaction.id, sha256, offset: end,
    })).toString('base64url') : null
    return {
      interaction,
      content: { format: 'json' as const, text: json.slice(offset, end), totalCharacters: json.length, sha256, nextCursor },
    }
  }
  // Use the model-visible byte budget fully so escaped payloads need fewer full-record reads.
  const metadata = contentPage(offset)
  // The largest offset reserves enough cursor bytes for every partial page.
  metadata.content.nextCursor = Buffer.from(JSON.stringify({
    interactionId: value.interaction.id, sha256, offset: json.length,
  })).toString('base64url')
  const available = INTERACTION_MCP_TEXT_BYTES - Buffer.byteLength(JSON.stringify(metadata), 'utf8')
  const end = jsonChunkEnd(json, offset, available)
  const result = contentPage(end)
  if (end > offset && fitsInteractionMcpResponse(result)) return result
  throw new DomainError('INTERACTION_METADATA_TOO_LARGE', 'The interaction metadata exceeds the MCP response budget.', 413)
}

function jsonChunkEnd(text: string, offset: number, available: number): number {
  let end = offset
  while (end < text.length) {
    const code = text.charCodeAt(end)
    let characters = 1
    let bytes = 1
    if (code === 34 || code === 92) bytes = 2
    else if (code >= 0xd800 && code <= 0xdbff && isSurrogateBoundary(text, end + 1)) {
      characters = 2
      bytes = 4
    } else if (code >= 0x800) bytes = 3
    else if (code >= 0x80) bytes = 2
    if (bytes > available) break
    available -= bytes
    end += characters
  }
  return end
}

function isSurrogateBoundary(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1)
  const next = text.charCodeAt(offset)
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
}
