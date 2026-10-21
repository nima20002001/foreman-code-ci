import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { agent3Database, candidateFor, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

// Regression for CURRENT_TYPED_WRITER_REQUIRED: fixture setup must use the same
// authenticated typed Save service as /definition, not a direct version update.
describe.skipIf(!postgresEnabled)('Current Agent3 fixture publication', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => { await db?.close() })
  it.each([false, true])('saves through the current writer, with Run=%s', async (run) => {
    const f = await seedAgent3(db.pool, db.directory, undefined, { run })
    const saved = (await db.pool.query<{ current_version_id: string; record: unknown }>(
      `select w.current_version_id,v.record from workflows w join workflow_versions v on v.id=w.current_version_id
       where w.id=$1 and w.workspace_id=$2`, [f.scope.workflowId, f.scope.workspaceId])).rows[0]!
    expect(saved.current_version_id).toBe(f.version.id)
    expect(saved.record).toEqual(f.version)
    expect(f.run.workflowId).toBe(f.scope.workflowId)
    expect(f.run.workflowVersionId).toBe(f.version.id)
    const journal = await db.pool.query(`select 1 from management_command_receipts
      where operation='workflow.save.v3' and target_key=$1`, [`workflow:${f.scope.workflowId}:definition`])
    expect(journal.rowCount).toBe(1)
    const head = await db.pool.query('select run_id from run_graph_heads where run_id=$1', [f.run.id])
    expect(head.rowCount).toBe(run ? 1 : 0)
  })
  it('admits an ordinary node through the real current repository and accepted root authority', async () => {
    const t = await currentRepositoryFixture(db)
    const owner = await t.repository.acquireOwnership(t.f.run.id, () => undefined)
    expect(owner).toBeDefined()
    try {
      const store = await t.repository.repeat(owner!)
      const admitted = await store.admit({ nodeId: t.f.version.entryNodeId, occurrence: null }, () => candidateFor(t.f))
      expect(admitted).toMatchObject({ kind: 'admitted', reused: false, execution: { state: 'queued' } })
      const rows = await t.repository.listRepeatExecutions(t.f.run.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.ref.occurrence).toBeNull()
      expect(rows[0]!.execution).not.toHaveProperty('nativeSessionId')
      expect(rows[0]!.execution).not.toHaveProperty('runtimeDirectory')
    } finally { await owner?.release() }
  })

})
