import { randomUUID } from 'node:crypto'
import { AgentSchema } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { currentDatabase } from './eng04CurrentDatabase.js'
import { insertCurrentRunFixture } from './eng04CurrentRunFixture.js'

/** Persisted read fixture. Workflow versions use the actual typed writer; the
 * queued Run uses canonical fixture publication, never a fake native result. */
export async function currentRunHistory() {
  const db = await currentDatabase()
  try {
    const f = makeCurrentWorkflowFixture(randomUUID(), 'single')
    await db.pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
      values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [f.scope.workspaceId,
    JSON.stringify({ id: f.scope.workspaceId, name: 'History fixture' }),
    JSON.stringify({ runnerId: 'runner-local', rootPath: db.directory }), JSON.stringify({ fixture: true })])
    for (const configuration of f.configurations) {
      const agent = AgentSchema.parse({ id: configuration.agentId, name: 'History Worker', productRole: configuration.productRole,
        configurationVersionId: configuration.id, harnessConfiguration: configuration.harness })
      await db.pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)',
        [agent.id, f.scope.workspaceId, JSON.stringify(agent)])
      await db.pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)',
        [configuration.id, configuration.workspaceId, configuration.agentId, JSON.stringify(configuration)])
      await db.pool.query('update agents set current_configuration_version_id=$2 where id=$1', [agent.id, configuration.id])
    }
    const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
    const owner = await access.issue({ name: 'History writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
    const workflows = new WorkflowManagementService(db.pool, commands)
    const managed = (await workflows.create(owner.principal, 'mcp', { workspaceId: f.scope.workspaceId,
      commandId: randomUUID(), name: 'History version one' })).value
    const input = { workspaceId: f.scope.workspaceId, workflowId: managed.workflow.id, commandId: randomUUID(),
      executionSemanticsVersion: 3, expectedRevision: managed.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
      graph: { ...managed.workflow, entryNodeId: f.version.entryNodeId, nodes: f.version.definition.nodes,
        edges: f.version.definition.edges, approval: f.version.approval, executionPolicy: f.version.definition.executionPolicy! } }
    const saved = await workflows.current.save(owner.principal, 'mcp', input)
    const newer = await workflows.current.save(owner.principal, 'mcp', { ...input, commandId: randomUUID(),
      expectedRevision: saved.value.revision, expectedWorkflowVersionId: saved.value.currentVersionId,
      graph: { ...saved.value.version.definition, name: 'History version two' } })
    const accepted = await insertCurrentRunFixture(db.pool, { ...f, run: { ...f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` },
    } }, saved.value, owner.principal.id)
    return { db, f, access, commands, owner, workflows, saved, newer, ...accepted }
  } catch (error) { await db.close(); throw error }
}
