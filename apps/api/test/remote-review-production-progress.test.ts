import { expect, it, vi } from 'vitest'
import { DurableInteractionSchema, HarnessExecutionSchema, NATIVE_INTERACTION_FIXTURES, ReviewJobSchema,
  withAdvancedDefaults } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { deliveredReview, reviewInProgress } from './helpers/remoteReviewProductionCases.js'
import { projectInteractionActivity } from '../src/modules/interactions/activityProjection.js'

it.each(['fixture-worker', 'runner-local'])(
  'observes remote review progress with workspace runner %s', async runnerId => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  try {
    const startedAt = performance.now()
    const elapsed = () => performance.now() - startedAt
    const seed = makeCurrentWorkflowFixture('remote-review-progress', 'approval')
    const executions = seed.identities.map(({ executionId, ...identity }) => ({
      ...identity, id: executionId, runId: seed.run.id, input: {}, createdAt: seed.createdAt,
    }))
    const reviewer = HarnessExecutionSchema.parse({ ...executions[0],
      state: 'completed', result: { outcome: 'succeeded' },
      nativeSessionId: 'review-session', startedAt: seed.createdAt, finishedAt: seed.createdAt,
    })
    const requester = HarnessExecutionSchema.parse({ ...executions[1],
      state: 'waiting', nativeSessionId: 'request-session',
      startedAt: seed.createdAt,
    })
    const interaction = DurableInteractionSchema.parse({ ...NATIVE_INTERACTION_FIXTURES.codex,
      runId: seed.run.id, executionId: requester.id, requestingAgentId: requester.agentId,
      nativeSessionId: requester.nativeSessionId, approval: seed.run.approval,
    })
    const job = ReviewJobSchema.parse({ id: 'review-job', interactionId: interaction.id,
      reviewerAgentId: reviewer.agentId, attempt: 1, state: 'acknowledged', provider: 'codex',
      nativeSessionId: reviewer.nativeSessionId, providerTurnOrMessageId: 'review-turn',
      correlationId: 'review-correlation', createdAt: seed.createdAt, updatedAt: seed.createdAt,
    })
    const location = { runnerId, rootPath: '/project', locationRevision: 1,
      identityHash: `sha256:${'a'.repeat(64)}` }
    const run = { ...seed.run, executionState: 'running', executionLocation: location }
    const details = async () => ({ run, executions: elapsed() >= 60_000 ? [reviewer] : [], activity: [] })
    const fixture = {
      version: seed.version, repositoryName: 'fixture/project',
      sourceManifest: { capturePolicy: 'git-tree-v1', git: { repository: 'fixture/project' } },
      profiles: seed.configurations.map(configuration => ({
        target: { applicationInstallationId: 'fixture-worker' },
        configuration: withAdvancedDefaults(configuration.harness),
      })),
      provider: { startupActivity: async () => [] }, start: async () => ({ run }), details,
      async value() {
        return { workspace: { id: seed.run.workspaceId, name: 'Fixture',
          repository: { provider: 'github', owner: 'fixture', name: 'project', defaultBranch: 'main' } },
        revision: 1, archivedAt: null, executionLocation: { runnerId, rootPath: location.rootPath },
        locationRevision: 1, locationValidation: { status: 'ready', checkedAt: seed.createdAt } }
      },
      reconcileReviews: async () => {}, pending: async () => elapsed() >= 120_000 ? [interaction] : [],
      subscribeNativeChanges: () => () => {},
      executions: async () => elapsed() >= 120_000 ? [reviewer, requester] : elapsed() >= 60_000 ? [reviewer] : [],
      db: { pool: { query: async (_query: string, parameters: string[]) => ({ rows: [{
        record: parameters[0] === seed.configurations[1]!.id ? seed.configurations[1] : job,
      }] }) } },
      registry: { snapshot: () => ({ launches: [reviewer, requester].map(execution => ({
        owner: `execution:${execution.id}`, lifecycle: 'active', guardian: {}, provider: {},
        boundary: { kind: 'cgroup-v2' },
      })) }) },
    } as unknown as Parameters<typeof reviewInProgress>[0]
    const result = reviewInProgress(fixture).then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(120_001)
    expect(await result).toMatchObject({ value: { interaction, job, reviewer, requester } })
  } finally {
    vi.useRealTimers()
  }
})

it('recovers native delivery after the reviewer accepts its decision and completes its turn', async () => {
  const pending = NATIVE_INTERACTION_FIXTURES.codex
  const option = pending.responseOptions.find(value => value.semantic === 'approve_once')!
  const time = '2026-10-01T00:00:00.000Z'
  let interaction = DurableInteractionSchema.parse({ ...pending, revision: 1,
    status: 'delivery_pending', deliveryState: 'pending', selectedOptionId: option.optionId,
    selectedSemantic: option.semantic, nativeResponse: { decision: 'accept' }, decidedAt: time, updatedAt: time,
  })
  let job = ReviewJobSchema.parse({ id: 'review-original', interactionId: interaction.id,
    reviewerAgentId: interaction.approval.designatedOrchestratorAgentId, attempt: 1, state: 'acknowledged',
    provider: 'codex', nativeSessionId: 'review-session', providerTurnOrMessageId: 'review-turn',
    correlationId: 'review-correlation', createdAt: time, acknowledgedAt: time, updatedAt: time,
  })
  const reconcileReviews = async () => {
    job = ReviewJobSchema.parse({ ...job, state: 'completed', completedAt: time })
  }
  const fixture = {
    provider: {
      calls: async () => [],
      async retryReview() {
        expect(job.state).toBe('completed')
        interaction = DurableInteractionSchema.parse({ ...interaction,
          status: 'delivered', deliveryState: 'delivered', deliveredAt: time,
        })
      },
    },
    reconcileReviews,
    async reconcile() {
      throw new Error('Application maintenance is unavailable.')
    },
    async value() { return { interaction, activity: projectInteractionActivity(interaction, {
      response: { authorized: false, qualified: false, usable: false, path: null },
      workerAcknowledgmentId: 'worker-acknowledgment',
    }) } },
    db: { pool: { query: async () => ({ rows: [{ record: job }] }) } },
  } as unknown as Parameters<typeof deliveredReview>[0]
  const completed = await deliveredReview(fixture, interaction.id)
  expect(completed.interaction).toEqual(interaction)
  expect(completed.interaction.deliveryState).toBe('delivered')
  expect(completed.job.state).toBe('completed')
  expect(completed.job.providerTurnOrMessageId).toBe('review-turn')
})

it.each(['acknowledged', 'completed'] as const)(
  'settles the reviewer before retrying native delivery from %s', async initialState => {
  const pending = NATIVE_INTERACTION_FIXTURES.codex
  const option = pending.responseOptions.find(value => value.semantic === 'approve_once')!
  const time = '2026-10-01T00:00:00.000Z'
  let interaction = DurableInteractionSchema.parse({ ...pending, revision: 1,
    status: 'delivery_pending', deliveryState: 'pending', selectedOptionId: option.optionId,
    selectedSemantic: option.semantic, nativeResponse: { decision: 'accept' }, decidedAt: time, updatedAt: time,
  })
  let job = ReviewJobSchema.parse({ id: 'review-original', interactionId: interaction.id,
    reviewerAgentId: interaction.approval.designatedOrchestratorAgentId, attempt: 1, state: initialState,
    provider: 'codex', nativeSessionId: 'review-session', providerTurnOrMessageId: 'review-turn',
    correlationId: 'review-correlation', createdAt: time, acknowledgedAt: time, updatedAt: time,
    ...(initialState === 'completed' ? { completedAt: time } : {}),
  })
  const retryDecision = vi.fn(async () => {
    if (job.state !== 'completed') throw new Error('The original review turn has not completed.')
    interaction = DurableInteractionSchema.parse({ ...interaction,
      status: 'delivered', deliveryState: 'delivered', deliveredAt: time,
    })
  })
  const fixture = {
    provider: { calls: async () => [], retryReview: retryDecision },
    async reconcileReviews() {
      job = ReviewJobSchema.parse({ ...job, state: 'completed', completedAt: time })
    },
    async reconcile() {
      throw new Error('Application maintenance is unavailable.')
    },
    async value() { return { interaction, activity: projectInteractionActivity(interaction, {
      response: { authorized: false, qualified: false, usable: false, path: null },
      workerAcknowledgmentId: 'worker-acknowledgment',
    }) } },
    db: { pool: { query: async () => ({ rows: [{ record: job }] }) } },
  } as unknown as Parameters<typeof deliveredReview>[0]

  const delivered = await deliveredReview(fixture, interaction.id)
  expect(delivered.interaction).toMatchObject({ id: pending.id, deliveryState: 'delivered' })
  expect(delivered.job).toMatchObject({
    id: 'review-original', state: 'completed', providerTurnOrMessageId: 'review-turn',
  })
  expect(retryDecision).toHaveBeenCalledOnce()
})
