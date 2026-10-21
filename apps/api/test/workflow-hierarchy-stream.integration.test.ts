import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WORKFLOW_HIERARCHY_TOOLS, WorkflowHierarchyReadResultSchema, WorkflowReportsPageSchema } from '@foreman-code/contracts'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { coordinationOutput, hierarchyRuntimeFixture } from './helpers/hierarchyRuntimeFixture.js'
import { openHierarchyEvents } from './helpers/hierarchyHttpStream.js'
import { deferred } from './helpers/deferred.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

type Fixture = Awaited<ReturnType<typeof currentOperatorIntegration>>
function publicReads(f: Fixture) {
  const base = `/api/management/workspaces/${f.f.scope.workspaceId}/workflows/${f.f.scope.workflowId}/hierarchy`
  const query = new URLSearchParams({ runId: f.f.run.id })
  return { base, query,
    async hierarchy() {
      const reply = await f.app.inject({ method: 'GET', url: `${base}?${query}`, headers: graphHeaders(f.writer.token) })
      expect(reply.statusCode, reply.body).toBe(200)
      return WorkflowHierarchyReadResultSchema.parse(reply.json())
    },
    async reports(filter: Record<string, string>) {
      const reply = await f.app.inject({ method: 'GET', url: `${base}/reports?${new URLSearchParams({ runId: f.f.run.id, ...filter })}`,
        headers: graphHeaders(f.writer.token) })
      expect(reply.statusCode, reply.body).toBe(200)
      return WorkflowReportsPageSchema.parse(reply.json())
    },
  }
}

describe.skipIf(!postgresEnabled)('committed hierarchy HTTP stream and report history', () => {
  it('publishes the accepted root final after child reports stop, without inventing a report revision', async () => {
    const entered = deferred(), release = deferred()
    const f = await currentOperatorIntegration({ workflowHierarchy: true, fixture: hierarchyRuntimeFixture(),
      approvalNodeIds: [], collaborationPorts: {},
      preparePlacementExecution: async (_owner, _run, execution) => {
        if (execution.workflowNodeId === 'master' && WorkActivationInputSchema.parse(execution.input).work.kind === 'hierarchy_group') {
          entered.resolve(); await release.promise
        }
        return undefined
      }, outputFor: (nodeId, request) => coordinationOutput(nodeId, request, { select: nodeId === 'master' ? ['build'] : [] }),
    })
    const reads = publicReads(f)
    let failure: unknown, stream: Awaited<ReturnType<typeof openHierarchyEvents>> | undefined
    const drive = f.engine.start(f.f.run.id).catch(error => { failure = error })
    try {
      await Promise.race([entered.promise, drive.then(() => { throw new Error('Root summary gate was never reached') })])
      const before = await reads.reports({ parentNodeId: 'master', limit: '50' })
      expect(before.items.some(report => report.state === 'returned')).toBe(true)
      stream = await openHierarchyEvents(f.address, `${reads.base}/events?${reads.query}`, f.writer.token)
      const first = await stream.next()
      expect(first).toMatchObject({ runId: f.f.run.id, workflowVersionId: f.f.version.id, revision: before.revision })
      release.resolve(); await drive
      expect(failure).toBeUndefined()
      expect((await reads.hierarchy()).run?.coordination).toMatchObject({ state: 'succeeded', summary: 'master finish' })
      const changed = await stream.next(), after = await reads.reports({ parentNodeId: 'master', limit: '50' })
      expect(changed.cursor).not.toBe(first.cursor)
      expect(changed.revision).toBe(first.revision)
      expect(after).toEqual(before)
      expect(after.items.every(report => report.agent.workflowNodeId !== 'master')).toBe(true)
    } finally {
      release.resolve(); await drive; await stream?.close(); await f.close()
    }
  }, 60_000)

  it('publishes Stop of a root direction wait with no child reports and preserves the exact selected Run', async () => {
    const f = await currentOperatorIntegration({ workflowHierarchy: true, fixture: hierarchyRuntimeFixture(),
      approvalNodeIds: [], collaborationPorts: {}, outputFor: (nodeId, request) => coordinationOutput(nodeId, request,
        { select: [], findings: ['A person must decide the delivery scope'] }) })
    const reads = publicReads(f)
    let stream: Awaited<ReturnType<typeof openHierarchyEvents>> | undefined
    try {
      await f.engine.start(f.f.run.id)
      const held = await reads.hierarchy()
      expect(held.run?.coordination).toMatchObject({ state: 'waiting_for_direction', direction: { execution: { runId: f.f.run.id } } })
      const reports = await reads.reports({ parentNodeId: 'master' })
      expect(reports.items).toEqual([])
      stream = await openHierarchyEvents(f.address, `${reads.base}/events?${reads.query}`, f.writer.token)
      const first = await stream.next()
      const stop = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${f.f.scope.workspaceId}/runs/${f.f.run.id}/stop`,
        headers: graphHeaders(f.writer.token), payload: { workspaceId: f.f.scope.workspaceId, runId: f.f.run.id, commandId: randomUUID() } })
      expect(stop.statusCode, stop.body).toBe(200)
      await expect.poll(async () => (await reads.hierarchy()).run?.coordination?.state, { timeout: 15_000 }).toBe('canceled')
      const changed = await stream.next()
      expect(changed).toMatchObject({ runId: f.f.run.id, workflowVersionId: f.f.version.id, revision: first.revision })
      expect(changed.cursor).not.toBe(first.cursor)
      expect(await reads.reports({ parentNodeId: 'master' })).toEqual(reports)
    } finally { await stream?.close(); await f.close() }
  }, 60_000)

  it('reads three earlier business rounds lazily through resource-bound cursors and HTTP/MCP parity', async () => {
    let summaries = 0
    const f = await currentOperatorIntegration({ workflowHierarchy: true, fixture: hierarchyRuntimeFixture(),
      approvalNodeIds: [], collaborationPorts: {}, outputFor: (nodeId, request) => {
        if (nodeId !== 'master') return coordinationOutput(nodeId, request, { select: [] })
        const input = WorkActivationInputSchema.parse(request.input)
        if (input.work.kind !== 'hierarchy_group') return coordinationOutput(nodeId, request, { select: ['build'] })
        summaries += 1
        if (summaries < 3) return { routing: { kind: 'delegate', requests: [{ outcome: 'build', data: { task: `Review round ${summaries + 1}` } }] },
          data: { latestDeliverable: `Round ${summaries} reviewed`, remainingFindings: [] },
          summary: `Begin review round ${summaries + 1}`, board: { kind: 'none', reason: 'no_changes' } }
        return coordinationOutput(nodeId, request)
      } })
    const reads = publicReads(f)
    try {
      await f.engine.start(f.f.run.id)
      expect((await reads.hierarchy()).run?.coordination?.state).toBe('succeeded')
      const summary = await reads.reports({ parentNodeId: 'master', limit: '50' })
      expect(summary.items).toHaveLength(1)
      const first = await reads.reports({ workflowNodeId: 'build', limit: '2' })
      expect(first.items).toHaveLength(2); expect(first.hasMore).toBe(true)
      const same = await graphRpc(f.app, f.writer.token, 'tools/call', { name: WORKFLOW_HIERARCHY_TOOLS.reports,
        arguments: { workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, runId: f.f.run.id, workflowNodeId: 'build', limit: 2 } })
      expect(same.result?.isError, JSON.stringify(same)).not.toBe(true)
      expect(WorkflowReportsPageSchema.parse(graphRpcValue(same.result))).toEqual(first)
      const items = [...first.items]
      let page = first
      while (page.nextCursor) {
        page = await reads.reports({ workflowNodeId: 'build', limit: '2', cursor: page.nextCursor })
        expect(page.revision).toBe(first.revision)
        expect(page.items.length).toBeLessThanOrEqual(2)
        items.push(...page.items)
      }
      expect(new Set(items.map(report => report.id)).size).toBe(items.length)
      const returns = items.filter(report => report.state === 'returned')
      expect(returns).toHaveLength(3)
      expect(new Set(returns.map(report => report.parentRequestId)).size).toBe(3)
      expect(new Set(returns.map(report => report.execution.executionId)).size).toBe(3)
      expect(items.every(report => report.agent.workflowNodeId === 'build' && report.execution.runId === f.f.run.id
        && report.execution.workflowVersionId === f.f.version.id)).toBe(true)
      const wrongNode = await f.app.inject({ method: 'GET', url: `${reads.base}/reports?${new URLSearchParams({
        runId: f.f.run.id, workflowNodeId: 'test', limit: '2', cursor: first.nextCursor!,
      })}`, headers: graphHeaders(f.writer.token) })
      expect(wrongNode.statusCode).toBe(400)
      expect(await reads.reports({ workflowNodeId: 'build', limit: '2' })).toEqual(first)
    } finally { await f.close() }
  }, 60_000)
})
