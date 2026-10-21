import { approvalOrchestrationDatabase } from './helpers/approvalOrchestrationDatabase.js'
import { approvalFixture } from './helpers/wave25ApprovalFixture.js'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('current durable approval orchestration', () => {
  const getDatabase = approvalOrchestrationDatabase()

  it.each(['transitive', 'unconnected', 'same_agent_other_node'] as const)('rejects %s approval topology during current Save before it can grant reviewer authority', async (topology) => {
    const db = getDatabase()
    const f = makeCurrentWorkflowFixture(randomUUID(), 'approval')
    f.configurations[0]!.harness = structuredClone(approvalFixture().configurations[0]!.harness)
    await seedAgent3(db.pool, db.directory, f, { run: false })
    const access = new PostgresAccessService(db.pool)
    const writer = await access.issue({ name: 'Approval author', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
    const workflows = new WorkflowManagementService(db.pool, new PostgresCommandCoordinator(db.pool))
    const managed = await workflows.get(writer.principal, f.scope.workspaceId, f.scope.workflowId)
    const graph = structuredClone(f.version.definition)
    const assignment = graph.edges.find((edge) => edge.kind === 'approval')!
    if (topology === 'unconnected') graph.edges = graph.edges.filter((edge) => edge.id !== assignment.id)
    if (topology === 'transitive') assignment.source = assignment.target
    if (topology === 'same_agent_other_node') graph.nodes.push({ ...graph.nodes[1]!, id: 'same-agent-other-occurrence' })
    const before = (await db.pool.query('select id from workflow_versions')).rows
    await expect(workflows.current.save(writer.principal, 'mcp', { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: managed.revision,
      expectedWorkflowVersionId: f.version.id,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds, graph })).rejects.toThrow()
    expect((await db.pool.query('select id from workflow_versions')).rows).toEqual(before)
    expect((await db.pool.query('select principal_id from worker_credential_bindings')).rows).toHaveLength(0)
  }, 60000)
})
