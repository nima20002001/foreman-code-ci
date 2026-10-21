import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { approvalFixture } from './helpers/wave25ApprovalFixture.js'

// Legacy approval inference/materialization is retired. Current protection uses
// the typed complete-definition writer and preserves accepted immutable facts.
describe.skipIf(!postgresEnabled)('Current persisted approval writer protection', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => { await db?.close() })
  async function setup() {
    const f = makeCurrentWorkflowFixture(randomUUID(), 'approval')
    const native = approvalFixture().configurations
    f.configurations.forEach((config, index) => { config.harness = structuredClone(native[index]!.harness) })
    await seedAgent3(db.pool, db.directory, f, { run: false })
    const writer = await new PostgresAccessService(db.pool).issue({ name: 'Approval definition author', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ManagementActionSchema.options,
        scope: { workspaceIds: [f.scope.workspaceId] } }] })
    const workflows = new WorkflowManagementService(db.pool, new PostgresCommandCoordinator(db.pool))
    const managed = await workflows.get(writer.principal, f.scope.workspaceId, f.scope.workflowId)
    const save = (graph: typeof f.version.definition) => workflows.current.save(writer.principal, 'http', {
      workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
      expectedRevision: managed.revision, expectedWorkflowVersionId: f.version.id,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds, graph,
    })
    const read = async () => (await db.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])).rows[0]!.record
    return { f, save, read }
  }
  it('rejects a raw writer dropping current semantics or relationship kinds', async () => {
    const { f, read } = await setup(), before = await read()
    await expect(db.pool.query("update workflow_versions set record=record - 'executionSemanticsVersion' where id=$1", [f.version.id])).rejects.toThrow()
    await expect(db.pool.query("update workflow_versions set record=record #- '{definition,edges,1,kind}' where id=$1", [f.version.id])).rejects.toThrow()
    expect(await read()).toEqual(before)
  })
  it('refuses in-place changes to an accepted current version', async () => {
    const { f, read } = await setup(), before = await read()
    await expect(db.pool.query("update workflow_versions set record=jsonb_set(record,'{definition,name}','\"changed\"'::jsonb) where id=$1", [f.version.id])).rejects.toThrow()
    expect(await read()).toEqual(before)
  })
  it('does not infer an approval assignment from execution adjacency', async () => {
    const { f, save, read } = await setup(), before = await read()
    const graph = { ...f.version.definition, edges: f.version.definition.edges.filter((edge) => edge.kind === 'execution') }
    await expect(save(graph)).rejects.toThrow()
    expect(await read()).toEqual(before)
  })
  it('rejects a User-handler change that conflicts with pinned native review instead of rewriting configurations', async () => {
    const { f, save, read } = await setup(), before = await read()
    const configurations = (await db.pool.query('select record from agent_configuration_versions where workspace_id=$1 order by id', [f.scope.workspaceId])).rows
    const edges = f.version.definition.edges.filter((edge) => edge.kind === 'execution')
    await expect(save({ ...f.version.definition, approval: { handler: 'user' }, edges })).rejects.toMatchObject({
      code: 'GRAPH_INVALID', details: { issues: expect.arrayContaining([
        expect.objectContaining({ message: 'pinned native configuration conflicts with approval authority' }),
      ]) },
    })
    expect(await read()).toEqual(before)
    expect((await db.pool.query('select record from agent_configuration_versions where workspace_id=$1 order by id', [f.scope.workspaceId])).rows).toEqual(configurations)
  })
})
