import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunEventsPageSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { deferred } from './helpers/deferred.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

describe.runIf(postgresEnabled)('requester fan-out returns', () => {
  const cases = [
    ['two change requests', ['needs_changes', 'needs_changes']],
    ['changes then acceptance', ['needs_changes', 'accepted']],
    ['acceptance then changes', ['accepted', 'needs_changes']],
    ['all accepted', ['accepted', 'accepted']],
    ['single reviewer', ['needs_changes']],
  ] as const

  it.each(cases)('settles %s before dispatching a single continuation or the judge', async (_name, outcomes) => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
    const [coder, correct, tests, judge] = fixture.version.definition.nodes
    if (!coder || !correct || !tests || !judge) throw new Error('Four workflow nodes are required')
    const reviewers = outcomes.length === 1 ? [correct] : [correct, tests]
    const needsChanges = outcomes.some(outcome => outcome === 'needs_changes')
    const hasJudge = reviewers.length > 1
    fixture.version.definition.handoffs = { contractVersion: 1 }
    fixture.version.definition.executionPolicy = { maxParallelism: 2,
      maxNodeExecutions: 1 + reviewers.length + (needsChanges ? 1 + reviewers.length : 0) + (hasJudge ? 1 : 0) }
    fixture.version.definition.nodes = [coder, ...reviewers, ...(hasJudge ? [judge] : [])]
    const agentIds = new Set(fixture.version.definition.nodes.map(node => node.agentId))
    fixture.configurations = fixture.configurations.filter(configuration => agentIds.has(configuration.agentId))
    fixture.version.agentConfigurationVersionIds = Object.fromEntries(fixture.configurations.map(configuration =>
      [configuration.agentId, configuration.id]))
    fixture.version.definition.edges = reviewers.flatMap(reviewer => [
      { id: `coder-${reviewer.id}`, kind: 'execution' as const, source: coder.id, target: reviewer.id },
      ...(hasJudge ? [{ id: `${reviewer.id}-judge`, kind: 'execution' as const,
        source: reviewer.id, target: judge.id }] : []),
    ])
    const release = deferred()
    const entered = deferred()
    let coderTurns = 0
    const continuationInputs: unknown[] = []
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], workerParallelism: 2,
      preparePlacementExecution: async (_owner, _run, execution) => {
        if (execution.workflowNodeId === tests.id && coderTurns === 1) {
          entered.resolve()
          await release.promise
        }
        return undefined
      },
      outputFor: (nodeId, request) => {
        const input = WorkActivationInputSchema.parse(request.input)
        if (nodeId === coder.id) {
          coderTurns++
          if (input.work.kind === 'work_return') continuationInputs.push(input)
        }
        const index = reviewers.findIndex(reviewer => reviewer.id === nodeId)
        const outcome = coderTurns === 1 && index >= 0 ? outcomes[index]! : 'accepted'
        return {
          routing: input.work.kind === 'work_request'
            ? { kind: 'return', requestId: input.work.request.requestId, outcome }
            : { kind: 'finish' },
          data: { latestDeliverable: { reviewer: nodeId, revision: coderTurns },
            remainingFindings: outcome === 'needs_changes' ? [`fix-${nodeId}`] : [] },
        }
      },
    })
    const scope = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
    const events = async () => RunEventsPageSchema.parse(decodeMcpToolResult(await f.client.callTool({
      name: 'run_events_list', arguments: { ...scope, limit: 500 },
    }))).items
    let failure: unknown
    const drive = f.engine.start(f.f.run.id).catch((error: unknown) => { failure = error })
    try {
      if (hasJudge) {
        await Promise.race([entered.promise, drive.then(() => {
          throw new Error('The run settled before the second reviewer was admitted')
        })])
        await expect.poll(async () => (await events()).filter(event => event.kind === 'work_handoff_returned').length,
          { timeout: 15_000 }).toBe(1)
        expect((await events()).filter(event => event.kind === 'work_requester_reactivated')).toHaveLength(0)
        expect(coderTurns).toBe(1)
        expect(f.provider.startedNodes).not.toContain(judge.id)
      }
      release.resolve()
      await drive
      expect(failure).toBeUndefined()
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const persistedEvents = await events()
      const returns = persistedEvents.filter(event => event.kind === 'work_handoff_returned')
      const wakes = persistedEvents.filter(event => event.kind === 'work_requester_reactivated')
      expect(wakes).toHaveLength(needsChanges ? 1 : 0)
      expect(coderTurns).toBe(needsChanges ? 2 : 1)
      expect(continuationInputs).toHaveLength(needsChanges ? 1 : 0)
      if (needsChanges) {
        const firstReturns = returns.slice(0, reviewers.length)
        expect(wakes[0]!.sequence).toBeGreaterThan(firstReturns.at(-1)!.sequence)
        const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
        const continuation = executions.find(execution => execution.workflowNodeId === coder.id
          && WorkActivationInputSchema.parse(execution.input).work.kind === 'work_return')
        expect(continuation?.input).toMatchObject({ work: { returns: expect.arrayContaining(
          firstReturns.map(event => expect.objectContaining({
            returned: expect.objectContaining({ returnId: event.payload.returnId,
              outcome: event.payload.outcome }),
            acceptedSourceResult: expect.objectContaining({ outcome: 'succeeded' }),
          }))),
        } })
        const feedback = (continuation?.input as { work: { returns: unknown[] } }).work.returns
        expect(feedback).toHaveLength(reviewers.length)
      }
      expect(f.provider.startedNodes.filter(id => id === judge.id)).toHaveLength(hasJudge ? 1 : 0)
      expect(returns).toHaveLength(reviewers.length * (needsChanges ? 2 : 1))
      for (const reviewer of reviewers) {
        const requests = persistedEvents.filter(event => event.kind === 'work_handoff_accepted'
          && event.payload.destinationNodeId === reviewer.id)
        expect(requests.map(event => event.payload.used)).toEqual(needsChanges ? [1, 2] : [1])
      }
      const before = f.provider.counts.starts
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(before)
      expect(await events()).toEqual(persistedEvents)
      const denied = await f.access.issue({ name: 'Unrelated run reader', audience: 'operator',
        grants: [{ actions: ['runs:read'], scope: { runIds: ['other-run'] } }] })
      await expectMcpAccessDenied((await f.connect(denied.token)).callTool({
        name: 'run_events_list', arguments: scope,
      }))
    } finally {
      release.resolve()
      await drive
      await f.close()
    }
  }, 60_000)

  it('releases returned feedback once a sibling fails, preserving the failure', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
    const [coder, correct, tests, judge] = fixture.version.definition.nodes
    if (!coder || !correct || !tests || !judge) throw new Error('Four workflow nodes are required')
    fixture.version.definition.handoffs = { contractVersion: 1 }
    fixture.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: 5 }
    fixture.version.definition.edges = [correct, tests, judge].map(node => ({
      id: `coder-${node.id}`, kind: 'execution', source: coder.id, target: node.id,
    }))
    delete judge.join
    // The third sibling finishes without feedback; the second fails before native launch.
    const release = deferred()
    const entered = deferred()
    const inputs: unknown[] = []
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], workerParallelism: 2,
      preparePlacementExecution: async (_owner, _run, execution) => {
        if (execution.workflowNodeId === tests.id) {
          entered.resolve()
          await release.promise
          throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Reviewer profile is unavailable.', 409)
        }
        return undefined
      },
      outputFor: (nodeId, request) => {
        const input = WorkActivationInputSchema.parse(request.input)
        if (nodeId === coder.id && input.work.kind === 'work_return') inputs.push(input)
        return { routing: nodeId === correct.id && input.work.kind === 'work_request'
          ? { kind: 'return', requestId: input.work.request.requestId, outcome: 'needs_changes' }
          : { kind: 'finish' },
        data: { latestDeliverable: { nodeId }, remainingFindings: nodeId === correct.id
          || input.work.kind === 'work_return' ? ['review is incomplete'] : [] } }
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
        throw new Error('The run settled before the sibling failure gate')
      })])
      await expect.poll(async () => (await events()).filter(event => event.kind === 'work_handoff_returned').length,
        { timeout: 15_000 }).toBe(1)
      expect((await events()).filter(event => event.kind === 'work_requester_reactivated')).toHaveLength(0)
      release.resolve()
      await drive
      expect(failure).toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect((await events()).filter(event => event.kind === 'work_requester_reactivated')).toHaveLength(1)
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({ work: {
        returns: [expect.objectContaining({ returned: expect.objectContaining({ outcome: 'needs_changes' }) })],
        failures: [expect.objectContaining({ request: expect.objectContaining({ destinationNodeId: tests.id }),
          result: expect.objectContaining({ outcome: 'failed', error: expect.objectContaining({
            code: 'HARNESS_PROFILE_UNAVAILABLE',
          }) }) })],
      } })
    } finally {
      release.resolve()
      await drive
      await f.close()
    }
  }, 60_000)
})
