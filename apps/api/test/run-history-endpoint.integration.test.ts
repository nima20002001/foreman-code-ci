import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import type { ManagementAction, ManagementScope } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { currentRunHistory } from './helpers/currentRunHistory.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

/** Real HTTP/Streamable MCP, live bearer grants and typed persisted V3 facts.
 * This is read parity; no provider or execution completion is simulated. */
describe.skipIf(!postgresEnabled)('saved current Run HTTP/MCP parity', () => {
  let fixture: Awaited<ReturnType<typeof currentRunHistory>>
  let app: ReturnType<typeof buildApp>, address: string
  let grantedToken: string, runsOnlyToken: string, deniedToken: string
  const clients: Client[] = []
  beforeAll(async () => {
    fixture = await currentRunHistory()
    const { db, access, commands, run } = fixture
    const issue = async (grants: Array<{ actions: ManagementAction[]; scope: ManagementScope }>) =>
      (await access.issue({ name: 'Saved Run reader', audience: 'operator', grants, expiresAt: new Date(Date.now() + 300000) })).token
    const grant: { actions: ManagementAction[]; scope: ManagementScope } = { actions: ['runs:read'],
      scope: { workspaceIds: [run.workspaceId], workflowIds: [run.workflowId], runIds: [run.id] } }
    grantedToken = await issue([grant, { actions: ['workspace_locations:read'], scope: { workspaceIds: [run.workspaceId] } }])
    runsOnlyToken = await issue([grant])
    deniedToken = await issue([{ ...grant, scope: { ...grant.scope, runIds: ['foreign-run'] } }])
    type Args = ConstructorParameters<typeof RunManagementService>
    const runs = new RunManagementService(db.pool, commands, {} as Args[2], {} as Args[3], {} as Args[4])
    app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { runs, commands } as unknown as OperatorServices } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60000)
  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined)
    await app?.close(); await fixture?.db.close()
  })
  const input = () => ({ workspaceId: fixture.run.workspaceId, runId: fixture.run.id })
  const path = () => `/api/management/workspaces/${fixture.run.workspaceId}/runs/${fixture.run.id}`
  async function connect(token: string) {
    const client = new Client({ name: 'current-run-parity', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    clients.push(client); return client
  }
  it('returns the same immutable saved pins through HTTP and MCP with grant-based location redaction', async () => {
    for (const token of [grantedToken, runsOnlyToken]) {
      const response = await app.inject({ method: 'GET', url: path(), headers: { host: 'localhost', authorization: `Bearer ${token}` } })
      expect(response.statusCode).toBe(200)
      const detail = SavedRunDetailsSchema.parse(response.json())
      const client = await connect(token)
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      expect(names).toContain('run_get'); expect(names).not.toContain('run_history_get_v1')
      const remote = await client.callTool({ name: 'run_get', arguments: { ...input(), detail: 'full' } })
      expect(remote.isError).not.toBe(true)
      expect(SavedRunDetailsSchema.parse(decodeMcpToolResult(remote))).toEqual(detail)
      expect(detail.run.workflowVersionId).toBe(fixture.saved.value.currentVersionId)
      expect(detail.run.workflowVersionId).not.toBe(fixture.newer.value.currentVersionId)
      expect(detail.run.executionSemanticsVersion).toBe(3)
      expect(detail.run).not.toHaveProperty('authorizationPrincipalId')
      if (token === grantedToken) expect(detail.run.executionLocation).toEqual(fixture.run.executionLocation)
      else expect(detail.run).not.toHaveProperty('executionLocation')
    }
  }, 30_000)
  it('denies another Run scope through both authenticated transports', async () => {
    const response = await app.inject({ method: 'GET', url: path(), headers: { host: 'localhost', authorization: `Bearer ${deniedToken}` } })
    expect(response.statusCode).toBe(403)
    const result = await (await connect(deniedToken)).callTool({ name: 'run_get', arguments: { ...input(), detail: 'full' } })
    expect(result.isError).toBe(true)
  }, 30_000)
})
