import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { sharedFixture } from './eng04-shared-fixture.js'
import { ExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import {
  readAcceptedRepeatRunSnapshot, readRecordedRepeatRunSnapshot, type AcceptedRepeatRunSnapshot,
} from '../src/modules/runs/repeatStartRead.js'

function fixture() {
  const source = sharedFixture()
  const row = {
    id: source.run.id,
    workspace_id: source.run.workspaceId,
    workflow_id: source.run.workflowId,
    workflow_version_id: source.run.workflowVersionId,
    execution_state: source.run.executionState,
    runner_id: source.location.runnerId,
    working_directory: source.location.rootPath,
    location_revision: String(source.location.locationRevision),
    record: source.run,
    stopped: false,
    cleanup_pending: false,
  }
  async function read(reader: (sql: GraphTransactionSql, runId: string) => Promise<AcceptedRepeatRunSnapshot>) {
    const empty = { rows: [], rowCount: 0 }
    const query = vi.fn()
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ versions: [source.versionRow], configurations: source.configurations }],
        rowCount: 1,
      })
      .mockResolvedValue(empty)
    const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
    try {
      return await connection.transaction(sql => reader(sql, source.run.id))
    } finally {
      await connection.close()
    }
  }
  return { ...source, row, read }
}

describe('persisted Run snapshot reads', () => {
  it('returns saved records and current lifecycle flags on repeated reads', async () => {
    const source = fixture()
    const first = await source.read(readAcceptedRepeatRunSnapshot)
    expect(first).toEqual({
      run: source.run,
      version: source.version,
      configurations: source.f.configurations,
      stopRequested: false,
      cleanupPending: false,
    })
    first.version.definition.name = 'Changed by a caller'
    source.row.stopped = true
    source.row.cleanup_pending = true
    expect(await source.read(readAcceptedRepeatRunSnapshot)).toEqual({
      run: source.run,
      version: source.version,
      configurations: source.f.configurations,
      stopRequested: true,
      cleanupPending: true,
    })
  })

  it('rechecks Run physical columns and Run-to-Version pins after a successful read', async () => {
    const source = fixture()
    await source.read(readAcceptedRepeatRunSnapshot)
    source.row.location_revision = '99'
    await expect(source.read(readAcceptedRepeatRunSnapshot)).rejects.toMatchObject({ code: 'RUN_PIN_CONFLICT' })
    source.row.location_revision = String(source.location.locationRevision)
    source.row.record.agentConfigurationVersionIds = {}
    await expect(source.read(readAcceptedRepeatRunSnapshot)).rejects.toThrow('RUN_VERSION_SNAPSHOT_PIN_MISMATCH')
  })

  it('retains executable configuration checks while recorded reads preserve saved history', async () => {
    const source = fixture()
    await source.read(readAcceptedRepeatRunSnapshot)
    source.configurations[1]!.record.productRole = 'orchestrator'
    await expect(source.read(readAcceptedRepeatRunSnapshot))
      .rejects.toThrow('entry must use the pinned Orchestrator role')
    const recorded = await source.read(readRecordedRepeatRunSnapshot)
    expect(recorded.configurations[1]!.productRole).toBe('orchestrator')
    expect(recorded.version).toEqual(source.version)
  })
})
