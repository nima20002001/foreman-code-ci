import type { Client } from '@modelcontextprotocol/client'

export async function listCiToolNames(client: Pick<Client, 'listTools'>): Promise<string[]> {
  const names: string[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await client.listTools(cursor ? { cursor } : {})
    names.push(...page.tools.map(tool => tool.name))
    if (!page.nextCursor) return names
    if (cursors.has(page.nextCursor)) throw new Error('The MCP tool catalog repeated a pagination cursor.')
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new Error('The MCP tool catalog exceeded its bounded pagination budget.')
}
