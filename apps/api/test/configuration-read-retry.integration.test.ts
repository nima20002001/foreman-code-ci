import { createTestPool } from './helpers/testPool.mjs'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { withClientTransaction } from '../src/infrastructure/transaction.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('configuration reads before native launch', () => {
  it.each(['acquisition', 'statement'] as const)('retries a %s timeout under the same execution and saved configuration', async fault => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    const reads = createTestPool({ connectionString: f.db.pool.options.connectionString, max: 1,
      connectionTimeoutMillis: 10_000,
      options: `-c search_path=${f.db.schema} -c statement_timeout=10000` })
    const workflows = new PostgresWorkflowRepository(reads)
    const pinned: string[] = []
    let executionId: string | undefined
    let failures = 0
    let held: pg.PoolClient | undefined
    let lock: pg.PoolClient | undefined
    let releaseLock: (() => void) | undefined
    let locking: Promise<void> | undefined
    const acquireLock = async () => {
      const client = lock
      if (!client || locking) return
      let locked: (() => void) | undefined
      const ready = new Promise<void>(resolve => { locked = resolve })
      const release = new Promise<void>(resolve => { releaseLock = resolve })
      locking = withClientTransaction(client, async () => {
        await client.query('lock table agent_configuration_versions in access exclusive mode')
        locked!()
        await release
      })
      await ready
    }
    vi.spyOn(f.workflows, 'getAgentConfiguration').mockImplementation(async id => {
      pinned.push(id)
      await acquireLock()
      const executions = (await f.db.pool.query<{ id: string }>(
        'select id from harness_executions where run_id=$1 order by created_at', [f.f.run.id])).rows
      executionId ??= executions[0]?.id
      expect(executions[0]?.id).toBe(executionId)
      try { return await workflows.getAgentConfiguration(id) }
      catch (error) {
        failures++
        held?.release()
        held = undefined
        releaseLock?.()
        await locking
        // Keep the short statement deadline confined to the deliberately blocked read.
        if (fault === 'statement') await reads.query('set statement_timeout = 10000')
        if (fault === 'acquisition') {
          expect(error).toMatchObject({ message: 'timeout exceeded when trying to connect' })
        } else {
          expect(error).toMatchObject({ code: '57014' })
        }
        expect(f.provider.counts.sessions).toBe(0)
        expect(f.provider.counts.starts).toBe(0)
        throw error
      }
    })
    try {
      const configuration = f.f.configurations[0]!
      expect(await workflows.getAgentConfiguration(configuration.id)).toEqual(configuration)
      if (fault === 'acquisition') {
        // Exhaust a warm pool so the failure comes from queuing, not connection setup.
        held = await reads.connect()
      } else {
        lock = await f.db.pool.connect()
        await reads.query('set statement_timeout = 50')
      }
      await f.engine.start(f.f.run.id)
      expect(failures).toBe(1)
      expect(pinned[0]).toBe(pinned[1])
      expect(f.provider.startedExecutions.filter(id => id === executionId)).toHaveLength(1)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
      expect(decodeMcpToolResult(await f.client.callTool({ name: 'run_get', arguments: scope })))
        .toMatchObject({ run: { outcome: 'succeeded' } })
      const details = decodeMcpToolResult(await f.client.callTool({
        name: 'run_get', arguments: { ...scope, detail: 'full' },
      }))
      expect(details).toMatchObject({ executions: expect.arrayContaining([
        expect.objectContaining({ id: executionId, agentConfigurationVersionId: pinned[0],
          attempt: 1, state: 'completed', result: expect.objectContaining({ outcome: 'succeeded' }) }),
      ]) })
      const denied = await f.access.issue({ name: 'Unrelated reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000),
        grants: [{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }] })
      await expectMcpAccessDenied((await f.connect(denied.token)).callTool({ name: 'run_get', arguments: scope }))
      const failure = await f.db.pool.query(`select 1 from run_cleanup_intents
        where run_id=$1 and failure_result->'error'->>'code'='EXECUTION_START_INTERRUPTED'`, [f.f.run.id])
      expect(failure.rowCount).toBe(0)
    } finally {
      held?.release()
      releaseLock?.()
      await locking
      lock?.release()
      await reads.end()
      await f.close()
    }
  }, 60_000)

  it('retries an uncertain native creation in a fresh attempt and completes the Run', async () => {
    const f = await currentOperatorIntegration({ approvalNodeIds: [] })
    const create = f.provider.createSession.bind(f.provider)
    let uncertain = true
    vi.spyOn(f.provider, 'createSession').mockImplementation(async input => {
      const session = await create(input)
      if (!uncertain) return session
      uncertain = false
      throw new Error('Connection terminated due to connection timeout')
    })
    try {
      await f.engine.start(f.f.run.id)
      const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
      const details = decodeMcpToolResult(await f.client.callTool({
        name: 'run_get', arguments: { ...scope, detail: 'full' },
      })) as { run: { outcome: string }; executions: Array<{ workflowNodeId: string; attempt: number; result?: unknown }> }
      expect(details.run.outcome).toBe('succeeded')
      const entry = details.executions.filter(item => item.workflowNodeId === f.f.version.entryNodeId)
        .sort((a, b) => a.attempt - b.attempt)
      expect(entry.map(item => item.attempt)).toEqual([1, 2])
      expect(entry[0]!.result).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_START_INTERRUPTED', retryable: true } })
      expect(entry[1]!.result).toMatchObject({ outcome: 'succeeded' })
      const cleanup = await f.db.pool.query('select 1 from run_cleanup_intents where run_id=$1 and failure_result is not null',
        [f.f.run.id])
      expect(cleanup.rowCount).toBe(0)
    } finally {
      await f.close()
    }
  }, 60_000)

})
