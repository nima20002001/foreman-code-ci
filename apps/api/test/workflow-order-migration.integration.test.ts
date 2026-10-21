import { randomUUID } from 'node:crypto'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { WorkflowDefinitionV3Schema } from '@foreman-code/contracts/wave25'
import { expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { workflowOrderMigration } from '../src/infrastructure/workflowOrderMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { OperatorLifecycleService } from '../src/modules/workspaces/operatorLifecycle.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

function workflowRecord(workspaceId: string, id: string) {
  return WorkflowDefinitionV3Schema.parse({
    id, workspaceId, name: id, approval: { handler: 'user' },
    executionSemanticsVersion: 3, entryNodeId: null, handoffs: { contractVersion: 1 },
    executionCondition: { kind: 'manual' }, nodes: [], edges: [],
    createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
  })
}

it('backfills ID order and maintains append positions and membership revisions for inserts, archive and restore', async () => {
  const database = await currentDatabase({ beforeMigration: workflowOrderMigration.version })
  try {
    const pool = database.pool
    for (const workspaceId of ['workspace-a', 'workspace-b']) {
      await pool.query('insert into workspaces (id, record) values ($1, $2::jsonb)',
        [workspaceId, JSON.stringify({ id: workspaceId, name: workspaceId, createdAt: '2030-01-01T00:00:00.000Z' })])
    }
    for (const [id, timestamp] of [
      ['workflow-z', '2030-01-01'], ['workflow-a', '2030-01-03'], ['workflow-m', '2030-01-02'],
    ]) {
      await pool.query('insert into workflows (id, workspace_id, record, created_at) values ($1, $2, $3::jsonb, $4)',
        [id, 'workspace-a', JSON.stringify(workflowRecord('workspace-a', id!)), timestamp])
    }
    await pool.query('insert into workflows (id, workspace_id, record) values ($1, $2, $3::jsonb)',
      ['workflow-other', 'workspace-b', JSON.stringify(workflowRecord('workspace-b', 'workflow-other'))])
    await applyApplicationMigrations(pool)
    const commands = new PostgresCommandCoordinator(pool)
    const workflows = new WorkflowManagementService(pool, commands)
    const lifecycle = new OperatorLifecycleService(commands)
    const issued = await new PostgresAccessService(pool).issue({ name: 'Migration owner', audience: 'operator',
      grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    const read = () => workflows.list(issued.principal, {
      workspaceId: 'workspace-a', limit: 100, includeArchived: false,
    })
    const initial = await read()
    expect(initial.items.map((item) => item.workflow.id)).toEqual(['workflow-a', 'workflow-m', 'workflow-z'])
    expect(initial.orderRevision).toBe(0)
    expect((await new PostgresWorkflowRepository(pool).list('workspace-a')).map((item) => item.id))
      .toEqual(['workflow-a', 'workflow-m', 'workflow-z'])
    expect((await workflows.list(issued.principal, {
      workspaceId: 'workspace-b', limit: 100, includeArchived: false,
    })).items.map((item) => item.workflow.id)).toEqual(['workflow-other'])

    const appended = workflowRecord('workspace-a', 'workflow-0')
    const append = () => pool.query(
      `insert into workflows (id, workspace_id, record) values ($1, $2, $3::jsonb)
       on conflict (id) do nothing`, [appended.id, appended.workspaceId, JSON.stringify(appended)],
    )
    await append()
    await append()
    const afterAppend = await read()
    expect(afterAppend.items.map((item) => item.workflow.id))
      .toEqual(['workflow-a', 'workflow-m', 'workflow-z', 'workflow-0'])
    expect(afterAppend.orderRevision).toBe(1)
    const renamed = await workflows.update(issued.principal, 'http', {
      workspaceId: 'workspace-a', workflowId: 'workflow-m', commandId: randomUUID(),
      expectedRevision: afterAppend.items[1]!.revision, name: 'Renamed',
    })
    expect((await read()).orderRevision).toBe(1)
    const archived = await workflows.archive(issued.principal, 'http', {
      workspaceId: 'workspace-a', workflowId: 'workflow-m', commandId: randomUUID(),
      expectedRevision: renamed.value.revision,
    })
    expect((await read()).orderRevision).toBe(2)
    expect((await read()).items.map((item) => item.workflow.id)).toEqual(['workflow-a', 'workflow-z', 'workflow-0'])
    await lifecycle.restoreWorkflow(issued.principal, {
      workspaceId: 'workspace-a', workflowId: 'workflow-m', commandId: randomUUID(),
      expectedRevision: archived.value.revision,
    })
    const restored = await read()
    expect(restored.orderRevision).toBe(3)
    expect(restored.items.map((item) => item.workflow.id))
      .toEqual(['workflow-a', 'workflow-m', 'workflow-z', 'workflow-0'])
    await pool.query('delete from workflows where id = $1', [appended.id])
    expect((await read()).orderRevision).toBe(4)
    await Promise.all(['workflow-x', 'workflow-y'].map((id) => pool.query(
      'insert into workflows (id, workspace_id, record) values ($1, $2, $3::jsonb)',
      [id, 'workspace-a', JSON.stringify(workflowRecord('workspace-a', id))],
    )))
    const concurrent = await read()
    expect(concurrent.items.slice(0, 3).map((item) => item.workflow.id))
      .toEqual(['workflow-a', 'workflow-m', 'workflow-z'])
    expect(concurrent.items.slice(3).map((item) => item.workflow.id).sort()).toEqual(['workflow-x', 'workflow-y'])
    expect(concurrent.orderRevision).toBe(6)
    expect((await workflows.list(issued.principal, {
      workspaceId: 'workspace-b', limit: 100, includeArchived: false,
    })).orderRevision).toBe(0)
  } finally {
    await database.close()
  }
}, 60_000)
