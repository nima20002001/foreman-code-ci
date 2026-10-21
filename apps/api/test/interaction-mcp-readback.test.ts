import { createHash } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import {
  AppInteractionGetOutputSchema, NATIVE_INTERACTION_FIXTURES, type DurableInteraction,
} from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresAppInteractionService, decodeInteractionCursor } from '../src/modules/interactions/app.js'
import {
  interactionMcpGet, INTERACTION_MCP_RESPONSE_BYTES, INTERACTION_MCP_TEXT_BYTES,
  interactionMcpSummary,
} from '../src/modules/interactions/mcpReadback.js'
import { toolResult } from '../src/mcp/shared/results.js'

const source = NATIVE_INTERACTION_FIXTURES.codex
const principal: ManagementPrincipal = {
  id: 'reader', name: 'Reader', audience: 'worker', agentId: 'reader-agent',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['interactions:read'], scope: {
    workspaceIds: [source.workspaceId], workflowIds: [source.workflowId], runIds: [source.runId],
  } }],
}

function modelVisible(value: unknown) {
  const result = toolResult(value)
  // Bounded interaction responses always expose their JSON through content.
  expect(result.content).toHaveLength(1)
  const text = result.content[0]
  if (text?.type !== 'text') throw new Error('Expected model-readable text')
  expect(Buffer.byteLength(text.text, 'utf8')).toBeLessThanOrEqual(INTERACTION_MCP_TEXT_BYTES)
  expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), 'utf8'))
    .toBeLessThan(INTERACTION_MCP_RESPONSE_BYTES)
  return JSON.parse(text.text) as ReturnType<typeof AppInteractionGetOutputSchema.parse>
}

describe('bounded interaction MCP readback', () => {
  it('keeps a workflow direction choice and its continuation Run in bounded readback', () => {
    const interaction: DurableInteraction = { ...source, kind: 'work_direction', approval: { handler: 'user' },
      nativeRequestType: 'workflow/work_direction', status: 'delivered', deliveryState: 'delivered',
      responseOptions: [{ ...source.responseOptions[0]!, optionId: 'continue', semantic: 'approve_once' }],
      selectedOptionId: 'continue', selectedSemantic: 'approve_once', nativeResponse: { optionId: 'continue', semantic: 'approve_once' },
      decidedAt: source.createdAt, deliveredAt: source.createdAt, continuationRunId: 'continuation-run',
    }
    expect(interactionMcpSummary(interaction)).toMatchObject({ kind: 'work_direction',
      continuationRunId: 'continuation-run', selectedOptionId: 'continue' })
  })
  it.each(['x', '"\\\n', '😀界'])('retrieves oversized JSON without losing identity, options or characters: %s', (pattern) => {
    const interaction = { ...source, request: { patch: pattern.repeat(400_000) } }
    let page = modelVisible(interactionMcpGet({ interaction }))
    expect(page.interaction).toMatchObject({ id: source.id, responseOptions: source.responseOptions })
    let json = ''
    const digest = page.content!.sha256
    do {
      const content = page.content!
      json += content.text
      expect(content.sha256).toBe(digest)
      if (!content.nextCursor) break
      page = modelVisible(interactionMcpGet({ interaction }, content.nextCursor))
    } while (json.length < page.content!.totalCharacters)
    expect(JSON.parse(json)).toEqual({ interaction })
    expect(createHash('sha256').update(json).digest('hex')).toBe(digest)
  })

  it('rejects content cursors after a revision change or against a different interaction', () => {
    const interaction = { ...source, request: { patch: 'x'.repeat(600_000) } }
    const cursor = AppInteractionGetOutputSchema.parse(interactionMcpGet({ interaction })).content!.nextCursor!
    expect(() => interactionMcpGet({ interaction: { ...interaction, revision: 1 } }, cursor))
      .toThrow('content changed')
    expect(() => interactionMcpGet({ interaction: { ...interaction, id: 'other' } }, cursor))
      .toThrow('content changed')
    expect(() => interactionMcpGet({ interaction }, 'invalid')).toThrow('cursor is invalid')
  })

  it('paginates by serialized envelope bytes without skipping records', async () => {
    const records = Array.from({ length: 6 }, (_, index) => ({
      ...source, id: `interaction-${index}`, request: { patch: '界"'.repeat(3_000) },
    }))
    const pool = { query: async (_sql: string, values: unknown[]) => ({
      rows: records.filter((record) => values[1] === null || record.id > String(values[1]))
        .slice(0, Number(values[2])).map((record) => ({ record })),
    }) } as unknown as pg.Pool
    const service = new PostgresAppInteractionService(pool, {} as never, {} as never)
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const page = await service.list(principal, cursor ? { cursor } : {})
      const result = toolResult(page)
      expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), 'utf8'))
        .toBeLessThan(INTERACTION_MCP_RESPONSE_BYTES)
      expect(page.items.length).toBeGreaterThan(0)
      expect(page.items.length).toBeLessThan(records.length)
      ids.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
      if (cursor) expect(decodeInteractionCursor(cursor)).toBe(page.items.at(-1)!.id)
    } while (cursor)
    expect(ids).toEqual(records.map((record) => record.id))
  })

  it('reauthorizes every chunk and keeps large response options retrievable', async () => {
    const interaction: DurableInteraction = { ...source, request: { patch: 'x'.repeat(600_000) },
      responseOptions: [{ ...source.responseOptions[0]!, label: 'large option '.repeat(20_000) }] }
    const service = new PostgresAppInteractionService({} as pg.Pool,
      { get: async () => interaction } as never, {} as never)
    let page = AppInteractionGetOutputSchema.parse(await service.get(principal, interaction.id))
    expect(page.interaction).toMatchObject({ responseOptions: [], responseOptionsComplete: false })
    await expect(service.get({ ...principal, grants: [] }, interaction.id, page.content!.nextCursor!))
      .rejects.toMatchObject({ code: 'INTERACTION_NOT_FOUND' })
    let json = ''
    do {
      json += page.content!.text
      const cursor = page.content!.nextCursor
      if (!cursor) break
      page = AppInteractionGetOutputSchema.parse(await service.get(principal, interaction.id, cursor))
      modelVisible(page)
    } while (json.length < page.content!.totalCharacters)
    expect(JSON.parse(json).interaction.responseOptions).toEqual(interaction.responseOptions)
  })
})
