import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { describe, expect, it } from 'vitest'
import { CODEX_INTERACTION_SUPPORT } from '@foreman-code/contracts'
import { HarnessCatalogEntrySchema, HarnessCatalogResultSchema } from '@foreman-code/contracts/management'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Codex interaction capability readback', () => {
  it('agrees through authenticated HTTP and Operator MCP and denies a caller without harness grants', async () => {
    const f = await currentOperatorIntegration()
    try {
      const headers = { authorization: `Bearer ${f.writer.token}` }
      const http = await f.app.inject({ method: 'GET', url: '/api/management/harnesses/codex', headers })
      expect(http.statusCode).toBe(200)
      const entry = HarnessCatalogEntrySchema.parse(http.json())
      expect(entry.interactionSupport).toEqual(CODEX_INTERACTION_SUPPORT)

      const tools = (await f.client.listTools()).tools
      expect(tools.find((tool) => tool.name === 'harness_get')?.description).toContain('data-entry forms')
      const get = await f.client.callTool({ name: 'harness_get', arguments: { harness: 'codex' } })
      expect(get.isError).not.toBe(true)
      expect(HarnessCatalogEntrySchema.parse(decodeMcpToolResult(get))).toEqual(entry)
      const list = await f.client.callTool({ name: 'harness_list', arguments: {} })
      expect(list.isError).not.toBe(true)
      expect(HarnessCatalogResultSchema.parse(decodeMcpToolResult(list)).items.find((item) => item.harness === 'codex'))
        .toEqual(entry)
      expect((await f.services.harnesses.get(f.writer.principal, 'codex')).defaults).toEqual(entry.defaults)

      const restricted = await f.access.issue({ name: 'No harness access', audience: 'operator',
        grants: [{ actions: ['workflows:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      const denied = await f.app.inject({ method: 'GET', url: '/api/management/harnesses/codex',
        headers: { authorization: `Bearer ${restricted.token}` } })
      expect(denied.statusCode).toBe(403)
      const reader = await f.connect(restricted.token)
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain('harness_get')
      await expectMcpAccessDenied(reader.callTool({ name: 'harness_get', arguments: { harness: 'codex' } }))
    } finally { await f.close() }
  }, 60_000)
})
