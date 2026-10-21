import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema, RunEventsPageSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult, OperatorRunGetResultSchema } from '@foreman-code/contracts/operator-mcp'
import { SourceRootBindResultSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { CurrentWorkflowSaveResultSchema, RunActivitiesPageSchema, RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { DomainError } from '../src/modules/errors.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { sourceWorktreeMcpFixture } from './helpers/sourceWorktreeMcpFixture.js'

afterEach(() => vi.restoreAllMocks())

type Fixture = Awaited<ReturnType<typeof sourceWorktreeMcpFixture>>

async function start(f: Fixture) {
  const response = await f.client.callTool({ name: 'run_start', arguments: {
    ...f.input, commandId: randomUUID(),
  } })
  expect(response.isError, JSON.stringify(response)).not.toBe(true)
  return RunStartV3ResultSchema.parse(decodeMcpToolResult(response)).run.id
}

async function read(f: Fixture, runId: string) {
  const response = await f.client.callTool({ name: 'run_get', arguments: {
    workspaceId: f.input.workspaceId, runId, detail: 'full',
  } })
  expect(response.isError, JSON.stringify(response)).not.toBe(true)
  const details = OperatorRunGetResultSchema.parse(decodeMcpToolResult(response))
  if ('detail' in details) throw new Error('Expected full Run details')
  return details
}

describe.runIf(postgresEnabled)('Workspace root sharing and execution preparation', () => {
  it('executes sources bound through MCP by a writer other than the root policy owner and Run starter', async () => {
    const f = await sourceWorktreeMcpFixture()
    try {
      const binder = await f.base.access.issue({ name: 'Source binding writer', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.input.workspaceId] } }],
      })
      const approved = await f.production.sources.approveProject(f.base.writer.principal, {
        workspaceId: f.input.workspaceId, commandId: randomUUID(), executablePolicy: 'strip',
      })
      const source = { approvedSourceId: approved.manifest.approvedSourceId,
        snapshotId: approved.manifest.snapshotId, manifestDigest: approved.manifest.manifestDigest }
      const bind = { workspaceId: f.input.workspaceId, commandId: randomUUID(), source,
        selection: f.root.selection, expectedBindingRevision: f.root.binding.bindingRevision,
        accessMode: 'exclusive-write' }
      const reader = await f.base.access.issue({ name: 'Root reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['runs:read', 'sources:read', 'source_roots:read', 'workspace_locations:read'],
          scope: { workspaceIds: [f.input.workspaceId] } }],
      })
      const denied = await f.connect(reader.token)
      await expectMcpAccessDenied(denied.callTool({ name: 'source_root_bind', arguments: bind }))
      await expectMcpAccessDenied(denied.callTool({ name: 'run_start', arguments: {
        ...f.input, commandId: randomUUID(),
      } }))
      const client = await f.connect(binder.token)
      const response = await client.callTool({ name: 'source_root_bind', arguments: bind })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      const bound = SourceRootBindResultSchema.parse(decodeMcpToolResult(response)).value
      expect(bound.ownerPrincipalId).toBe(binder.principal.id)
      expect(bound.ownerPrincipalId).not.toBe(f.base.writer.principal.id)
      expect(SourceRootBindResultSchema.parse(decodeMcpToolResult(
        await client.callTool({ name: 'source_root_bind', arguments: bind }))))
        .toEqual({ value: bound, replayed: true })
      const graph = structuredClone(f.saved.version.definition)
      for (const node of graph.nodes) {
        agentWorkflowNode(node).placement!.source = source
        agentWorkflowNode(node).placement!.rootBinding = {
          rootId: bound.binding.rootId, bindingRevision: bound.binding.bindingRevision,
        }
      }
      const save = await f.client.callTool({ name: 'workflow_save_v3', arguments: {
        workspaceId: f.input.workspaceId, workflowId: f.input.workflowId, commandId: randomUUID(),
        executionSemanticsVersion: 3, graph, expectedRevision: f.saved.revision,
        expectedWorkflowVersionId: f.saved.currentVersionId,
        expectedAgentConfigurationVersionIds: f.saved.version.agentConfigurationVersionIds,
      } })
      expect(save.isError, JSON.stringify(save)).not.toBe(true)
      const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(save)).value
      f.input.workflowVersionId = saved.currentVersionId
      f.input.expectedWorkflowRevision = saved.revision
      const runId = await start(f)
      await expect.poll(async () => (await read(f, runId)).run.executionState, { timeout: 90000 }).toBe('waiting')
      const details = await read(f, runId)
      expect(details.executions).toHaveLength(2)
      expect(details.executions.every(execution => execution.nativeSessionId && execution.workingDirectory)).toBe(true)
      const placement = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
        workspaceId: f.input.workspaceId, workflowId: f.input.workflowId, runId,
        nodeId: graph.entryNodeId,
      } })
      expect(placement.isError, JSON.stringify(placement)).not.toBe(true)
      expect(RunPlacementGetResultSchema.parse(decodeMcpToolResult(placement)).readback)
        .toMatchObject({ evidence: 'accepted', placement: { source: {
          rootId: bound.binding.rootId, bindingRevision: bound.binding.bindingRevision,
        } } })
      const persisted = await f.base.db.pool.query<{ record: unknown }>(
        'select record from source_root_bindings where root_id=$1 and binding_revision=$2',
        [bound.binding.rootId, bound.binding.bindingRevision])
      expect(SourceRootRecordSchema.parse(persisted.rows[0]!.record)).toEqual(bound)
      const policy = await f.base.db.pool.query<{ record: { ownerPrincipalId: string } }>(
        'select record from workspace_root_policies where root_policy_id=$1 and root_policy_revision=$2',
        [bound.selection.rootPolicyId, bound.selection.rootPolicyRevision])
      expect(policy.rows[0]!.record.ownerPrincipalId).toBe(f.base.writer.principal.id)
      expect(f.base.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 120000)

  it.each([400, 403, 409])('settles a permanent %i preparation failure and exposes its reason through MCP and HTTP', async status => {
    const f = await sourceWorktreeMcpFixture()
    try {
      const reason = 'The accepted source namespace is no longer available.'
      const prepare = vi.spyOn(f.production.sources, 'prepareExecution')
        .mockRejectedValue(new DomainError('SOURCE_ROOT_CONFLICT', reason, status))
      const runId = await start(f)
      await expect.poll(async () => (await read(f, runId)).run.executionState, { timeout: 30000 }).toBe('completed')
      const details = await read(f, runId)
      expect(details.run.outcome).toBe('failed')
      expect(details.executions).toHaveLength(1)
      const execution = details.executions[0]!
      const result = { outcome: 'failed', error: { code: 'SOURCE_ROOT_CONFLICT', message: reason, retryable: false } }
      expect(execution).toMatchObject({ state: 'completed', result })
      expect(execution.nativeSessionId).toBeUndefined()
      expect(prepare).toHaveBeenCalledTimes(1)
      // Cleanup is recorded after the Run settles; read the pages only once the Run's history is complete.
      await expect.poll(async () => {
        const settled = await f.client.callTool({ name: 'run_activities_get_v1', arguments: {
          workspaceId: f.input.workspaceId, runId, limit: 100,
        } })
        return RunActivitiesPageSchema.parse(decodeMcpToolResult(settled)).items
          .some(item => item.kind === 'recovery' && item.status === 'completed')
      }, { timeout: 30000 }).toBe(true)
      const events = await f.client.callTool({ name: 'run_events_list', arguments: {
        workspaceId: f.input.workspaceId, runId, limit: 100,
      } })
      expect(events.isError, JSON.stringify(events)).not.toBe(true)
      const page = RunEventsPageSchema.parse(decodeMcpToolResult(events))
      expect(page.items).toContainEqual(expect.objectContaining({ harnessExecutionId: execution.id,
        kind: 'result_recorded', payload: expect.objectContaining({ result }) }))
      const http = await f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${f.input.workspaceId}/runs/${runId}/events?limit=100`,
        headers: { authorization: `Bearer ${f.base.writer.token}` },
      })
      expect(http.statusCode).toBe(200)
      expect(RunEventsPageSchema.parse(http.json())).toEqual(page)
      const activities = await f.client.callTool({ name: 'run_activities_get_v1', arguments: {
        workspaceId: f.input.workspaceId, runId, limit: 100,
      } })
      expect(activities.isError, JSON.stringify(activities)).not.toBe(true)
      const publicPage = RunActivitiesPageSchema.parse(decodeMcpToolResult(activities))
      expect(publicPage.items).toContainEqual(expect.objectContaining({ status: 'failed', severity: 'error',
        refs: expect.objectContaining({ executionId: execution.id }), detail: `SOURCE_ROOT_CONFLICT: ${reason}` }))
      const publicHttp = await f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${f.input.workspaceId}/runs/${runId}/activities?limit=100`,
        headers: { authorization: `Bearer ${f.base.writer.token}` },
      })
      expect(publicHttp.statusCode).toBe(200)
      // A completed failed Run can record another cleanup cycle after this read; compare the same history prefix.
      const readThrough = Math.max(...publicPage.items.map(item => Number(item.sequence)))
      expect(RunActivitiesPageSchema.parse(publicHttp.json()).items.filter(item => Number(item.sequence) <= readThrough))
        .toEqual(publicPage.items)
      const stored = await f.base.db.pool.query<{ record: { result: unknown } }>(
        'select record from harness_executions where id=$1', [execution.id])
      expect(stored.rows[0]!.record.result).toEqual(result)
      await f.base.engine.reconcile()
      expect(prepare).toHaveBeenCalledTimes(1)
    } finally { await f.close() }
  }, 60000)

  it.each([
    new Error('Source storage transport disconnected'),
    new DomainError('DEVICE_RUNTIME_UNAVAILABLE', 'Source storage is temporarily unavailable.', 503),
    new DomainError('SOURCE_ROOT_CONFLICT', 'Source storage is busy.', 409, { retryable: true }),
  ])('retries transient preparation failures in a fresh attempt and keeps the Run running: $message', async failure => {
    const f = await sourceWorktreeMcpFixture()
    try {
      const prepare = vi.spyOn(f.production.sources, 'prepareExecution').mockRejectedValue(failure)
      const runId = await start(f)
      await expect.poll(() => prepare.mock.calls.length, { timeout: 30000 }).toBeGreaterThanOrEqual(2)
      await expect.poll(async () => (await read(f, runId)).executions.length, { timeout: 30000 }).toBeGreaterThanOrEqual(2)
      const failed = await read(f, runId)
      expect(failed.run).toMatchObject({ executionState: 'running', outcome: 'pending' })
      expect(failed.executions.some(execution => execution.nativeSessionId)).toBe(false)
      const abandoned = failed.executions.filter(execution => execution.result)
      expect(abandoned.length).toBeGreaterThanOrEqual(1)
      for (const execution of abandoned) {
        expect(execution.result).toMatchObject({ outcome: 'failed', error: { retryable: true } })
      }
      prepare.mockRestore()
      await expect.poll(async () => (await read(f, runId)).run.executionState, { timeout: 90000 }).toBe('waiting')
      const settled = await read(f, runId)
      expect(settled.run.outcome).toBe('pending')
      expect(settled.executions.some(execution => execution.nativeSessionId)).toBe(true)
    } finally { await f.close() }
  }, 120000)
})
