import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunActivity } from '@foreman-code/contracts'
import { RunEventsPageSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  makeCurrentWorkflowFixture, WorkActivationInputSchema, type WorkActivationInput,
} from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { deferred } from './helpers/deferred.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

function expectSerializedCoder(events: RunActivity[], nodeId: string) {
  const active = new Set<string>()
  for (const event of events) {
    const queued = event.kind === 'work_activation_queued' && event.payload.workflowNodeId === nodeId
      || event.kind === 'work_requester_reactivated' && event.payload.requesterNodeId === nodeId
    if (queued) active.add(String(event.payload.activationId))
    if (event.kind === 'work_result_accepted' && event.payload.workflowNodeId === nodeId) {
      active.delete(String(event.payload.activationId))
    }
    expect(active.size, `Active coder activations at persisted event ${event.sequence}`).toBeLessThanOrEqual(1)
  }
  return active.size
}

describe.runIf(postgresEnabled)('return continuations across review rounds', () => {
  it('serializes one coder node and drains waiting feedback from both requester activations together', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
    const [coder, early, late, other] = fixture.version.definition.nodes
    if (!coder || !early || !late || !other) throw new Error('Four agent nodes are required')
    const deepLate = { id: 'deep-late-review', name: 'Deep late review', agentId: late.agentId }
    const deepOther = { id: 'deep-other-review', name: 'Deep other review', agentId: other.agentId }
    delete other.join
    fixture.version.definition.nodes.push(deepLate, deepOther)
    fixture.version.definition.handoffs = { contractVersion: 1 }
    fixture.version.definition.executionPolicy = { maxParallelism: 6, maxNodeExecutions: 16 }
    fixture.version.definition.edges = [
      ...[early, late, other].map(node => ({
        id: `coder-${node.id}`, kind: 'execution' as const, source: coder.id, target: node.id,
      })),
      { id: 'late-deep', kind: 'execution', source: late.id, target: deepLate.id },
      { id: 'other-deep', kind: 'execution', source: other.id, target: deepOther.id },
    ]
    const heldEntered = deferred()
    const releaseHeld = deferred()
    const coderEntered = deferred()
    const releaseCoder = deferred()
    const feedback: WorkActivationInput[] = []
    let held = 0
    let coderTurns = 0
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], workerParallelism: 6,
      preparePlacementExecution: async (_owner, _run, execution) => {
        const input = WorkActivationInputSchema.parse(execution.input)
        const secondRound = input.work.kind === 'work_request' && input.work.request.ordinal === 2
        const otherReturn = execution.workflowNodeId === other.id && input.work.kind === 'work_return'
        if (secondRound || otherReturn) {
          held++
          if (held === 4) heldEntered.resolve()
          await releaseHeld.promise
        }
        if (execution.workflowNodeId === coder.id && input.work.kind === 'work_return' && coderTurns >= 2) {
          coderEntered.resolve()
          await releaseCoder.promise
        }
        return undefined
      },
      outputFor: (nodeId, request) => {
        const input = WorkActivationInputSchema.parse(request.input)
        const received = input.work.kind === 'work_request' ? input.work.request : input.parentRequest
        if (nodeId === coder.id) {
          coderTurns++
          if (input.work.kind === 'work_return') feedback.push(input)
          return { routing: { kind: 'finish' }, data: { latestDeliverable: { revision: coderTurns },
            remainingFindings: coderTurns > 2 ? ['Further review findings remain'] : [] } }
        }
        const delegates = (nodeId === late.id || nodeId === other.id)
          && input.work.kind === 'work_request' && input.work.request.ordinal === 1
        if (delegates) return { routing: { kind: 'finish' },
          data: { latestDeliverable: { nodeId, round: 1 }, remainingFindings: [] } }
        if (!received) throw new Error('Review feedback requires its received request')
        return { routing: { kind: 'return', requestId: received.requestId, outcome: 'needs_changes' },
          data: { latestDeliverable: { nodeId, round: received.ordinal }, remainingFindings: [`finding-${nodeId}`] } }
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
        throw new Error(`The run settled before both review rounds overlapped: ${String(failure)}`)
      })])
      await expect.poll(async () => (await events()).filter(event => event.kind === 'work_requester_reactivated'
        && event.payload.requesterNodeId === coder.id).length, { timeout: 15_000 }).toBe(2)
      expect(expectSerializedCoder(await events(), coder.id)).toBe(1)
      releaseHeld.resolve()
      await Promise.race([coderEntered.promise, drive.then(() => {
        throw new Error(`The run settled before the next coder activation: ${String(failure)}`)
      })])
      await expect.poll(async () => (await events()).filter(event => event.kind === 'work_handoff_returned').length,
        { timeout: 15_000 }).toBe(8)
      const overlapping = await events()
      expect(expectSerializedCoder(overlapping, coder.id)).toBe(1)
      expect(overlapping.filter(event => event.kind === 'work_requester_reactivated'
        && event.payload.requesterNodeId === coder.id)).toHaveLength(2)
      const executing = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
        .filter(execution => execution.workflowNodeId === coder.id && execution.state !== 'completed')
      expect(executing).toHaveLength(1)
      releaseCoder.resolve()
      await drive
      expect(failure).toBeUndefined()
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
      expect(coderTurns).toBe(4)
      expect(feedback).toHaveLength(3)
      const returns = feedback.flatMap(input => {
        if (input.work.kind !== 'work_return') throw new Error('Expected a coder return continuation')
        return input.work.returns!.map(item => item.returned)
      })
      expect(returns).toHaveLength(6)
      expect(new Set(returns.map(returned => returned.returnId)).size).toBe(6)
      expect(returns.map(returned => returned.latestDeliverable)).toEqual(expect.arrayContaining([
        { nodeId: early.id, round: 1 }, { nodeId: late.id, round: 1 }, { nodeId: other.id, round: 1 },
        { nodeId: early.id, round: 2 }, { nodeId: late.id, round: 2 }, { nodeId: other.id, round: 2 },
      ]))
      const last = feedback[2]!.work
      if (last.kind !== 'work_return') throw new Error('Expected the waiting feedback to drain together')
      expect(last.returns).toHaveLength(4)
      expect(new Set(last.returns!.map(item => item.returned.requesterActivationId)).size).toBe(2)
      const persisted = await events()
      expect(expectSerializedCoder(persisted, coder.id)).toBe(0)
      const coderRequests = persisted.filter(event => event.kind === 'work_handoff_accepted'
        && event.payload.requesterNodeId === coder.id).map(event => String(event.payload.requestId))
      expect(returns.map(returned => returned.requestId).sort()).toEqual(coderRequests.sort())
      const starts = f.provider.counts.starts
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(starts)
      expect(await events()).toEqual(persisted)
    } finally {
      releaseHeld.resolve()
      releaseCoder.resolve()
      await drive
      await f.close()
    }
  }, 60_000)
})
