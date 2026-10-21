import { describe, expect, it } from 'vitest'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { approvalWithActiveSibling, installApprovalCleanup } from './helpers/approvalInterruptPublication.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'

installApprovalCleanup()

describe.skipIf(!postgresEnabled)('approval interrupt publication consumption', () => {
  it('binds and consumes the persisted approval while a sibling remains active through authenticated MCP', async () => {
    const { f, operator, run, interaction, sibling, release } = await approvalWithActiveSibling()
    let responseTask: Promise<unknown> | undefined
    try {
      const user = await operator.access.issue({ name: 'Native approval User', audience: 'user',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { runIds: [run.id] } }] })
      await expect(f.service.respond({ kind: 'user', principal: operator.reader.principal },
        approvalResponse(interaction))).rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
      expect((await f.repository.get(interaction.id))?.status).toBe('pending')
      let responded = false
      let responseError: unknown
      responseTask = f.service.respond({ kind: 'user', principal: user.principal }, approvalResponse(interaction))
        .catch((error: unknown) => { responseError = error }).finally(() => { responded = true })
      await expect.poll(() => responded, { timeout: 5_000 }).toBe(true)
      expect(responseError).toBeUndefined()
      expect((await f.repository.get(interaction.id))?.deliveryState).toBe('delivered')
      expect((await f.runs.getExecution(sibling.id))?.state).toBe('running')
      const resumed = await f.db.pool.query<{ state: string }>(
        'select state from interaction_graph_resumes where interaction_id=$1', [interaction.id])
      expect(resumed.rows[0]?.state).toBe('resumed')
      const wait = await graphRpc(operator.app, operator.reader.token, 'tools/call', {
        name: 'run_get', arguments: { workspaceId: run.workspaceId, runId: run.id },
      })
      expect(graphRpcValue(wait.result)).toMatchObject({ run: { id: run.id, executionState: 'waiting' } })
      release.resolve()
      await f.engine.start(run.id)
      const finished = await graphRpc(operator.app, operator.reader.token, 'tools/call', {
        name: 'run_get', arguments: { workspaceId: run.workspaceId, runId: run.id },
      })
      expect(graphRpcValue(finished.result)).toMatchObject({ run: { id: run.id, outcome: 'succeeded' } })
      expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 1, attaches: 0 })
      expect(await f.runs.hasPendingCleanup(run.id)).toBe(false)
      await (await graphParity(f.db.pool, { ...f.f.scope, runId: run.id })).compare()
      await f.service.respond({ kind: 'user', principal: user.principal }, approvalResponse(interaction))
      expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 1, attaches: 0 })
      expect(operator.dispatchErrors).toEqual([])
    } finally {
      release.resolve()
      await responseTask
    }
  }, 60_000)
})
