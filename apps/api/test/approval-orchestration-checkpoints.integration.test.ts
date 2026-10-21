import { approvalOrchestrationDatabase } from './helpers/approvalOrchestrationDatabase.js'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('current durable approval orchestration', () => {
  describe('checkpoint responses', () => {
    const getDatabase = approvalOrchestrationDatabase()

    it('resumes the exact interrupted execution, rejects forged options and replays without repeating native effects', async () => {
      const f = await checkpointRuntimeFixture(1, 1, { database: getDatabase() })
      const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } } })
      try {
        await f.engine.start(f.f.run.id)
        const [pending] = await f.pending()
        const executions = (await f.db.pool.query('select record from harness_executions where run_id=$1 order by id', [f.f.run.id])).rows.map((row) => HarnessExecutionSchema.parse(row.record))
        expect(executions).toHaveLength(2)
        expect(executions.find((execution) => execution.id === pending!.executionId)?.nativeSessionId)
          .toBe(pending!.nativeSessionId)
        expect(f.provider.counts).toMatchObject({ starts: 2, sessions: 2, responses: 0 })
        expect((await app.inject({ method: 'GET', url: '/api/interactions?limit=10' })).statusCode).toBe(404)
        expect((await app.inject({ method: 'POST', url: `/api/interactions/${pending!.id}/respond`, payload: approvalResponse(pending!) })).statusCode).toBe(404)
        await expect(f.service.respond({ kind: 'user', principal: f.principal }, { ...approvalResponse(pending!), optionId: 'forged' }))
          .rejects.toMatchObject({ code: 'INTERACTION_OPTION_INVALID' })
        expect((await f.runs.get(f.f.run.id))?.executionState).toBe('waiting')
        const response = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending!))
        expect(response.interaction.deliveryState).toBe('delivered')
        expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
        expect(((await f.db.pool.query('select record from harness_executions where run_id=$1 order by id', [f.f.run.id])).rows.map((row) => HarnessExecutionSchema.parse(row.record))).map((e) => [e.id, e.nativeSessionId]))
          .toEqual(executions.map((e) => [e.id, e.nativeSessionId]))
        expect((await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending!))).replayed).toBe(true)
        expect(f.provider.counts).toMatchObject({ starts: 2, sessions: 2, responses: 1 })
      } finally { await app.close(); await f.close() }
    }, 60000)

    it('targets two parallel interrupt IDs without respawning either branch or its predecessor', async () => {
      const f = await checkpointRuntimeFixture(2, 1, { database: getDatabase() })
      try {
        await f.engine.start(f.f.run.id)
        const pending = await f.pending()
        expect(pending).toHaveLength(2)
        expect(new Set(pending.map((i) => i.graphInterruptId)).size).toBe(2)
        await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending[0]!))
        expect((await f.runs.get(f.f.run.id))?.outcome).toBe('pending')
        expect(await f.repository.get(pending[1]!.id)).toMatchObject({ status: 'pending', deliveryState: 'not_started' })
        await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending[1]!))
        expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
        expect(f.provider.counts).toMatchObject({ starts: 3, sessions: 3, responses: 2 })
        expect(await f.receipts()).toHaveLength(2)
      } finally { await f.close() }
    }, 60000)
  })
})
