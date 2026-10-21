import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL, type HarnessExecutionRequest } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, RunStartV3ResultSchema, type RunStartV3Input } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('immutable workflow result protocol and coordinated cutover', () => {
  it.each([false, true])('settles a finite repeat with its originally admitted result protocol: %s', async marked => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'repeat')
    if (marked) fixture.run.resultProtocol = COORDINATION_RESULT_PROTOCOL
    const observed = new Map<string, HarnessExecutionRequest>()
    const outputs = new Map<string, unknown>()
    const f = await checkpointRuntimeFixture(1, 1, { fixture, approvalNodeIds: [], collaborationPorts: {},
      outputFor: (nodeId, request) => {
        observed.set(request.executionId, structuredClone(request))
        const exit = nodeId === fixture.version.definition.repeat!.blocks[0]!.exitNodeId
        const value = exit ? { routing: { outcome: 'pass' },
          data: { latestDeliverable: { answer: 'All work is complete' }, remainingFindings: [] },
          ...(marked ? { summary: 'The repeat passed', board: { kind: 'none', reason: 'no_changes' } } : {}) }
          : marked ? { data: { answer: 'Work for the exit check' }, summary: 'Work is ready',
            board: { kind: 'none', reason: 'no_changes' } } : { answer: 'Historical work result' }
        outputs.set(request.executionId, structuredClone(value))
        return value
      } })
    try {
      await f.engine.start(f.f.run.id)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
      expect(executions).toHaveLength(2)
      expect(f.provider.counts.starts).toBe(2)
      for (const execution of executions) {
        expect(execution.result).toEqual({ outcome: 'succeeded', output: outputs.get(execution.id) })
        expect(observed.get(execution.id)?.resultProtocol).toBe(marked ? COORDINATION_RESULT_PROTOCOL : undefined)
        expect(observed.get(execution.id)?.input).toEqual(execution.input)
      }
      const decisions = (await f.db.pool.query('select record from run_repeat_decisions where run_id=$1', [f.f.run.id])).rows
      expect(decisions).toHaveLength(1)
      expect(decisions[0]!.record).toMatchObject({ outcome: 'pass', resultData: {
        latestDeliverable: { answer: 'All work is complete' }, remainingFindings: [] } })
      const original = await f.runs.get(f.f.run.id)
      await expect(f.db.pool.query(marked ? `update runs set record=record-'resultProtocol' where id=$1`
        : `update runs set record=jsonb_set(record,'{resultProtocol}',to_jsonb($2::text)) where id=$1`,
      marked ? [f.f.run.id] : [f.f.run.id, COORDINATION_RESULT_PROTOCOL])).rejects.toThrow('WORKFLOW_RESULT_PROTOCOL_IMMUTABLE')
      expect(await f.runs.get(f.f.run.id)).toEqual(original)
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(2)
      expect((await f.db.pool.query('select record from run_repeat_decisions where run_id=$1', [f.f.run.id])).rows).toEqual(decisions)
    } finally { await f.close() }
  }, 90_000)

  it('starts the saved hierarchy equally through HTTP and MCP while result-protocol enforcement stays off', async () => {
    const f = await currentOperatorIntegration({ fixture: hierarchyRuntimeFixture(), insertRun: false,
      approvalNodeIds: [], collaborationPorts: {}, outputFor: (node, request) => coordinationOutput(node, request,
        node === 'master' ? { select: ['build'] } : {}) })
    try {
      const version = f.f.version
      const directory = await stat(f.db.directory, { bigint: true })
      await f.db.pool.query('update workspaces set execution_location_identity=$2::jsonb where id=$1',
        [version.workspaceId, JSON.stringify({ device: String(directory.dev), inode: String(directory.ino) })])
      const revision = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1',
        [version.workflowId])).rows[0]!.revision
      const input: RunStartV3Input = { workspaceId: version.workspaceId, workflowId: version.workflowId,
        workflowVersionId: version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
        expectedWorkflowRevision: Number(revision), expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
        expectedLocationRevision: f.f.run.executionLocation!.locationRevision, input: { task: 'Run the saved hierarchy' } }
      const url = `/api/management/workspaces/${version.workspaceId}/workflows/${version.workflowId}/runs`
      const http = await f.app.inject({ method: 'POST', url, headers: graphHeaders(f.writer.token), payload: input })
      expect(http.statusCode, http.body).toBe(202)
      const started = RunStartV3ResultSchema.parse(http.json())
      expect(started.run.resultProtocol).toBeUndefined()
      const mcp = await graphRpc(f.app, f.writer.token, 'tools/call', { name: 'run_start', arguments: input })
      expect(mcp.result?.isError).not.toBe(true)
      expect(graphRpcValue(mcp.result)).toMatchObject({ run: { id: started.run.id }, replayed: true })
      const reader = await f.access.issue({ name: 'Read-only hierarchy caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['runs:read'], scope: { workspaceIds: [version.workspaceId] } }] })
      expect((await f.app.inject({ method: 'POST', url, headers: graphHeaders(reader.token), payload: input })).statusCode).toBe(403)
      const denied = await graphRpc(f.app, reader.token, 'tools/call', { name: 'run_start', arguments: input })
      expect(graphRpcValue(denied.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      await expect.poll(async () => (await f.runs.get(started.run.id))?.outcome, { timeout: 30_000 }).toBe('succeeded')
      expect((await f.db.pool.query('select id from runs where workflow_id=$1', [version.workflowId])).rows).toEqual([{ id: started.run.id }])
      expect((await f.db.pool.query('select record from workflow_versions where id=$1', [version.id])).rows)
        .toEqual([{ record: version }])
      expect(f.provider.counts.starts).toBe(5)
    } finally { await f.close() }
  }, 90_000)
})
