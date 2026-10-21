import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CurrentWorkflowSaveResultSchema, RunStartV3ResultSchema, SavedRunDetailsSchema,
  SavedManagedWorkflowCommandResultSchema } from '@foreman-code/contracts/wave25'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { SourceReservation } from '../src/modules/sources/reservations.js'
import { closeCompletedWorkflowSources } from '../src/modules/sources/workflowCleanup.js'
import { measureRetainedMaterializationFootprint } from '../src/modules/sources/retainedDirectoryUsage.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { sourceWorktreeMcpFixture } from './helpers/sourceWorktreeMcpFixture.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { readUntil } from './helpers/observableCondition.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

afterEach(() => vi.restoreAllMocks())

async function retainedFixture() {
  const f = await sourceWorktreeMcpFixture({ approvalNodeIds: [] })
  try {
    vi.spyOn(f.production.executions, 'storageCapacity').mockImplementation(async () =>
      sourceStorageCapacityFixture({ filesystem: f.root.binding.filesystem, cpuCount: 4 }))
    const read = async (runId: string) => SavedRunDetailsSchema.parse(decodeMcpToolResult(
      await f.client.callTool({ name: 'run_get', arguments: {
        workspaceId: f.input.workspaceId, runId, detail: 'full',
      } })))
    const start = async (input = f.input) => {
      const reply = await f.client.callTool({ name: 'run_start', arguments: { ...input, commandId: randomUUID() } })
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
      return RunStartV3ResultSchema.parse(decodeMcpToolResult(reply)).run.id
    }
    const firstRunId = await start()
    const first = await readUntil(() => read(firstRunId), value => value.run.executionState === 'completed' && !value.cleanupPending,
      { timeoutMs: 30_000, description: 'the first completed Run' })
    expect(first.run.outcome).toBe('succeeded')
    await closeCompletedWorkflowSources(f.base.db.pool, f.production.sources, error => { throw error })
    const rows = (await f.base.db.pool.query<{ record: SourceMaterializationRecord; reservation: SourceReservation;
      scope_id: string; state: string }>(`select m.record,s.record as reservation,s.scope_id,s.state
      from source_execution_materializations m join source_storage_reservations s using(reservation_id)
      join harness_executions e on e.id=m.execution_id where e.run_id=$1
      order by m.record#>>'{receipt,verifiedAt}',m.materialization_id`, [firstRunId])).rows
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.state === 'retained')).toBe(true)
    const oldest = rows[0]!
    const total = (await f.base.db.pool.query<{ bytes: string }>(`select sum(reserved_bytes) as bytes
      from source_storage_reservations where scope_id=$1 and state<>'reclaimed'`, [oldest.scope_id])).rows[0]!
    const bytes = 2 ** 30 - Number(total.bytes) - Math.floor(oldest.reservation.reservedBytes / 2)
    const retainedPath = join(oldest.record.receipt.binding.canonicalPath,
      oldest.record.receipt.materializationId, 'retained-copy.bin')
    const file = await open(retainedPath, 'wx', 0o600)
    try { await file.truncate(bytes) } finally { await file.close() }
    const footprint = await measureRetainedMaterializationFootprint(oldest.record.receipt)
    await withTransaction(f.base.db.pool, sql => f.production.sources.reservations.retainMaterialization(sql,
      oldest.reservation, { ...footprint, retainedBytes: footprint.retainedBytes + 16 * 1024 }))
    const startAnotherWorkflow = async () => {
      const created = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workflow_create', arguments: { workspaceId: f.input.workspaceId, commandId: randomUUID(),
          name: 'Another workflow on the same source volume' },
      }))).value
      const graph = { ...f.saved.version.definition, id: created.workflow.id,
        version: created.workflow.version, createdAt: created.workflow.createdAt, updatedAt: created.workflow.updatedAt }
      const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(await f.client.callTool({
        name: 'workflow_save_v3', arguments: { workspaceId: f.input.workspaceId, workflowId: created.workflow.id,
          commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: created.revision,
          expectedWorkflowVersionId: null, expectedAgentConfigurationVersionIds: f.input.expectedAgentConfigurationVersionIds,
          graph },
      }))).value
      return start({ ...f.input, workflowId: created.workflow.id, workflowVersionId: saved.currentVersionId,
        expectedWorkflowRevision: saved.revision })
    }
    return { ...f, first, oldest, retainedPath, read, startAnotherWorkflow }
  } catch (error) {
    await f.close()
    throw error
  }
}

it('reclaims the oldest closed copy under byte pressure, admits the next Run and preserves MCP history', async () => {
  const f = await retainedFixture()
  try {
    const runId = await f.startAnotherWorkflow()
    const finished = await readUntil(() => f.read(runId), value => value.run.executionState === 'completed',
      { timeoutMs: 30_000, description: 'the next Run under retained byte pressure' })
    expect(finished.run, JSON.stringify(finished.executions.map(execution => execution.result)))
      .toMatchObject({ outcome: 'succeeded' })
    await expect(stat(f.retainedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.base.db.pool.query('select state from source_storage_reservations where reservation_id=$1',
      [f.oldest.reservation.reservationId])).rows).toEqual([{ state: 'reclaimed' }])
    expect((await f.read(f.first.run.id)).executions).toEqual(f.first.executions)
    const audits = await f.base.db.pool.query(`select details from management_audit
      where action='source.materialization.reservation.release' and details->>'reservationId'=$1`,
    [f.oldest.reservation.reservationId])
    expect(audits.rows).toHaveLength(1)
    expect(audits.rows[0]!.details).toMatchObject({ scopeId: f.oldest.scope_id, reason: 'capacity' })
    const denied = await f.base.access.issue({ name: 'Unrelated reader', audience: 'operator',
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['outside-workspace'] } }] })
    await expectMcpAccessDenied((await f.connect(denied.token)).callTool({ name: 'run_get', arguments: {
      workspaceId: f.input.workspaceId, runId: f.first.run.id, detail: 'full',
    } }))
  } finally { await f.close() }
}, 90_000)

it('keeps pending Run cleanup pinned and reports hard capacity with persisted diagnostics', async () => {
  const f = await retainedFixture()
  try {
    await f.base.db.pool.query('update run_cleanup_intents set pending=true where run_id=$1', [f.first.run.id])
    const runId = await f.startAnotherWorkflow()
    const finished = await readUntil(() => f.read(runId), value => value.run.executionState === 'completed',
      { timeoutMs: 30_000, description: 'the pinned retained capacity rejection' })
    expect(finished.run).toMatchObject({ outcome: 'failed', result: { error: { code: 'SOURCE_CAPACITY',
      retryable: false, details: { exhausted: ['retained_bytes'], scopeId: f.oldest.scope_id } } } })
    expect(await stat(f.retainedPath)).toBeDefined()
    expect((await f.base.db.pool.query('select state from source_storage_reservations where reservation_id=$1',
      [f.oldest.reservation.reservationId])).rows).toEqual([{ state: 'retained' }])
  } finally { await f.close() }
}, 90_000)
