import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunEventsPageSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  makeCurrentWorkflowFixture, WorkActivationInputSchema, type WorkActivationInput,
} from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { deferred } from './helpers/deferred.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

describe.runIf(postgresEnabled)('return continuation parent ancestry', () => {
  it('answers three independent callers after their shared node delegates, without overlapping continuations', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
    const [entry, first, second, third] = fixture.version.definition.nodes
    if (!entry || !first || !second || !third) throw new Error('Four agent nodes are required')
    delete third.join
    const worker = { id: 'shared-worker', name: 'Shared worker', agentId: third.agentId,
      choice: { outcomes: [{ outcome: 'review', target: { kind: 'edge' as const, relationshipId: 'worker-review' } }] } }
    const reviewer = { id: 'shared-reviewer', name: 'Shared reviewer', agentId: second.agentId }
    fixture.version.definition.nodes.push(worker, reviewer)
    fixture.version.definition.handoffs = { contractVersion: 1 }
    fixture.version.definition.executionPolicy = { maxParallelism: 3, maxNodeExecutions: 14 }
    fixture.version.definition.edges = [
      ...[first, second, third].flatMap(node => [
        { id: `entry-${node.id}`, kind: 'execution' as const, source: entry.id, target: node.id },
        { id: `${node.id}-worker`, kind: 'execution' as const, source: node.id, target: worker.id },
      ]),
      { id: 'worker-review', kind: 'execution', source: worker.id, target: reviewer.id },
    ]
    const heldEntered = deferred()
    const releaseSecond = deferred()
    const releaseThird = deferred()
    const continuations: WorkActivationInput[] = []
    let held = 0
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], workerParallelism: 3,
      preparePlacementExecution: async (_owner, _run, execution) => {
        const input = WorkActivationInputSchema.parse(execution.input)
        if (execution.workflowNodeId === reviewer.id && input.work.kind === 'work_request'
          && input.work.request.ordinal > 1) {
          held++
          if (held === 2) heldEntered.resolve()
          if (input.work.request.ordinal === 2) await releaseSecond.promise
          else await releaseThird.promise
        }
        return undefined
      },
      outputFor: (nodeId, request) => {
        const input = WorkActivationInputSchema.parse(request.input)
        if (nodeId === worker.id && input.work.kind === 'work_request') {
          return { routing: { kind: 'request', outcome: 'review' },
            data: { latestDeliverable: { callerRequestId: input.work.request.requestId }, remainingFindings: [] } }
        }
        if (nodeId === reviewer.id && input.work.kind === 'work_request') {
          return { routing: { kind: 'return', requestId: input.work.request.requestId, outcome: 'needs_changes' },
            data: { latestDeliverable: { reviewedRequestId: input.work.request.requestId },
              remainingFindings: [`finding-${input.work.request.requestId}`] } }
        }
        if (nodeId === worker.id && input.work.kind === 'work_return') {
          if (!input.parentRequest) throw new Error('A delegated return must preserve its original caller')
          continuations.push(input)
          return { routing: { kind: 'return', requestId: input.parentRequest.requestId, outcome: 'accepted' },
            data: { latestDeliverable: { callerRequestId: input.parentRequest.requestId }, remainingFindings: [] } }
        }
        return { routing: { kind: 'finish' }, data: { latestDeliverable: { nodeId }, remainingFindings: [] } }
      },
    })
    const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
    const events = async () => RunEventsPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
      name: 'run_events_list', arguments: { ...scope, limit: 500 },
    }))).items
    let failure: unknown
    const drive = f.engine.start(f.f.run.id).catch((error: unknown) => { failure = error })
    try {
      await Promise.race([heldEntered.promise, drive.then(() => {
        throw new Error(`The run settled before three delegated requests overlapped: ${String(failure)}`)
      })])
      await expect.poll(async () => (await events()).filter(event => event.kind === 'work_requester_reactivated'
        && event.payload.requesterNodeId === worker.id).length, { timeout: 15_000 }).toBe(1)
      releaseSecond.resolve()
      await expect.poll(async () => (await events()).filter(event => event.kind === 'work_handoff_returned'
        && event.payload.outcome === 'needs_changes').length, { timeout: 15_000 }).toBe(2)
      releaseThird.resolve()
      await drive
      expect(failure).toBeUndefined()
      const persisted = await events()
      const active = new Set<string>()
      for (const event of persisted) {
        if (event.kind === 'work_requester_reactivated' && event.payload.requesterNodeId === worker.id) {
          active.add(String(event.payload.activationId))
        }
        if (event.kind === 'work_result_accepted' && event.payload.workflowNodeId === worker.id) {
          active.delete(String(event.payload.activationId))
        }
        expect(active.size, `Active return continuations at event ${event.sequence}`).toBeLessThanOrEqual(1)
      }
      expect(active.size).toBe(0)
      const callerRequests = persisted.filter(event => event.kind === 'work_handoff_accepted'
        && event.payload.destinationNodeId === worker.id).map(event => String(event.payload.requestId)).sort()
      expect(callerRequests).toHaveLength(3)
      expect(continuations.map(input => input.parentRequest!.requestId).sort()).toEqual(callerRequests)
      expect(continuations).toHaveLength(3)
      const deliveredReturns: string[] = []
      for (const input of continuations) {
        if (input.work.kind !== 'work_return') throw new Error('Expected a correlated worker continuation')
        expect(input.work.returns).toHaveLength(1)
        deliveredReturns.push(...input.work.returns!.map(item => item.returned.returnId))
      }
      const reviewReturns = persisted.filter(event => event.kind === 'work_handoff_returned'
        && event.payload.outcome === 'needs_changes').map(event => String(event.payload.returnId)).sort()
      expect(deliveredReturns.sort()).toEqual(reviewReturns)
      expect(new Set(deliveredReturns).size).toBe(3)
      expect(persisted.filter(event => event.kind === 'work_handoff_returned' && event.payload.outcome === 'accepted')
        .map(event => String(event.payload.requestId)).sort()).toEqual(callerRequests)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const starts = f.provider.counts.starts
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(starts)
      expect(await events()).toEqual(persisted)
    } finally {
      releaseSecond.resolve()
      releaseThird.resolve()
      await drive
      await f.close()
    }
  }, 60_000)
})
