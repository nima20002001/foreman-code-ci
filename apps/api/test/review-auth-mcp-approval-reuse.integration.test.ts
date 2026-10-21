import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { resolveImmutableApprovalRoute } from '../src/modules/workflows/approvalRoutes.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

it('saves and reads exact approval routes for two nodes sharing a Worker Agent', async () => {
  const database = await migratedDatabase()
  const { pool } = database
  const directory = await mkdtemp(join(tmpdir(), 'auth-mcp-reuse-'))
  try {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'approval')
    const reviewer = fixture.version.entryNodeId, worker = fixture.version.definition.nodes[1]!
    fixture.version.definition.nodes.push({ ...worker, id: 'second-worker' })
    fixture.version.definition.edges.push(
      { id: 'second-execution', kind: 'execution', source: reviewer, target: 'second-worker' },
      { id: 'second-approval', kind: 'approval', source: reviewer, target: 'second-worker' },
    )
    fixture.version.definition.executionPolicy!.maxNodeExecutions = 3
    const saved = await seedAgent3(pool, directory, fixture, { run: false })
    const version = WorkflowVersionV3Schema.parse((await pool.query('select record from workflow_versions where id=$1', [saved.version.id])).rows[0].record)
    for (const nodeId of [worker.id, 'second-worker']) {
      expect(resolveImmutableApprovalRoute(version, nodeId, worker.agentId)).toMatchObject({
        requestingNodeId: nodeId, requestingConfigurationVersionId: saved.version.agentConfigurationVersionIds[worker.agentId],
        orchestratorNodeId: reviewer,
      })
      expect(resolveImmutableApprovalRoute(version, nodeId, 'mismatched-agent')).toBeUndefined()
    }
  } finally {
    await database.close()
    await removeFixtureDirectory(directory)
  }
}, 30_000)
