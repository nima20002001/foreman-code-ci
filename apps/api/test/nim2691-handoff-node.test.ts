import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema, WorkRequestSchema } from '@foreman-code/contracts/wave25'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { workHandoffNodeAction } from '../src/modules/runs/workHandoffNode.js'
import { DomainError } from '../src/modules/errors.js'

describe('NIM-2691 workflow activation routing', () => {
  it('fans a finished entry result to both saved connections once', async () => {
    const fixture = makeCurrentWorkflowFixture('work-node-fork', 'parallel')
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
    } })
    const source = version.definition.nodes[0]!
    if (source.kind === 'job') throw new Error('Agent-only fixture unexpectedly contains a Job')
    const execution = HarnessExecutionSchema.parse({ id: 'execution-entry', runId: fixture.run.id,
      workflowNodeId: source.id, agentId: source.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[source.agentId],
      attempt: 1, input: {}, state: 'completed', createdAt: fixture.createdAt,
      finishedAt: fixture.createdAt, result: { outcome: 'succeeded', output: {
        routing: { kind: 'finish' }, data: { latestDeliverable: { artifact: 'a' }, remainingFindings: [] },
      } },
    })
    const calls: string[] = []
    const store = {
      resolveWaitingWorkJoins: async () => [],
      admitWorkActivation: async () => ({ execution, reused: true }),
      acceptWorkTerminal: async () => ({ kind: 'accepted' as const, execution, replayed: true }),
      admitWorkRequest: async (_executionId: string, relationshipId: string) => {
        calls.push(relationshipId)
        const edge = version.definition.edges.find((item) => item.id === relationshipId)!
        const request = WorkRequestSchema.parse({ scope: fixture.scope, requestId: `request-${relationshipId}`,
          relationshipId, requesterActivationId: 'activation-entry', requesterExecutionId: execution.id,
          destinationActivationId: `activation-${relationshipId}`, requesterNodeId: edge.source,
          destinationNodeId: edge.target, payloadDigest: `sha256:${'0'.repeat(64)}`,
          acceptedAt: fixture.createdAt, ordinal: 1 })
        return { kind: 'accepted' as const, request, replayed: false, destinationReady: true }
      },
      returnWork: async () => { throw new Error('A finish cannot return work') },
    }
    const action = workHandoffNodeAction({ version, store: store as never,
      driver: { candidate: () => { throw new Error('Replay allocated a native attempt') }, observe: async () => undefined },
      limiter: new ExecutionLimiter(2, 10), signal: new AbortController().signal })
    const next = await action('activation-entry')
    expect(calls.sort()).toEqual(version.definition.edges.filter((edge) => edge.source === source.id).map((edge) => edge.id).sort())
    expect(new Set(next)).toEqual(new Set(calls.map((id) => `activation-${id}`)))
  })

  it('waits for the node\'s running interval check before admitting its activation', async () => {
    const fixture = makeCurrentWorkflowFixture('work-node-check')
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 3 },
    } })
    const node = version.definition.nodes.at(-1)!
    if (node.kind === 'job') throw new Error('Agent-only fixture unexpectedly contains a Job')
    const execution = HarnessExecutionSchema.parse({ id: 'execution-after-check', runId: fixture.run.id,
      workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
      attempt: 1, input: {}, state: 'completed', createdAt: fixture.createdAt, finishedAt: fixture.createdAt,
      result: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
        data: { latestDeliverable: { artifact: 'a' }, remainingFindings: [] } } } })
    let admissions = 0
    const store = {
      resolveWaitingWorkJoins: async () => [],
      admitWorkActivation: async () => {
        if (++admissions === 1) throw new DomainError('INTERVAL_CHECK_RUNNING', 'The node\'s interval check is still running.', 409)
        return { execution, reused: false }
      },
      acceptWorkTerminal: async () => ({ kind: 'accepted' as const, execution, replayed: false }),
      admitWorkRequest: async () => { throw new Error('A finish without routes requests no work') },
      returnWork: async () => { throw new Error('A finish cannot return work') },
      recordWorkUnresolved: async () => { throw new Error('No findings remain') },
    }
    const action = workHandoffNodeAction({ version, store: store as never,
      driver: { candidate: () => { throw new Error('Allocated outside admission') }, observe: async () => undefined },
      limiter: new ExecutionLimiter(1, 10), signal: new AbortController().signal })
    await action('activation-entry')
    expect(admissions).toBe(2)
  })

  it('keeps a technical retry in one activation before admitting its first business request', async () => {
    const fixture = makeCurrentWorkflowFixture('work-node-retry')
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 3 },
    } })
    const node = version.definition.nodes[0]!, edge = version.definition.edges[0]!
    if (node.kind === 'job') throw new Error('Agent-only fixture unexpectedly contains a Job')
    const base = { runId: fixture.run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
      input: {}, createdAt: fixture.createdAt, finishedAt: fixture.createdAt,
      state: 'completed' as const }
    const first = HarnessExecutionSchema.parse({ ...base, id: 'execution-retry-1', attempt: 1,
      result: { outcome: 'failed', error: { code: 'TRANSIENT', message: 'A retryable native failure.', retryable: true } } })
    const second = HarnessExecutionSchema.parse({ ...base, id: 'execution-retry-2', attempt: 2,
      result: { outcome: 'succeeded', output: { routing: { kind: 'finish' },
        data: { latestDeliverable: { revision: 2 }, remainingFindings: [] } } } })
    const observed: string[] = [], attempts: number[] = [], requests: string[] = []
    let terminalCalls = 0
    const store = {
      resolveWaitingWorkJoins: async () => [],
      admitWorkActivation: async () => ({ execution: first, reused: true }),
      acceptWorkTerminal: async (_id: string, candidate: (attempt: number) => unknown) => {
        terminalCalls++
        if (terminalCalls === 1) {
          candidate(2)
          return { kind: 'retry' as const, execution: second }
        }
        return { kind: 'accepted' as const, execution: second, replayed: false }
      },
      admitWorkRequest: async (executionId: string) => {
        requests.push(executionId)
        return { kind: 'accepted' as const, replayed: false, destinationReady: true,
          request: WorkRequestSchema.parse({ scope: fixture.scope, requestId: 'request-after-retry',
            relationshipId: edge.id, requesterActivationId: 'activation-entry',
            requesterExecutionId: executionId, destinationActivationId: 'activation-next',
            requesterNodeId: node.id, destinationNodeId: edge.target,
            payloadDigest: `sha256:${'0'.repeat(64)}`, acceptedAt: fixture.createdAt, ordinal: 1 }) }
      },
      returnWork: async () => { throw new Error('A finish cannot return work') },
    }
    const action = workHandoffNodeAction({ version, store: store as never,
      driver: { candidate: (_ref, attempt) => {
        attempts.push(attempt)
        return HarnessExecutionSchema.parse({ ...base, id: 'queued-retry', attempt,
          state: 'queued', result: undefined, finishedAt: undefined })
      }, observe: async (execution) => { observed.push(execution.id) } },
      limiter: new ExecutionLimiter(1, 10), signal: new AbortController().signal })
    expect(await action('activation-entry')).toEqual(['activation-next'])
    expect(observed).toEqual([first.id, second.id])
    expect(attempts).toEqual([2])
    expect(requests).toEqual([second.id])
  })

  it.each((['entry', 'limit_denial'] as const).flatMap((cause) =>
    [false, true].map((restart) => ({ cause, restart }))))(
    'finishes a choice activation cleanly after $cause (restart=$restart)', async ({ cause, restart }) => {
      const fixture = makeCurrentWorkflowFixture(`choice-finish-${cause}`)
      const edge = fixture.version.definition.edges[0]!
      const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
        ...fixture.version.definition, handoffs: { contractVersion: 1 },
        nodes: fixture.version.definition.nodes.map((node, index) => index ? node : { ...node,
          choice: { outcomes: [{ outcome: 'review', target: { kind: 'edge', relationshipId: edge.id } }] },
        }),
      } })
      const node = version.definition.nodes[0]!
      if (node.kind === 'job') throw new Error('Agent fixture required')
      const execution = HarnessExecutionSchema.parse({ id: `finish-${cause}`, runId: fixture.run.id,
        workflowNodeId: node.id, agentId: node.agentId,
        agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
        attempt: 1, input: { work: { kind: cause } }, state: 'completed', createdAt: fixture.createdAt,
        finishedAt: fixture.createdAt, result: { outcome: 'succeeded', output: {
          routing: { kind: 'finish' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
        } },
      })
      let accepted = false
      const store = {
        resolveWaitingWorkJoins: async () => [],
        admitWorkActivation: async () => ({ execution, reused: true }),
        acceptWorkTerminal: async () => {
          const replayed = accepted
          accepted = true
          return { kind: 'accepted' as const, execution, replayed }
        },
        admitWorkRequest: async () => { throw new Error('A clean finish must not select a route') },
        returnWork: async () => { throw new Error('A finish must not return work') },
        recordWorkUnresolved: async () => { throw new Error('A clean finish has no findings') },
      }
      const action = () => workHandoffNodeAction({ version, store,
        driver: { candidate: () => { throw new Error('An accepted execution must not restart') },
          observe: async () => undefined },
        limiter: new ExecutionLimiter(1, 10), signal: new AbortController().signal })
      if (restart) await store.acceptWorkTerminal()
      expect(await action()('activation')).toEqual([])
      // A new action instance replays the terminal finish without allocating work.
      expect(await action()('activation')).toEqual([])
    },
  )

  it('preserves findings as unresolved when a requester finishes without choosing a route', async () => {
    const fixture = makeCurrentWorkflowFixture('work-node-needs-direction')
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      nodes: fixture.version.definition.nodes.map((node, index) => index === 0 ? { ...node,
        choice: { outcomes: [{ outcome: 'review', target: { kind: 'edge' as const,
          relationshipId: fixture.version.definition.edges[0]!.id } }] } } : node),
    } })
    const node = version.definition.nodes[0]!
    if (node.kind === 'job') throw new Error('Agent-only fixture unexpectedly contains a Job')
    const execution = HarnessExecutionSchema.parse({ id: 'execution-with-findings', runId: fixture.run.id,
      workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
      attempt: 1, input: {}, state: 'completed', createdAt: fixture.createdAt,
      finishedAt: fixture.createdAt, result: { outcome: 'succeeded', output: {
        routing: { kind: 'finish' },
        data: { latestDeliverable: { revision: 3 }, remainingFindings: [{ id: 'open-review' }] },
      } },
    })
    const unresolved: string[] = []
    const store = {
      resolveWaitingWorkJoins: async () => [],
      admitWorkActivation: async () => ({ execution, reused: true }),
      acceptWorkTerminal: async () => ({ kind: 'accepted' as const, execution, replayed: true }),
      admitWorkRequest: async () => { throw new Error('Finishing with findings must not launch another destination.') },
      returnWork: async () => { throw new Error('A finish cannot return work.') },
      recordWorkUnresolved: async (executionId: string) => {
        unresolved.push(executionId)
        return { unresolvedId: 'open-work', replayed: false }
      },
    }
    const action = workHandoffNodeAction({ version, store: store as never,
      driver: { candidate: () => { throw new Error('Replay allocated a native attempt') },
        observe: async () => undefined },
      limiter: new ExecutionLimiter(1, 10), signal: new AbortController().signal })
    expect(await action('activation-entry')).toEqual([])
    expect(unresolved).toEqual([execution.id])
  })
})
