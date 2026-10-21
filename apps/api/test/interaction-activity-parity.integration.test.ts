import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

/** Uses the existing production native/reviewer factory seam and original-source PostgreSQL approval writer.
 * Provider transport remains recorded fixtures; this is not live provider qualification. */
it.skipIf(!postgresEnabled)('reads one persisted interaction activity through authenticated HTTP/MCP and denies revoked scopes', async () => {
  const f = await routedApprovalFixture()
  const workflows = new PostgresWorkflowRepository(f.db.pool)
  const app = buildApp({
    product: { workspaces: new PostgresWorkspaceRepository(f.db.pool, workflows, f.runs), workflows, runs: f.runs,
      engine: f.engine, interactions: f.service },
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: f.access, services: { commands: new PostgresCommandCoordinator(f.db.pool),
      interactions: new OperatorInteractionService(f.service) } as never } })
  const clients: Client[] = []
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const reader = await f.access.issue({ name: 'Activity reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['interactions:read'], scope: { runIds: [f.run.id] } }] })
    const denied = await f.access.issue({ name: 'Wrong Run', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['interactions:read'], scope: { runIds: ['other-run'] } }] })
    const get = (token: string) => app.inject({ method: 'GET', url: `/api/management/interactions/${f.interaction.id}`,
      headers: { authorization: `Bearer ${token}` } })
    const connect = async (token: string) => {
      const client = new Client({ name: 'W05 interaction parity', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(reader.token), refused = await connect(denied.token)
    const http = await get(reader.token)
    expect(http.statusCode).toBe(200)
    const mcp = await client.callTool({ name: 'interaction_get', arguments: { interactionId: f.interaction.id } })
    expect(mcp.isError).not.toBe(true)
    const activity = http.json().activity
    expect(decodeMcpToolResult(mcp)).toMatchObject({ activity })
    const persisted = await f.repository.get(f.interaction.id)
    expect(activity).toMatchObject({ interactionId: persisted!.id, revision: String(persisted!.revision),
      phase: 'needs_answer', nativeDelivery: 'not_started', answerRecorded: false,
      workerAcknowledgment: 'unknown', response: { available: false, reason: 'unauthorized' },
      owner: { runId: persisted!.runId, executionId: persisted!.executionId },
      native: { sessionId: persisted!.nativeSessionId, requestId: persisted!.nativeRequestId } })
    expect((await get(denied.token)).statusCode).toBe(403)
    expect((await refused.callTool({ name: 'interaction_get', arguments: { interactionId: f.interaction.id } })).isError).toBe(true)
    await f.access.revoke(reader.principal.id)
    expect((await get(reader.token)).statusCode).toBe(401)
    const revoked = await client.callTool({ name: 'interaction_get', arguments: { interactionId: f.interaction.id } }).catch(() => ({ isError: true }))
    expect(revoked.isError).toBe(true)
    expect(f.counts().responses).toBe(0)
    expect((await f.repository.get(f.interaction.id))?.revision).toBe(persisted!.revision)
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()))
    await app.close(); await f.close()
  }
}, 60000)
