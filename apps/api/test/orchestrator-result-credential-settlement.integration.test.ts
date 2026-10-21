import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('designated Orchestrator credential across marked result settlement', () => {
  it('keeps the original process credential through a terminal credential sweep until the original turn settles', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'approval')
    fixture.run.resultProtocol = COORDINATION_RESULT_PROTOCOL
    const orchestrator = fixture.configurations[0]!.agentId
    let f: Awaited<ReturnType<typeof checkpointRuntimeFixture>> | undefined
    let sweep: Wave25WorkerCredentialService | undefined
    const observed: { before: boolean; after: boolean }[] = []
    // Runs after each committed native publication, i.e. between the marked
    // terminal's COMMIT and the settlement that retains its original process.
    const nativeCommitted = async () => {
      if (!f || observed.length) return
      const live = async () => (await f!.db.pool.query<{ live: boolean }>(`select b.revoked_at is null
        and p.revoked_at is null as live from worker_credential_bindings b
        join management_principals p on p.id=b.principal_id
        join workflow_coordination_terminals t on t.execution_id=b.execution_id and t.settled_native_proof_id is null
        where b.run_id=$1 and b.agent_id=$2 and b.purpose='workflow'`, [fixture.run.id, orchestrator])).rows[0]?.live
      const before = await live()
      if (before === undefined) return
      sweep ??= new Wave25WorkerCredentialService(f.db.pool, new PostgresAccessService(f.db.pool))
      await sweep.reconcileTerminalCredentials()
      observed.push({ before, after: (await live())! })
    }
    f = await checkpointRuntimeFixture(1, 1, { fixture, approvalNodeIds: [], collaborationPorts: {}, nativeCommitted,
      outputFor: node => ({ data: { answer: `Completed ${node}` }, summary: 'Completed the task.',
        board: { kind: 'none', reason: 'no_access' } }) })
    try {
      await f.engine.start(f.f.run.id)
      expect(observed).toEqual([{ before: true, after: true }])
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    } finally { await f.close() }
  }, 90_000)
})
