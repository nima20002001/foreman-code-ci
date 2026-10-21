import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { RespondToInteractionResponseSchema } from '@foreman-code/contracts'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { registerApprovalCheckpointResume } from '../src/modules/runs/approvalCheckpointRegistration.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.skipIf(!postgresEnabled)('authorizes workflow Operator responses, persists readback, and recovers without another native response', async () => {
  const f = await codexApprovalRuntime('user')
  const workflows = new PostgresWorkflowRepository(f.db.pool)
  const app = buildApp({
    product: { workspaces: new PostgresWorkspaceRepository(f.db.pool, workflows, f.runs), workflows,
      runs: f.runs, engine: f.engine, interactions: f.service },
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: {
      commands: new PostgresCommandCoordinator(f.db.pool), interactions: new OperatorInteractionService(f.service),
    } as unknown as OperatorServices },
  })
  const clients: Client[] = []
  try {
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    if (!interaction) throw new Error('Expected an original-source native request')
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const grants = { runIds: [f.f.run.id] }
    const writer = await f.access.issue({ name: 'Interaction responder', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: grants }] })
    const reader = await f.access.issue({ name: 'Interaction reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['interactions:read'], scope: grants }] })
    const other = await f.access.issue({ name: 'Other Run responder', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { runIds: ['other-run'] } }] })
    const connect = async (token: string) => {
      const client = new Client({ name: 'workflow-input-response', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(writer.token)
    const readonly = await connect(reader.token)
    const wrongScope = await connect(other.token)
    const input = approvalResponse(interaction)
    const url = `/api/management/interactions/${interaction.id}/respond`
    expect((await readonly.listTools()).tools.some((tool) => tool.name === 'interaction_respond')).toBe(false)
    expect((await readonly.callTool({ name: 'interaction_respond', arguments: input })).isError).toBe(true)
    expect((await wrongScope.callTool({ name: 'interaction_respond', arguments: input })).isError).toBe(true)
    expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${reader.token}` },
      payload: input })).statusCode).toBe(403)
    expect((await client.callTool({ name: 'interaction_respond', arguments: {
      ...input, expectedRevision: interaction.revision + 1,
    } })).isError).toBe(true)
    expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${writer.token}` },
      payload: { ...input, response: { unrequested: 'data' } } })).statusCode).toBe(400)
    expect(f.counts().responses).toBe(0)
    expect((await f.repository.get(interaction.id))?.revision).toBe(interaction.revision)

    const accepted = await client.callTool({ name: 'interaction_respond', arguments: input })
    expect(accepted.isError).not.toBe(true)
    const result = RespondToInteractionResponseSchema.parse(decodeMcpToolResult(accepted))
    expect(result.interaction).toMatchObject({ selectedOptionId: input.optionId,
      selectedSemantic: 'approve_once', status: 'delivered', deliveryState: 'delivered' })
    const readback = await client.callTool({ name: 'interaction_get', arguments: { interactionId: interaction.id } })
    expect(readback.isError).not.toBe(true)
    const persisted = await f.repository.get(interaction.id)
    expect(decodeMcpToolResult(readback)).toMatchObject({ interaction: persisted })
    const http = await app.inject({ method: 'GET', url: `/api/management/interactions/${interaction.id}`,
      headers: { authorization: `Bearer ${writer.token}` } })
    expect(http.statusCode).toBe(200)
    expect(http.json().interaction).toEqual(persisted)
    const audit = (await f.db.pool.query(`select source from management_audit
      where principal_id=$1 and action='interaction_respond' order by sequence`, [writer.principal.id])).rows
    expect(audit.some((row) => row.source === 'mcp')).toBe(true)
    expect(f.counts().responses).toBe(1)

    const restarted = new InteractionService(f.repository, new PostgresApprovalBudgetRepository(f.db.pool),
      f.native, (request) => f.engine.resumeInteraction(request))
    registerApprovalCheckpointResume(restarted, f.engine)
    await restarted.recover({ limit: 20 })
    const replayed = await new OperatorInteractionService(restarted).respond(writer.principal, input, 'mcp')
    expect(replayed.replayed).toBe(true)
    expect(replayed.interaction.nativeResponse).toEqual(persisted!.nativeResponse)
    expect(f.counts().responses).toBe(1)
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()))
    await app.close()
    await f.close()
  }
}, 60_000)
