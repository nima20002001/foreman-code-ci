import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { RespondToInteractionResponseSchema, type InteractionResponseValue } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { registerApprovalCheckpointResume } from '../src/modules/runs/approvalCheckpointRegistration.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { codexWorkflowRuntime } from './helpers/codexWorkflowRuntime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { calls, until } from './fixtures/codex-test-helpers.js'

describe.skipIf(!postgresEnabled)('Codex workflow input delivery through authenticated MCP', () => {
  it.each(['questions', 'form'] as const)('delivers %s, recovers a lost database commit, and continues the checkpoint', async kind => {
    const f = await codexWorkflowRuntime(kind)
    const clients: Client[] = []
    const services = { commands: new PostgresCommandCoordinator(f.db.pool),
      interactions: new OperatorInteractionService(f.service) } as unknown as OperatorServices
    const workflows = new PostgresWorkflowRepository(f.db.pool)
    const app = buildApp({ product: {
      workspaces: new PostgresWorkspaceRepository(f.db.pool, workflows, f.runs),
      workflows, runs: f.runs,
      engine: f.engine, interactions: f.service,
    }, readiness: { database: { ping: async () => undefined },
      checkpoints: { ping: async () => undefined } }, operator: { access: f.access, services } })
    try {
      await f.engine.start(f.f.run.id)
      const interaction = await until(async () => (await f.pending())[0])
      expect(interaction.harness).toBe('codex')
      const origin = await app.listen({ host: '127.0.0.1', port: 0 })
      const issue = (actions: Array<'interactions:read' | 'interactions:respond'>) => f.access.issue({
        name: 'Workflow input caller', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions, scope: { runIds: [f.f.run.id] } }],
      })
      const writer = await issue(['interactions:read', 'interactions:respond'])
      const reader = await issue(['interactions:read'])
      const connect = async (token: string) => {
        const client = new Client({ name: 'codex-workflow-input', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      const client = await connect(writer.token)
      const readonly = await connect(reader.token)
      const response: InteractionResponseValue = kind === 'questions'
        ? { answer: { answers: ['Entered answer'] } } : { count: 2 }
      const input = { interactionId: interaction.id, expectedRevision: interaction.revision,
        optionId: interaction.responseOptions[0]!.optionId, response }
      expect((await readonly.callTool({ name: 'interaction_respond', arguments: input })).isError).toBe(true)
      const url = `/api/management/interactions/${interaction.id}/respond`
      expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${reader.token}` },
        payload: input })).statusCode).toBe(403)
      expect((await client.callTool({ name: 'interaction_respond', arguments: { ...input, response: {} } })).isError)
        .toBe(true)
      const responses = async () => (await calls(f.provider.directory)).filter(entry => {
        const wire = entry.wire as { id?: number; result?: unknown } | undefined
        return wire?.id === 901 && wire.result
      })
      expect(await responses()).toHaveLength(0)
      await f.db.pool.query(`create function fail_input_delivery() returns trigger language plpgsql as $$
        begin
          if new.record->>'deliveryState'='delivered' then raise exception 'lost delivery commit'; end if;
          return new;
        end $$`)
      await f.db.pool.query(`create trigger fail_input_delivery before update on durable_interactions
        for each row execute function fail_input_delivery()`)
      const first = await client.callTool({ name: 'interaction_respond', arguments: input })
      if (!first.isError) {
        expect(RespondToInteractionResponseSchema.parse(decodeMcpToolResult(first)).interaction.deliveryState)
          .not.toBe('delivered')
      }
      const option = { ...interaction.responseOptions[0]!, response }
      const session = { harness: interaction.harness, providerVersion: interaction.providerVersion,
        nativeSessionId: interaction.nativeSessionId }
      const journalEvidence = await until(async () => f.journal.read(session, {
        nativeRequestId: interaction.nativeRequestId, nativeRequestType: interaction.nativeRequestType, option,
      }))
      expect(journalEvidence).toMatchObject({ source: 'provider_history', optionId: option.optionId })
      expect(journalEvidence.responseDigest).toMatch(/^[a-f0-9]{64}$/)
      await f.db.pool.query('drop trigger fail_input_delivery on durable_interactions')
      const restarted = new InteractionService(f.repository, new PostgresApprovalBudgetRepository(f.db.pool),
        f.native, request => f.engine.resumeInteraction(request), f.journal)
      registerApprovalCheckpointResume(restarted, f.engine)
      services.interactions = new OperatorInteractionService(restarted)
      await restarted.recover({ limit: 20 })
      expect((await f.repository.get(interaction.id))?.deliveryState).toBe('submitted')
      expect(await responses()).toHaveLength(1)
      // Model elapsed ownership for the same failed attempt at both persisted lease boundaries.
      await f.db.pool.query(`with expired as (
        update interaction_delivery_attempts set lease_expires_at=clock_timestamp()-interval '1 second'
        where interaction_id=$1 returning interaction_id,lease_owner
      ) update durable_interactions d set delivery_lease_expires_at=clock_timestamp()-interval '1 second'
        where d.id=$1 and exists (select 1 from expired a
          where a.interaction_id=d.id and a.lease_owner=d.delivery_token)`, [interaction.id])
      await restarted.recover({ limit: 20 })
      const replay = await client.callTool({ name: 'interaction_respond', arguments: input })
      expect(replay.isError).not.toBe(true)
      const delivered = RespondToInteractionResponseSchema.parse(decodeMcpToolResult(replay)).interaction
      expect(delivered).toMatchObject({ deliveryState: 'delivered', nativeResponse: { response } })
      const persisted = await f.repository.get(interaction.id)
      expect(decodeMcpToolResult((await client.callTool({ name: 'interaction_get', arguments: { interactionId: interaction.id } })))).toMatchObject({ interaction: persisted })
      expect(await responses()).toHaveLength(1)
      await until(async () => (await f.runs.get(f.f.run.id))?.outcome === 'succeeded')
      expect(await f.receipts()).toHaveLength(1)
      expect(await f.provider.wire('turn/start')).toHaveLength(1)
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
      await f.close()
    }
  }, 60_000)
})
