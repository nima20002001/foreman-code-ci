import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { z } from 'zod'

import { createGraphqlMcpServer } from '../src/mcp/unified/server.js'

it('strips unknown MCP input fields while preserving validation, open records and strict outputs', async () => {
  const item = z.object({ label: z.string().min(1) }).strict().describe('Item label')
  const schema = z.object({
    items: z.array(item).min(1),
    optional: item.optional(),
    nullable: item.nullable(),
    lazy: z.lazy(() => item),
    choice: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), text: z.string() }).strict(),
      z.object({ kind: z.literal('number'), count: z.number().int() }).strict(),
    ]),
    metadata: z.record(z.string(), z.unknown()),
    limit: z.number().int().positive().default(10),
  }).strict().refine(value => value.items.length <= value.limit, 'Too many items')
  const server = await createGraphqlMcpServer({
    role: 'coder', principal: {
      id: 'schema-caller', name: 'Schema caller', audience: 'worker', agentId: 'schema-agent',
      grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    },
  })
  server.registerTool('echo', { inputSchema: schema, outputSchema: schema }, async input => ({
    content: [], structuredContent: input,
  }))
  server.registerTool('invalid_output', { inputSchema: z.object({}).strict(), outputSchema: item }, async () => ({
    content: [], structuredContent: { label: 'valid', extra: true },
  }))
  const client = new Client({ name: 'schema-client', version: '1' })
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const input = {
      items: [{ label: 'first', extra: true }], optional: { label: 'optional', extra: true },
      nullable: null, lazy: { label: 'lazy', extra: true },
      choice: { kind: 'text', text: 'hello', extra: true },
      metadata: { arbitrary: { extra: true } }, extra: 'ignored',
    }
    const result = await client.callTool({ name: 'echo', arguments: input })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      items: [{ label: 'first' }], optional: { label: 'optional' }, nullable: null,
      lazy: { label: 'lazy' }, choice: { kind: 'text', text: 'hello' },
      metadata: input.metadata, limit: 10,
    })
    const echo = (await client.listTools()).tools.find(tool => tool.name === 'echo')!
    expect(echo.inputSchema.additionalProperties).not.toBe(false)
    expect(JSON.stringify(echo.inputSchema)).toContain('Item label')
    expect(schema.safeParse(input).success).toBe(false)
    expect((await client.callTool({ name: 'echo', arguments: { ...input, limit: 0 } })).isError).toBe(true)
    expect((await client.callTool({ name: 'echo', arguments: {
      ...input, items: [{ label: '' }],
    } })).isError).toBe(true)
    expect((await client.callTool({ name: 'echo', arguments: {
      ...input, items: [{ label: 'first' }, { label: 'second' }], limit: 1,
    } })).isError).toBe(true)
    expect((await client.callTool({ name: 'invalid_output', arguments: { extra: true } })).isError).toBe(true)
  } finally {
    await client.close()
    await server.close()
  }
})
