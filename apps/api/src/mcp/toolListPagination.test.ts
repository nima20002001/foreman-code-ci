import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer, type ListToolsResult } from '@modelcontextprotocol/server'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { paginateToolLists } from './toolListPagination.js'

it('pages complete SDK schemas within the Worker relay budget and aggregates them without missing tools', async () => {
  const server = new McpServer({ name: 'catalog-fixture', version: '1' })
  paginateToolLists(server)
  const definitions = Array.from({ length: 6 }, (_, index) => ({
    name: `tool_${index}`, description: 'Bounded description. '.repeat(9000),
  }))
  const tools = definitions.map(definition => server.registerTool(definition.name, {
    description: definition.description, inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }), annotations: { readOnlyHint: true },
  }, async input => ({ content: [], structuredContent: { value: input.value } })))
  const client = new Client({ name: 'catalog-client', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const listed: ListToolsResult['tools'] = []
    let cursor: string | undefined
    let firstCursor: string | undefined
    do {
      const result = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} })
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(400 * 1024)
      expect(Buffer.byteLength(JSON.stringify({ body: JSON.stringify(result) }))).toBeLessThan(1_000_000)
      listed.push(...result.tools)
      cursor = result.nextCursor
      firstCursor ??= cursor
    } while (cursor)
    expect(listed.map(tool => ({ name: tool.name, description: tool.description }))).toEqual(definitions)
    expect(listed.every(tool => tool.inputSchema.type === 'object' && tool.outputSchema?.type === 'object'
      && tool.annotations?.readOnlyHint)).toBe(true)
    expect((await client.listTools()).tools).toEqual(listed)
    expect((await client.callTool({ name: 'tool_5', arguments: { value: 'last-page-call' } })).structuredContent)
      .toEqual({ value: 'last-page-call' })
    expect(firstCursor).toBeDefined()
    await expect(client.request({ method: 'tools/list', params: { cursor: 'malformed' } })).rejects.toThrow('cursor')
    tools[5]!.disable()
    await expect(client.request({ method: 'tools/list', params: { cursor: firstCursor! } })).rejects.toThrow('catalog changed')
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(definitions.slice(0, 5).map(tool => tool.name))
  } finally {
    await client.close()
    await server.close()
  }
})
