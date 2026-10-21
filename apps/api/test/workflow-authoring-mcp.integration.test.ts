import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { graphFixture, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

it('reads persisted workflow versions, rejects corrupt hashes and rechecks live read authority', async () => {
  const db = await currentDatabase()
  const f = await graphFixture(db, { insert: false })
  try {
    const input = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId }
    const read = (workflowVersionId?: string) => graphRpc(f.app, f.writer.token, 'tools/call', {
      name: CURRENT_WORKFLOW_TOOLS.saved, arguments: { ...input, ...(workflowVersionId ? { workflowVersionId } : {}) },
    })
    const result = CurrentWorkflowReadResultSchema.parse(graphRpcValue((await read()).result))
    const persisted = (await db.pool.query('select revision from workflows where id=$1', [f.scope.workflowId])).rows[0]!
    expect(result).toEqual({ ...input, revision: Number(persisted.revision), currentVersionId: f.version.id, version: f.version })
    expect(result.version.definition.repeat).toEqual(f.version.definition.repeat)
    const corruptVersion = WorkflowVersionV3Schema.parse({ ...f.version, id: randomUUID(), version: f.version.version + 1,
      definition: { ...f.version.definition, version: f.version.version + 1 },
      contentHash: `sha256:${'f'.repeat(64)}` })
    await db.pool.query(`insert into workflow_versions
      (id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record)
      values($1,$2,$3,$4,$5,3,$6)`, [corruptVersion.id, f.scope.workspaceId, f.scope.workflowId,
      corruptVersion.version, corruptVersion.entryNodeId, corruptVersion])
    const corrupt = await read(corruptVersion.id)
    expect(corrupt.result?.isError).toBe(true)
    expect(graphRpcValue(corrupt.result)).toMatchObject({ error: { code: 'WORKFLOW_VERSION_HASH_MISMATCH' } })
    expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue((await read()).result)).version).toEqual(f.version)
    await db.pool.query('update management_principals set grants=$2 where id=$1', [f.writer.principal.id, JSON.stringify([])])
    // The caller still holds its original principal, so this challenges the service's live authority check.
    await expect(f.workflows.current.read(f.writer.principal, input))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect((await read()).result?.isError).toBe(true)
  } finally {
    await f.app.close()
    await db.close()
  }
})
