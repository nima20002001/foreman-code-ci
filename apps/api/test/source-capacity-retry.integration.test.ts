import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { PostgresSourceReservations, type SourceReservation } from '../src/modules/sources/reservations.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { readUntil } from './helpers/observableCondition.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'

async function capacityFixture(pressure: 'preparations' | 'materializations' | 'retained_bytes' | 'disk') {
  const definition = makeCurrentWorkflowFixture(randomUUID())
  definition.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 8 }
  const affected = definition.version.definition.nodes[0]!.id
  const scopeId = randomUUID()
  const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture())
  const requestedBytes = 200 * 2 ** 20
  const f = await currentOperatorIntegration({ fixture: definition, approvalNodeIds: [],
    preparePlacementExecution: async (_owner, _run, execution) => {
      if (execution.workflowNodeId !== affected) return undefined
      const reservation = await withTransaction(f.db.pool, sql => reservations.reserve(sql, {
        scopeId, ownerKind: 'materialization', ownerId: execution.id, reservedBytes: requestedBytes,
      }))
      await withTransaction(f.db.pool, sql => reservations.retain(sql, reservation, 'retained'))
      return undefined
    } })
  const blockers: SourceReservation[] = []
  async function reserve(bytes: number, state: 'preparing' | 'owned' | 'retained') {
    const reservation = await withTransaction(f.db.pool, sql => reservations.reserve(sql, {
      scopeId, ownerKind: 'materialization', ownerId: randomUUID(), reservedBytes: bytes,
    }))
    if (state !== 'preparing') {
      await withTransaction(f.db.pool, sql => reservations.retain(sql, reservation, state))
    }
    return reservation
  }
  try {
    if (pressure === 'disk') await reserve(900 * 2 ** 20, 'retained')
    else if (pressure === 'retained_bytes') {
      await reserve(600 * 2 ** 20, 'retained')
      blockers.push(await reserve(350 * 2 ** 20, 'owned'))
    } else {
      const state = pressure === 'preparations' ? 'preparing' : 'owned'
      blockers.push(await reserve(4096, state), await reserve(4096, state))
    }
    const args = { workspaceId: f.f.scope.workspaceId, runId: f.f.run.id, detail: 'full' }
    const read = async () => SavedRunDetailsSchema.parse(decodeMcpToolResult(
      await f.client.callTool({ name: 'run_get', arguments: args })))
    return { ...f, affected, scopeId, read, async release() {
      for (const blocker of blockers) {
        await withTransaction(f.db.pool, sql => reservations.retain(sql, blocker, 'retained', 4096))
      }
    } }
  } catch (error) {
    await f.close()
    throw error
  }
}

it.each(['preparations', 'materializations', 'retained_bytes'] as const)(
  'retries $pressure after capacity releases and preserves diagnostics through authenticated MCP: %s', async pressure => {
    const f = await capacityFixture(pressure)
    const task = f.engine.start(f.f.run.id).then(() => undefined, (error: unknown) => error)
    try {
      const first = await readUntil(f.read, details => details.executions.some(execution =>
        execution.workflowNodeId === f.affected && execution.state === 'completed'),
      { timeoutMs: 15_000, description: 'the capacity failure' })
      const failure = first.executions.find(execution => execution.workflowNodeId === f.affected && execution.attempt === 1)!
      expect(failure).toMatchObject({ state: 'completed', result: { outcome: 'failed', error: {
        code: 'SOURCE_CAPACITY', retryable: true,
        details: { retryable: true, scopeId: f.scopeId, exhausted: expect.arrayContaining([pressure]),
          usage: { requestedBytes: 200 * 2 ** 20 }, limits: { bytes: 2 ** 30 },
          measured: { cpuCount: 1, availableMemoryBytes: 4 * 2 ** 30 } },
      } } })
      expect(failure.nativeSessionId).toBeUndefined()
      expect(first.run.executionState).toBe('running')
      expect(f.provider.startedExecutions).not.toContain(failure.id)
      await f.release()
      expect(await task).toBeUndefined()
      const finished = await f.read()
      expect(finished.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const attempts = finished.executions.filter(execution => execution.workflowNodeId === f.affected)
        .sort((a, b) => a.attempt - b.attempt)
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).toEqual(failure)
      expect(attempts[1]).toMatchObject({ attempt: 2, state: 'completed', result: { outcome: 'succeeded' } })
      expect(attempts[1]!.id).not.toBe(failure.id)
      expect(attempts[1]!.input).toEqual(failure.input)
      const denied = await f.access.issue({ name: 'Unrelated reader', audience: 'operator',
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['outside-workspace'] } }] })
      await expectMcpAccessDenied((await f.connect(denied.token)).callTool({ name: 'run_get', arguments: {
        workspaceId: f.f.scope.workspaceId, runId: f.f.run.id, detail: 'full',
      } }))
    } finally {
      await f.close()
      await task
    }
  }, 60_000,
)

it('persists a hard disk failure with its diagnostics and does not start another attempt', async () => {
  const f = await capacityFixture('disk')
  try {
    await f.engine.start(f.f.run.id)
    const finished = await f.read()
    const expected = { outcome: 'failed', error: { code: 'SOURCE_CAPACITY', retryable: false,
      details: { retryable: false, scopeId: f.scopeId, exhausted: ['retained_bytes'],
        usage: { usedBytes: 900 * 2 ** 20, requestedBytes: 200 * 2 ** 20 }, limits: { bytes: 2 ** 30 } } } }
    expect(finished.run).toMatchObject({ executionState: 'completed', outcome: 'failed', result: expected })
    expect(finished.executions).toHaveLength(1)
    expect(finished.executions[0]).toMatchObject({ attempt: 1, result: expected })
    expect(f.provider.startedExecutions).toEqual([])
  } finally {
    await f.close()
  }
}, 60_000)
