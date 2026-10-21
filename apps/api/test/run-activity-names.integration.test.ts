import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  CurrentWorkflowSaveResultSchema, RunActivitiesPageSchema, WorkflowDefinitionV3Schema,
} from '@foreman-code/contracts/wave25'
import { RunBoardSnapshotGetResultSchema } from '@foreman-code/contracts/run-snapshots'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { RepeatRepositoryFactory } from '../src/modules/runs/repeatRepositoryHost.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentRepositoryServices } from './helpers/wave25CurrentRepository.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

it('keeps admission-time Agent names in the Run board and Activities after presentation-only saves', async () => {
  await nim2691TaskDatabase(async (pool, directory) => {
    await applyApplicationMigrations(pool)
    const db = { pool, directory, schema: 'public', close: async () => {} } as Awaited<ReturnType<typeof currentDatabase>>
    const fixture = await graphFixture(db, { form: 'sequential', handoffs: true, insert: false, qualifiedReads: true })
    const locations = new WorkspaceLocationService(pool, fixture.commands)
    const runs = new RunManagementService(pool, fixture.commands, {} as never, {} as never, {} as never)
    const app = buildApp({
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: fixture.access, services: { commands: fixture.commands, workflows: fixture.workflows, runs } as never },
    })
    try {
      const location = await locations.set(fixture.writer.principal, 'http', {
        workspaceId: fixture.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
        runnerId: 'runner-local', rootPath: directory,
      })
      const definitionUrl = `/api/management/workspaces/${fixture.scope.workspaceId}/workflows/${fixture.scope.workflowId}/definition`
      async function rename(names: string[], source: 'http' | 'mcp') {
        const stored = (await pool.query<{ record: unknown; revision: string }>(
          'select record,revision::text from workflows where id=$1 and workspace_id=$2',
          [fixture.scope.workflowId, fixture.scope.workspaceId])).rows[0]!
        const graph = WorkflowDefinitionV3Schema.parse(stored.record)
        graph.nodes.forEach((node, index) => { node.name = names[index]! })
        const input = {
          workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId, commandId: randomUUID(),
          executionSemanticsVersion: 3, expectedRevision: Number(stored.revision),
          expectedWorkflowVersionId: fixture.version.id,
          expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds, graph,
        }
        let result: unknown
        if (source === 'http') {
          const response = await fixture.app.inject({ method: 'PUT', url: definitionUrl,
            headers: graphHeaders(fixture.writer.token), payload: input })
          expect(response.statusCode, response.body).toBe(200)
          result = response.json()
        } else {
          const response = await graphRpc(app, fixture.writer.token, 'tools/call', {
            name: 'workflow_save_v3', arguments: input,
          })
          expect(response.result?.isError).not.toBe(true)
          result = graphRpcValue(response.result)
        }
        const saved = CurrentWorkflowSaveResultSchema.parse(result).value
        expect(saved.version.id).toBe(fixture.version.id)
        const readback = await fixture.workflows.get(fixture.writer.principal,
          fixture.scope.workspaceId, fixture.scope.workflowId)
        expect(readback.workflow.nodes.map(node => node.name)).toEqual(names)
        return saved
      }
      const admittedNames = ['Admission worker', 'Admission reviewer']
      const saved = await rename(admittedNames, 'http')
      const started = await admitRepeatRun(pool, locations, fixture.writer.principal, 'http', {
        ...fixture.accepted.snapshot.request, commandId: randomUUID(), expectedWorkflowRevision: saved.revision,
        expectedLocationRevision: location.value.locationRevision,
      }, repeatStartPublication)
      expect(started.replayed).toBe(false)
      const run = started.value
      const node = agentWorkflowNode(fixture.version.definition.nodes[0])
      const requester = agentWorkflowNode(fixture.version.definition.nodes[1])
      const executionId = 'named-execution'
      const owner = await RunOwnership.acquire(pool, run.id, () => {})
      if (!owner) throw new Error('Expected to acquire the Run owner')
      try {
        const factory = new RepeatRepositoryFactory(locations, directory,
          currentRepositoryServices({ pool }, createWorkflowNativeCaptureChannel().verify).services)
        const store = factory.forOwner(owner, fixture.version)
        const activationId = await store.ensureWorkEntry()
        await store.admitWorkActivation(activationId, () => ({
          id: executionId, runId: run.id, workflowNodeId: node.id, agentId: node.agentId,
          agentConfigurationVersionId: run.agentConfigurationVersionIds[node.agentId]!,
          attempt: 1, state: 'queued', input: {}, createdAt: run.createdAt,
        }))
      } finally {
        await owner.release()
      }
      await pool.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
        values($1,'backend','node_state_changed',$2,$3,'{"state":"running","actorName":"Forged payload name"}'::jsonb),
          ($1,'backend','work_requester_reactivated',null,$3,$4::jsonb)`,
      [run.id, executionId, run.createdAt, JSON.stringify({ requesterNodeId: requester.id, subjectName: 'Forged subject name' })])
      await rename(['Later worker', 'Later reviewer'], 'mcp')
      const reader = await fixture.credential([{ actions: ['workflows:read', 'graph:read', 'agents:read',
        'workspace_locations:read'], scope: { workspaceIds: [run.workspaceId] } }])
      const current = await fixture.workflows.get(fixture.writer.principal, run.workspaceId, run.workflowId)
      const deniedRename = { workspaceId: run.workspaceId, workflowId: run.workflowId, commandId: randomUUID(),
        executionSemanticsVersion: 3, expectedRevision: current.revision, expectedWorkflowVersionId: fixture.version.id,
        expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
        graph: { ...current.workflow, nodes: current.workflow.nodes.map(node => ({ ...node, name: 'Denied rename' })) } }
      expect((await fixture.app.inject({ method: 'PUT', url: definitionUrl,
        headers: graphHeaders(reader.token), payload: deniedRename })).statusCode).toBe(403)
      const deniedSave = await graphRpc(app, reader.token, 'tools/call', {
        name: 'workflow_save_v3', arguments: deniedRename,
      })
      expect(deniedSave.error || deniedSave.result?.isError).toBeTruthy()
      expect(await fixture.workflows.get(fixture.writer.principal, run.workspaceId, run.workflowId)).toEqual(current)

      const boardScope = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id }
      const snapshot = await runs.history.snapshot(fixture.writer.principal, boardScope)
      expect(snapshot.snapshot.kind).toBe('available')
      if (snapshot.snapshot.kind !== 'available') throw new Error('Expected admission board')
      expect(snapshot.snapshot.nodes.map((node) => node.name)).toEqual(admittedNames)
      const boardMcp = await graphRpc(app, fixture.writer.token, 'tools/call', {
        name: 'run_board_snapshot_get', arguments: boardScope,
      })
      expect(boardMcp.result?.isError).not.toBe(true)
      expect(RunBoardSnapshotGetResultSchema.parse(graphRpcValue(boardMcp.result))).toEqual(snapshot)
      const args = { workspaceId: run.workspaceId, runId: run.id, limit: 100 }
      const url = `/api/management/workspaces/${run.workspaceId}/runs/${run.id}/activities?limit=100`
      const http = await app.inject({ method: 'GET', url, headers: graphHeaders(fixture.writer.token) })
      expect(http.statusCode, http.body).toBe(200)
      const page = RunActivitiesPageSchema.parse(http.json())
      expect(page.items.find((item) => item.actor?.nodeId === node.id)?.actor).toEqual({
        agentId: node.agentId, nodeId: node.id, agentName: admittedNames[0], nodeName: admittedNames[0],
      })
      expect(page.items.find((item) => item.subject?.nodeId === requester.id)?.subject).toEqual({
        agentId: requester.agentId, nodeId: requester.id, agentName: admittedNames[1], nodeName: admittedNames[1],
      })
      const mcp = await graphRpc(app, fixture.writer.token, 'tools/call', { name: 'run_activities_get_v1', arguments: args })
      expect(mcp.result?.isError).not.toBe(true)
      expect(RunActivitiesPageSchema.parse(graphRpcValue(mcp.result))).toEqual(page)
      const denied = await fixture.credential([{ actions: ['workflows:read'], scope: { workspaceIds: [run.workspaceId] } }])
      expect((await app.inject({ method: 'GET', url, headers: graphHeaders(denied.token) })).statusCode).toBe(403)
      const blocked = await graphRpc(app, denied.token, 'tools/call', { name: 'run_activities_get_v1', arguments: args })
      expect(blocked.error || blocked.result?.isError).toBeTruthy()
      const foreign = await graphRpc(app, fixture.writer.token, 'tools/call', {
        name: 'run_activities_get_v1', arguments: { ...args, workspaceId: 'foreign-workspace' },
      })
      expect(foreign.error || foreign.result?.isError).toBeTruthy()
      expect(JSON.stringify(page)).not.toMatch(/Later worker|Later reviewer|Forged (payload|subject) name/)
      expect((await runs.history.snapshot(fixture.writer.principal, boardScope))).toEqual(snapshot)
      expect((await pool.query<{ record: unknown }>('select record from workflow_versions where id=$1',
        [fixture.version.id])).rows[0]?.record).toEqual(fixture.version)
    } finally {
      await app.close()
      await fixture.app.close()
    }
  })
}, 120000)
