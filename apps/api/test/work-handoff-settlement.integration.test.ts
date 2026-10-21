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

describe.runIf(postgresEnabled)('handoff settlement and withheld feedback', () => {
  it('releases an accepted export when its pending sibling finishes into the same all-join', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
    const [coder, first, second, judge] = fixture.version.definition.nodes
    if (!coder || !first || !second || !judge) throw new Error('Four workflow nodes are required')
    fixture.version.definition.handoffs = { contractVersion: 1 }
    fixture.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: 4 }
    const entered = deferred()
    const release = deferred()
    const judgeInputs: WorkActivationInput[] = []
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], workerParallelism: 2,
      preparePlacementExecution: async (_owner, _run, execution) => {
        if (execution.workflowNodeId === second.id) {
          entered.resolve()
          await release.promise
        }
        return undefined
      },
      outputFor: (nodeId, request) => {
        const input = WorkActivationInputSchema.parse(request.input)
        if (nodeId === judge.id) judgeInputs.push(input)
        return { routing: nodeId === first.id && input.work.kind === 'work_request'
          ? { kind: 'return', requestId: input.work.request.requestId, outcome: 'accepted' }
          : { kind: 'finish' },
        data: { latestDeliverable: { nodeId }, remainingFindings: [] } }
      },
    })
    const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
    const events = async () => RunEventsPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
      name: 'run_events_list', arguments: { ...scope, limit: 500 },
    }))).items
    let failure: unknown
    const drive = f.engine.start(f.f.run.id).catch((error: unknown) => { failure = error })
    try {
      await Promise.race([entered.promise, drive.then(() => {
        throw new Error('The run settled before the pending reviewer was admitted')
      })])
      await expect.poll(async () => (await events()).filter(event => event.kind === 'work_handoff_returned').length,
        { timeout: 15_000 }).toBe(1)
      expect(judgeInputs).toHaveLength(0)
      release.resolve()
      await drive
      expect(failure).toBeUndefined()
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(judgeInputs).toHaveLength(1)
      const input = judgeInputs[0]!
      expect(input.work.kind).toBe('join')
      if (input.work.kind !== 'join') throw new Error('The judge requires both saved sources')
      expect(input.work.sources.map(source => source.request.requesterNodeId).sort())
        .toEqual([first.id, second.id].sort())
      expect(input.work.sources.map(source => source.acceptedSourceResult.output)).toEqual(expect.arrayContaining([
        expect.objectContaining({ routing: { kind: 'return', requestId: expect.any(String), outcome: 'accepted' } }),
        expect.objectContaining({ routing: { kind: 'finish' } }),
      ]))
      const persisted = await events()
      expect(persisted.filter(event => event.kind === 'work_handoff_accepted'
        && event.payload.destinationNodeId === judge.id)).toHaveLength(2)
      expect(persisted.filter(event => event.kind === 'work_requester_reactivated')).toHaveLength(0)
      const starts = f.provider.counts.starts
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(starts)
      expect(await events()).toEqual(persisted)
    } finally {
      release.resolve()
      await drive
      await f.close()
    }
  }, 60_000)

  it('delivers late descendant findings in a subsequent requester continuation', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
    const [coder, first, second, downstream] = fixture.version.definition.nodes
    if (!coder || !first || !second || !downstream) throw new Error('Four workflow nodes are required')
    fixture.version.definition.handoffs = { contractVersion: 1 }
    fixture.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: 7 }
    delete downstream.join
    fixture.version.definition.edges = [
      { id: 'coder-first', kind: 'execution', source: coder.id, target: first.id },
      { id: 'coder-second', kind: 'execution', source: coder.id, target: second.id },
      { id: 'second-downstream', kind: 'execution', source: second.id, target: downstream.id },
    ]
    const entered = deferred()
    const release = deferred()
    const feedback: WorkActivationInput[] = []
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], workerParallelism: 2,
      preparePlacementExecution: async (_owner, _run, execution) => {
        if (execution.workflowNodeId === downstream.id) {
          entered.resolve()
          await release.promise
        }
        return undefined
      },
      outputFor: (nodeId, request) => {
        const input = WorkActivationInputSchema.parse(request.input)
        if (nodeId === coder.id && input.work.kind === 'work_return') feedback.push(input)
        const returnsToCaller = nodeId === first.id || nodeId === downstream.id
          || nodeId === second.id && input.work.kind === 'work_return'
        const requestId = input.work.kind === 'work_request' ? input.work.request.requestId
          : input.parentRequest?.requestId
        if (returnsToCaller && !requestId) throw new Error('Reviewer feedback requires its received request ID')
        return { routing: returnsToCaller ? { kind: 'return', requestId: requestId!, outcome: 'needs_changes' }
          : { kind: 'finish' },
        data: { latestDeliverable: { nodeId }, remainingFindings: returnsToCaller
          || nodeId === coder.id && input.work.kind === 'work_return' ? [`finding-${nodeId}`] : [] } }
      },
    })
    const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
    const events = async () => RunEventsPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
      name: 'run_events_list', arguments: { ...scope, limit: 500 },
    }))).items
    let failure: unknown
    const drive = f.engine.start(f.f.run.id).catch((error: unknown) => { failure = error })
    try {
      await Promise.race([entered.promise, drive.then(() => {
        throw new Error('The run settled before the downstream review was admitted')
      })])
      await expect.poll(async () => (await events()).filter(event => event.kind === 'work_result_accepted'
        && event.payload.workflowNodeId === coder.id).length, { timeout: 15_000 }).toBe(2)
      expect(feedback).toHaveLength(1)
      const firstExecution = (await f.runs.listRepeatExecutions(f.f.run.id)).find(item =>
        item.execution.workflowNodeId === coder.id
        && WorkActivationInputSchema.parse(item.execution.input).work.kind === 'work_return')!.execution
      release.resolve()
      await drive
      expect(failure).toBeUndefined()
      expect(feedback).toHaveLength(2)
      const groups = feedback.map(input => {
        if (input.work.kind !== 'work_return') throw new Error('Expected correlated requester feedback')
        return input.work.returns!.map(item => item.returned.latestDeliverable)
      })
      expect(groups).toEqual([[{ nodeId: first.id }], [{ nodeId: second.id }]])
      expect((await events()).filter(event => event.kind === 'work_requester_reactivated'
        && event.payload.requesterNodeId === coder.id)).toHaveLength(2)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
      expect(await f.runs.getExecution(firstExecution.id)).toEqual(firstExecution)
      expect(new Set(feedback.map(input => input.work.activation.activationId)).size).toBe(2)
    } finally {
      release.resolve()
      await drive
      await f.close()
    }
  }, 60_000)
})
