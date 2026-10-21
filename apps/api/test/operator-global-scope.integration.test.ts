import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const dimensions = ['workspaceIds', 'workflowIds', 'runIds', 'mainIds', 'deviceIds',
  'applicationInstallationIds', 'providerAccountIds'] as const
const options = { harness: 'codex', providerVersion: 'fixture', authenticated: true,
  models: [], nativeAgents: [], settings: [], restrictions: [], checkedAt: '2026-10-01T00:00:00.000Z' }

describe.skipIf(!postgresEnabled)('persisted global Operator discovery grants', () => {
  it('matches authenticated discovery and invocation to all persisted scope dimensions', async () => {
    const f = await currentOperatorIntegration()
    Object.assign(f.services, { extensions: { native: { options: async () => options } } })
    try {
      for (const dimension of dimensions) {
        const grants = [{ actions: ['harnesses:read' as const], scope: { [dimension]: [randomUUID()] } }]
        const credential = await f.access.issue({ name: `Scoped ${dimension}`, audience: 'operator',
          grants, expiresAt: new Date(Date.now() + 60_000) })
        expect((await f.access.authenticate(credential.token)).grants).toEqual(grants)
        const client = await f.connect(credential.token)
        const names: string[] = []
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : {})
          names.push(...page.tools.map(tool => tool.name))
          cursor = page.nextCursor
        } while (cursor)
        expect(names).not.toContain('harness_options_get')
        const denied = await client.callTool({ name: 'harness_options_get', arguments: { harness: 'codex' } })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
        expect((await f.db.pool.query(
          "select action from management_audit where principal_id=$1 and outcome='denied'",
          [credential.principal.id])).rows).toContainEqual({ action: 'harness_options_get' })
      }
      const result = await f.client.callTool({ name: 'harness_options_get', arguments: { harness: 'codex' } })
      expect(result.isError).not.toBe(true)
      expect(decodeMcpToolResult(result)).toEqual(options)
    } finally { await f.close() }
  }, 60_000)
})
