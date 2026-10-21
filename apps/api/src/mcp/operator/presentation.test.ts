import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { paginateToolLists } from '../toolListPagination.js'
import { toolResult } from '../shared/results.js'
import { installOperatorPresentation } from './presentation.js'

async function fixture() {
  const server = new McpServer({ name: 'operator-presentation-test', version: '1' })
  paginateToolLists(server)
  const catalog = installOperatorPresentation(server)
  const client = new Client({ name: 'presentation-client', version: '1' })
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
  return { server, client, catalog,
    async connect() { await server.connect(serverTransport); await client.connect(transport) },
    async close() { await client.close(); await server.close() },
  }
}

describe('Operator MCP presentation', () => {
  it('projects before pagination, retains input constraints and invalidates changed catalog cursors', async () => {
    const f = await fixture()
    const description = 'Operational instructions. '.repeat(10000)
    const registered = [0, 1, 2].map((index) => f.server.registerTool(`read_${index}`, {
      description, inputSchema: z.object({ limit: z.number().int().min(1).max(10) }),
      outputSchema: z.object({ value: z.string().describe('Large output documentation. '.repeat(10000)) }),
      annotations: { readOnlyHint: true },
    }, async () => toolResult({ value: 'ok' })))
    await f.connect()
    try {
      const first = await f.client.request({ method: 'tools/list', params: {} })
      expect(first.tools).toHaveLength(1)
      expect(first.nextCursor).toBeDefined()
      expect(first.tools[0]).toMatchObject({ annotations: { readOnlyHint: true },
        inputSchema: { properties: { limit: { minimum: 1, maximum: 10, type: 'integer' } } } })
      expect(first.tools[0]).not.toHaveProperty('outputSchema')
      const all = await f.client.listTools()
      expect(all.tools.map((tool) => tool.name)).toEqual(['read_0', 'read_1', 'read_2'])
      const result = await f.client.callTool({ name: 'read_2', arguments: { limit: 1 } })
      expect(decodeMcpToolResult(result)).toEqual({ value: 'ok' })
      registered[0]!.update({ description: 'Changed instructions.' })
      await expect(f.client.request({ method: 'tools/list', params: { cursor: first.nextCursor! } }))
        .rejects.toThrow(/catalog changed|cursor is invalid/i)
    } finally { await f.close() }
  })

  it('keeps SDK output validation and sends one complete JSON text body with distinct content', async () => {
    const f = await fixture()
    const value = { items: ['first', 'last'], description: 'x'.repeat(1000), nullable: null }
    f.server.registerTool('read', {
      inputSchema: z.object({}), outputSchema: z.object({
        items: z.array(z.string()), description: z.string(), nullable: z.null(),
      }),
    }, async (_input, context) => {
      expect(context.mcpReq.signal).toBeInstanceOf(AbortSignal)
      return { ...toolResult(value), content: [
        { type: 'text', text: 'Distinct instructions.' },
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
      ] }
    })
    f.server.registerTool('invalid', { inputSchema: z.object({}), outputSchema: z.object({ count: z.number() }) },
      async () => toolResult({ count: 'invalid' }))
    await f.connect()
    try {
      expect((await f.client.listTools()).tools.every((tool) => tool.outputSchema === undefined)).toBe(true)
      const result = await f.client.callTool({ name: 'read', arguments: {} })
      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(value) },
        { type: 'text', text: 'Distinct instructions.' },
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
      ])
      expect(decodeMcpToolResult(result)).toEqual(value)
      const invalid = await f.client.callTool({ name: 'invalid', arguments: {} })
      expect(invalid.isError).toBe(true)
      expect(JSON.stringify(invalid.content)).toContain('Output validation error')
    } finally { await f.close() }
  })

  it('keeps large escaped data in one structured payload and preserves distinct content', async () => {
    const f = await fixture()
    const value = { prompt: { system: '"'.repeat(255000) }, nullable: null }
    const json = JSON.stringify(value)
    f.server.registerTool('read_large', {
      inputSchema: z.object({}),
      outputSchema: z.object({ prompt: z.object({ system: z.string() }), nullable: z.null() }),
    }, async () => ({ structuredContent: value, content: [
      { type: 'text', text: json },
      { type: 'text', text: 'Distinct instructions.' },
      { type: 'image', data: 'AA==', mimeType: 'image/png' },
    ] }))
    await f.connect()
    try {
      const result = await f.client.callTool({ name: 'read_large', arguments: {} })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual(value)
      expect(result.content).toEqual([
        { type: 'text', text: 'Distinct instructions.' },
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
      ])
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(1_000_000)
      expect(decodeMcpToolResult(result)).toEqual(value)
    } finally { await f.close() }
  })

  it('returns a source approval as one JSON text item even above the mirror threshold', async () => {
    const f = await fixture()
    const value = { value: { entries: Array.from({ length: 3000 }, (_, index) => ({
      path: `source-${index}`, digest: 'a'.repeat(64),
    })) }, replayed: false }
    f.server.registerTool('source_approve', { inputSchema: z.object({}) }, async () => toolResult(value))
    await f.connect()
    try {
      const result = await f.client.callTool({ name: 'source_approve', arguments: {} })
      expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(256 * 1024)
      expect(result.structuredContent).toBeUndefined()
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }])
      expect(decodeMcpToolResult(result)).toEqual(value)
    } finally { await f.close() }
  })

  it('removes identical mirrors while retaining wrapped array and primitive results', async () => {
    const f = await fixture()
    for (const [name, value] of [['array', [1, 2]], ['primitive', false]] as const) {
      f.server.registerTool(name, { inputSchema: z.object({}) }, async () => toolResult(value))
    }
    await f.connect()
    try {
      for (const name of ['array', 'primitive']) {
        const result = await f.client.callTool({ name, arguments: {} })
        expect(result.structuredContent).toBeUndefined()
        expect(result.content).toHaveLength(1)
        expect(decodeMcpToolResult(result)).toEqual({ value: name === 'array' ? [1, 2] : false })
      }
    } finally { await f.close() }
  })
})
