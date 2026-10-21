import { describe, expect, it } from 'vitest'
import { RunActivitiesPageSchema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

describe.skipIf(!postgresEnabled)('persisted public approval activity', () => {
  it.each(['uncertain', 'failed'] as const)(
    'preserves %s delivery, Agent ownership and later cancellation through HTTP/MCP', async (deliveryState) => {
      const f = await codexApprovalRuntime('user')
      const commands = new PostgresCommandCoordinator(f.db.pool)
      const runs = new RunManagementService(f.db.pool, commands, {} as never, {} as never, {} as never)
      const app = buildApp({
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access: f.access, services: { commands, runs } as never },
      })
      try {
        await f.engine.start(f.f.run.id)
        const [interaction] = await f.pending()
        if (!interaction) throw new Error('Expected the original native approval request')
        const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
        const reader = await f.access.issue({ name: 'Activity reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 600000),
          grants: [{ actions: ['runs:read'], scope: { runIds: [scope.runId] } }] })
        const denied = await f.access.issue({ name: 'Other Run reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 600000),
          grants: [{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }] })
        const url = `/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities?limit=100`
        async function read() {
          const http = await app.inject({ method: 'GET', url, headers: graphHeaders(reader.token) })
          expect(http.statusCode, http.body).toBe(200)
          const page = RunActivitiesPageSchema.parse(http.json())
          const mcp = await graphRpc(app, reader.token, 'tools/call', {
            name: 'run_activities_get_v1', arguments: { ...scope, limit: 100 },
          })
          expect(mcp.result?.isError).not.toBe(true)
          expect(RunActivitiesPageSchema.parse(graphRpcValue(mcp.result))).toEqual(page)
          return page
        }
        const requested = await read()
        const own = requested.items.filter(item => item.refs.interactionId === interaction.id)
        expect(own.length).toBeGreaterThan(0)
        const captured = (await f.db.pool.query<{ name: string }>(`
          select node->>'name' as name from run_board_snapshots s,
            jsonb_array_elements(s.record->'nodes') node
          where s.run_id=$1 and node->>'id'=$2`,
        [scope.runId, own[0]!.actor?.nodeId])).rows[0]!
        expect(own.every(item => item.actor && 'agentId' in item.actor
          && item.actor.agentId === interaction.requestingAgentId
          && item.actor.agentName === captured.name
          && item.refs.executionId === interaction.executionId)).toBe(true)
        expect(requested.items.filter(item => item.kind === 'run').every(item => !item.actor)).toBe(true)
        const choice = interaction.responseOptions.find(option => option.semantic === 'approve_once')!
        await f.repository.decide({ id: interaction.id, expectedRevision: interaction.revision,
          optionId: choice.optionId, principal: f.principal,
          nativeResponse: { optionId: choice.optionId, semantic: choice.semantic } })
        const claim = await f.repository.delivery.claim(interaction.id, 'activity-delivery')
        if (!claim) throw new Error('Expected a qualified delivery claim')
        const outcome = { state: 'failed' as const, error: 'Recorded transport failure' }
        const settled = deliveryState === 'uncertain'
          ? await f.repository.delivery.finish(claim, async () => outcome)
          : await f.repository.delivery.finish(claim, outcome)
        expect(settled.deliveryState).toBe(deliveryState)
        expect((await f.repository.get(interaction.id))?.deliveryState).toBe(deliveryState)
        const delivered = await read()
        const original = delivered.items.filter(item => item.refs.interactionId === interaction.id).at(-1)!
        expect(original).toMatchObject({ status: deliveryState === 'uncertain' ? 'unknown' : 'delivery_failed',
          severity: deliveryState === 'uncertain' ? 'warning' : 'error',
          summary: deliveryState === 'uncertain' ? 'Approval delivery uncertain' : 'Approval delivery failed' })
        await f.stop()
        await f.repository.cancelPendingForRun(scope.runId)
        const canceled = await read()
        expect(canceled.items).toContainEqual(original)
        expect(canceled.items.filter(item => item.refs.interactionId === interaction.id).at(-1))
          .toMatchObject({ status: 'canceled', summary: 'Approval canceled',
            actor: { agentId: interaction.requestingAgentId }, refs: { executionId: interaction.executionId } })
        expect(await f.repository.get(interaction.id)).toMatchObject({ status: 'canceled', deliveryState })
        const deniedHttp = await app.inject({ method: 'GET', url, headers: graphHeaders(denied.token) })
        expect(deniedHttp.statusCode).toBe(403)
        const deniedMcp = await graphRpc(app, denied.token, 'tools/call', {
          name: 'run_activities_get_v1', arguments: scope,
        })
        expect(deniedMcp.error || deniedMcp.result?.isError).toBeTruthy()
        expect(JSON.stringify(deniedMcp)).not.toContain(interaction.executionId)
      } finally {
        await app.close()
        await f.close()
      }
    }, 120000,
  )
})
