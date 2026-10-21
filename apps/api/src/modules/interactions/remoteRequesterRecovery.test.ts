import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DurableInteractionSchema,
  type DurableInteraction,
  HarnessExecutionSchema,
  ReviewJobSchema,
  type PendingNativeInteraction,
} from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { DomainError } from '../errors.js'
import type { RunOwnership } from '../runs/ownership.js'
import { openWorkflowLifecycleLocked } from '../runs/repeatLifecycle.js'
import { repeatDigest, repeatExecutionIdentity } from '../runs/repeatResolution.js'
import { nativeLanes } from '../../../test/helpers/nativeLanes.js'
import { idleWorkflowControls } from '../../../test/helpers/idleWorkflowControls.js'
import { ApprovalExecutionCoordinator } from './execution.js'
import { createWorkflowNativeCaptureChannel } from './workflowNativeCapture.js'
import type { RepeatNativeObservationStore } from './repeatObservation.js'
import { assertSavedPendingApprovalOriginalLocked } from './nativeApprovalProof.js'
import { readDetachedWorkflowSession, readRemoteWorkflowContinuation } from './workflowClosure.js'

vi.mock('./workflowClosure.js', async importOriginal => ({
  ...await importOriginal<typeof import('./workflowClosure.js')>(),
  readDetachedWorkflowSession: vi.fn(),
  readRemoteWorkflowContinuation: vi.fn(),
}))
vi.mock('./nativeApprovalProof.js', async importOriginal => ({
  ...await importOriginal<typeof import('./nativeApprovalProof.js')>(),
  assertSavedPendingApprovalOriginalLocked: vi.fn(),
}))
vi.mock('../runs/repeatLifecycle.js', async importOriginal => ({
  ...await importOriginal<typeof import('../runs/repeatLifecycle.js')>(),
  openWorkflowLifecycleLocked: vi.fn(),
}))

beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.useRealTimers())

type SavedAnswer = Pick<DurableInteraction, 'status' | 'deliveryState'>

async function recoverRequester(detached: boolean, state: 'waiting' | 'running' = 'waiting',
  options: { observeWithoutCleanup?: boolean; saved?: SavedAnswer[] } = {}) {
  const base = makeCurrentWorkflowFixture('requester-recovery', 'approval')
  base.run.executionState = 'waiting'
  const configuration = base.configurations[1]!
  let execution = HarnessExecutionSchema.parse({
    id: 'requester-execution', runId: base.run.id, workflowNodeId: base.version.definition.nodes[1]!.id,
    agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
    attempt: 1, state, createdAt: base.createdAt, input: {},
    nativeSessionId: 'requester-session', workingDirectory: '/project', runtimeDirectory: '/runtime',
  })
  const session = { harness: 'codex' as const, providerVersion: 'synthetic', nativeSessionId: execution.nativeSessionId! }
  const interaction = DurableInteractionSchema.parse({
    id: 'pending-approval', revision: 0, workspaceId: base.run.workspaceId, workflowId: base.run.workflowId,
    runId: base.run.id, executionId: execution.id, requestingAgentId: execution.agentId, ...session,
    graphThreadId: base.run.id, graphInterruptId: 'saved-interrupt',
    nativeRequestId: 'original-request', nativeRequestType: 'item/commandExecution/requestApproval',
    request: { command: 'synthetic' }, approval: base.run.approval,
    status: 'pending', deliveryState: 'not_started',
    responseOptions: [{ optionId: 'approve', semantic: 'approve_once', label: 'Approve once',
      persistence: 'request', affectsOtherPendingRequests: false,
      interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    createdAt: base.createdAt, updatedAt: base.createdAt,
  })
  const original: PendingNativeInteraction = {
    session, turn: { nativeTurnId: 'original-turn', nativeRequestId: interaction.nativeRequestId },
    nativeRequestType: interaction.nativeRequestType, request: interaction.request,
    responseOptions: interaction.responseOptions,
  }
  const saved = options.saved ?? [{ status: 'pending', deliveryState: 'not_started' }]
  const interactions = saved.map((answer, index) => index === 0 ? { ...interaction, ...answer } : {
    ...interaction, ...answer, id: `pending-approval-${index}`, nativeRequestId: `original-request-${index}` })
  const originals = interactions.map(item => ({ ...original, turn: { ...original.turn, nativeRequestId: item.nativeRequestId } }))
  // Native dispatch consumes only answers whose delivery began.
  const history = { events: [], pendingInteractions: originals.filter((_, index) =>
    ['not_started', 'pending', 'failed'].includes(interactions[index]!.deliveryState)) }
  const continuation = { session, generation: '1', principalId: 'original-principal', detached }
  vi.mocked(readDetachedWorkflowSession).mockResolvedValue(detached ? session : undefined)
  vi.mocked(readRemoteWorkflowContinuation).mockImplementation(async () => structuredClone(continuation))
  vi.mocked(openWorkflowLifecycleLocked).mockResolvedValue({} as Awaited<ReturnType<typeof openWorkflowLifecycleLocked>>)
  vi.mocked(assertSavedPendingApprovalOriginalLocked).mockResolvedValue({
    proofId: 'original-approval-proof', scope: base.scope,
    ref: { nodeId: execution.workflowNodeId, occurrence: null },
    execution: repeatExecutionIdentity(execution), inputDigest: repeatDigest(execution.input),
    commandId: `execution:${execution.id}`, session,
    original: { type: 'history', history: { events: [], pendingInteractions: originals } },
    observedAt: base.createdAt, ownerId: 'original-owner', ownerFence: '1',
    lifetimeGeneration: 1, closureGeneration: continuation.generation,
    lane: { id: 'original-lane', token: 'original-lane-token', connectionGeneration: 1,
      providerId: original.turn.nativeTurnId! },
  })
  const releaseRetention = vi.fn(async () => {})
  const owner = {
    runId: base.run.id, assertOwned: vi.fn(), retain: vi.fn(() => releaseRetention), release: vi.fn(async () => {}),
    oneShotConnection: () => ({ transaction: async (work: (sql: unknown) => Promise<unknown>) => work({}) }),
  } as unknown as RunOwnership
  const acquireOwnership = vi.fn(async (): Promise<RunOwnership | undefined> => undefined)
  const requestCleanup = vi.fn(async () => {})
  const attach = vi.fn(async () => session)
  const create = vi.fn(async () => { throw new Error('A saved remote session cannot be replaced') })
  const startTurn = vi.fn(() => { throw new Error('A saved remote turn cannot be replayed') })
  const respond = vi.fn(async () => { throw new Error('Cold restoration cannot resend a native response') })
  const manager = {
    harness: 'codex', attachSession: attach, createSession: create, startTurn, respond, reconcile: async () => history,
    originalApplicationAccess: async () => ({ token: 'synthetic-token' }),
    closeForRestart: async () => {},
  }
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const review = ReviewJobSchema.parse({
    id: 'original-review-job', interactionId: interaction.id, reviewerAgentId: base.configurations[0]!.agentId,
    attempt: 1, state: 'pending', provider: session.harness, nativeSessionId: 'reviewer-session',
    correlationId: 'original-review-turn', createdAt: base.createdAt, updatedAt: base.createdAt,
  })
  const coordination = Object.assign(nativeLanes(), { findReviewJob: async () => review })
  const captures = createWorkflowNativeCaptureChannel()
  const restore = vi.fn(async () => ({ principalId: continuation.principalId,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    environment: { agentId: execution.agentId, variables: {} } }))
  const begin = vi.fn(async () => {
    continuation.generation = '2'
    continuation.detached = false
    return continuation.generation
  })
  const beginWait = vi.fn(async () => {})
  let resident = false
  const coordinator = new ApprovalExecutionCoordinator({
    ...idleWorkflowControls,
    getExecution: async () => execution, getExecutionConfiguration: async () => configuration,
    getRepeatVersion: async () => base.version, get: async () => base.run,
    getRepeatSnapshot: async () => ({ run: base.run, stopRequested: false, cleanupPending: false }),
    async *executionPages() { yield [execution] }, acquireOwnership, requestCleanup,
    updateExecution: async (next: typeof execution) => { execution = next },
  } as unknown as Args[0], {
    coordination, getForExecution: async () => undefined, getNativeRequest: async () => interaction,
    assertOrchestratorConnection: async () => ({ orchestratorNodeId: base.version.definition.nodes[0]!.id }),
  } as unknown as Args[1], {
    ensure: async () => {}, resume: async () => {}, remaining: async () => 60_000,
    assertActive: async () => {}, beginWait,
  } as unknown as Args[2], {
    resolve: () => ({ manager, get processState() { return resident ? 'resident' : 'needs_start' },
      markResident() { resident = true } }),
  } as unknown as Args[3], 60_000, {
    restore,
  } as unknown as Args[5], undefined, {
    begin,
    recordDetached: async () => {},
  } as unknown as Args[7], undefined, captures.capture, undefined, undefined, undefined,
  async context => ({ ...context, acceptedPlacement: { hostRef: { kind: 'device' } } as
    NonNullable<typeof context.acceptedPlacement> }))
  const stopSharing = coordinator.shareRunOwner(owner)
  try {
    if (!options.observeWithoutCleanup) {
      expect(await coordinator.requestColdRunCleanup(owner, state === 'running' ? [] : interactions)).toBe(false)
      expect(requestCleanup).not.toHaveBeenCalled()
    }
  } finally {
    stopSharing()
  }
  const observeOriginal = () => coordinator.observeExact({
    execution, owner, workflowId: base.run.workflowId, graphThreadId: base.run.id,
    approval: base.run.approval, signal: new AbortController().signal,
    request: { executionId: execution.id, runId: execution.runId, workspaceId: base.run.workspaceId,
      workflowNodeId: execution.workflowNodeId, configuration, workingDirectory: execution.workingDirectory!,
      runtimeDirectory: execution.runtimeDirectory!, input: execution.input },
    store: {
      readExecution: async () => ({ execution, input: execution.input, inputDigest: repeatDigest(execution.input),
        accepted: false, ref: { nodeId: execution.workflowNodeId, occurrence: null }, slotId: 'original-slot' }),
      assertExecutionAdmission: async () => {}, assertNativeBoundary: async () => {}, exactSession: async () => session,
    } as unknown as RepeatNativeObservationStore,
  })
  return { coordinator, interaction, owner, acquireOwnership, attach, releaseRetention, coordination,
    observeOriginal, begin, restore, continuation, create, startTurn, respond, beginWait, requestCleanup,
    completeExecution: () => { execution = { ...execution, state: 'completed' } } }
}

it.each([
  ['decided', [{ status: 'delivery_pending', deliveryState: 'pending' }]],
  ['submitted', [{ status: 'delivery_pending', deliveryState: 'submitted' }]],
  ['delivered', [{ status: 'delivered', deliveryState: 'delivered' }]],
  ['mixed', [{ status: 'delivered', deliveryState: 'delivered' }, { status: 'pending', deliveryState: 'not_started' }]],
] as const)('keeps the original remote session when Main restarts after a %s answer', async (_name, saved) => {
  const f = await recoverRequester(false, 'waiting', { saved: saved.map(item => ({ ...item })) })
  try {
    expect(f.requestCleanup).not.toHaveBeenCalled()
    expect(f.attach).toHaveBeenCalledOnce()
    expect(f.restore).toHaveBeenCalledOnce()
    expect(f.respond).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.startTurn).not.toHaveBeenCalled()
  } finally {
    await f.coordinator.closeForRestart()
  }
})

it('keeps a live remote turn without a graceful detachment receipt after Main loses its owner', async () => {
  const f = await recoverRequester(false, 'running')
  try {
    expect(f.attach).not.toHaveBeenCalled()
    expect(readRemoteWorkflowContinuation).toHaveBeenCalledWith(f.owner, expect.objectContaining({ state: 'running' }))
  } finally {
    await f.coordinator.closeForRestart()
  }
})

it('observes the original running remote lifetime without reserving another generation or replaying its turn', async () => {
  const f = await recoverRequester(false, 'running', { observeWithoutCleanup: true })
  try {
    expect(await f.observeOriginal()).toMatchObject({ state: 'waiting', execution: { nativeSessionId: 'requester-session' } })
    expect(f.begin).not.toHaveBeenCalled()
    expect(f.continuation.generation).toBe('1')
    expect(f.restore).toHaveBeenCalledOnce()
    expect(f.attach).toHaveBeenCalledOnce()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.startTurn).not.toHaveBeenCalled()
  } finally {
    await f.coordinator.closeForRestart()
  }
})

it.each(['running', 'waiting'] as const)(
  'preserves the cold original %s remote session during another restart without allocating a manager', async state => {
    const f = await recoverRequester(false, state, { observeWithoutCleanup: true })
    try {
      expect(await f.coordinator.preserveActiveForRestart(f.owner)).toBe(true)
      expect(f.beginWait).toHaveBeenCalledWith(f.interaction.executionId)
      expect(f.requestCleanup).not.toHaveBeenCalled()
      expect(f.begin).not.toHaveBeenCalled()
      expect(f.attach).not.toHaveBeenCalled()
      expect(f.restore).not.toHaveBeenCalled()
      expect(f.continuation.generation).toBe('1')
      expect(f.create).not.toHaveBeenCalled()
      expect(f.startTurn).not.toHaveBeenCalled()
      expect(f.coordinator.passiveOwnedNativeSessions()).toEqual([])
    } finally {
      await f.coordinator.closeForRestart()
    }
  },
)

it('skips an execution that completes between listing and waiting when preserving for restart', async () => {
  const f = await recoverRequester(false, 'running', { observeWithoutCleanup: true })
  try {
    f.beginWait.mockImplementationOnce(async () => {
      f.completeExecution()
      throw new DomainError('EXECUTION_NOT_WAITABLE', 'The execution is terminal or has no active-time budget.', 409)
    })
    await expect(f.coordinator.preserveActiveForRestart(f.owner)).resolves.toBe(false)
    expect(f.beginWait).toHaveBeenCalledWith(f.interaction.executionId)
  } finally {
    await f.coordinator.closeForRestart()
  }
})

it('still fails restart preservation when a still-running execution cannot begin waiting', async () => {
  const f = await recoverRequester(false, 'running', { observeWithoutCleanup: true })
  try {
    f.beginWait.mockRejectedValueOnce(new DomainError('EXECUTION_NOT_WAITABLE', 'has no active-time budget.', 409))
    await expect(f.coordinator.preserveActiveForRestart(f.owner)).rejects.toMatchObject({ code: 'EXECUTION_NOT_WAITABLE' })
  } finally {
    await f.coordinator.closeForRestart()
  }
})

it('waits for the orphaned Main writer before observing the original remote turn', async () => {
  vi.useFakeTimers()
  const f = await recoverRequester(false, 'running', { observeWithoutCleanup: true })
  await f.coordination.ensureLane({
    id: 'original-remote-lane', harness: 'codex', nativeSessionId: f.interaction.nativeSessionId,
    ownerAgentId: f.interaction.requestingAgentId, observedStatus: 'busy', connectionGeneration: 1,
    correlationId: `execution:${f.interaction.executionId}`, currentTurnOrMessageId: 'original-turn',
    leaseOwner: f.interaction.requestingAgentId, leaseToken: 'orphaned-main-writer',
    leaseExpiresAt: new Date(Date.now() + 500).toISOString(), observedAt: f.interaction.createdAt, revision: 1,
  })
  let settled = false
  const observed = f.observeOriginal().then(value => ({ value }), error => ({ error }))
    .finally(() => { settled = true })
  try {
    await vi.advanceTimersByTimeAsync(499)
    expect(settled).toBe(false)
    expect(f.attach).not.toHaveBeenCalled()
    expect(f.begin).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await observed).toMatchObject({ value: { state: 'waiting' } })
    expect(f.attach).toHaveBeenCalledOnce()
    expect(f.restore).toHaveBeenCalledOnce()
    expect(f.begin).not.toHaveBeenCalled()
    expect(f.continuation.generation).toBe('1')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.startTurn).not.toHaveBeenCalled()
  } finally {
    await f.coordinator.closeForRestart()
  }
})

it.each([false, true])('keeps the requester recovery owner for delivery after engine sharing ends (detached=%s)',
  async detached => {
    const f = await recoverRequester(detached)
    try {
      const deliver = vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted()
        return 'delivered'
      })
      expect(await f.coordinator.withInteractionOwner(f.interaction, new AbortController().signal, deliver))
        .toBe('delivered')
      expect(f.acquireOwnership).not.toHaveBeenCalled()
      expect(f.owner.retain).toHaveBeenCalledTimes(1)
      expect(f.releaseRetention).toHaveBeenCalledTimes(1)
      expect(f.attach).toHaveBeenCalledTimes(1)
      expect((await f.coordination.getLane('codex', f.interaction.nativeSessionId))?.leaseToken).toBeUndefined()
    } finally {
      await f.coordinator.closeForRestart()
    }
  },
)

it('rejects delivery when the recovered requester owner has been lost', async () => {
  const f = await recoverRequester(true)
  const assertOwned = vi.mocked(f.owner.assertOwned)
  assertOwned.mockImplementation(() => {
    throw new DomainError('RUN_OWNERSHIP_LOST', 'The saved owner disconnected.', 409)
  })
  try {
    const deliver = vi.fn(async () => 'delivered')
    await expect(f.coordinator.withInteractionOwner(f.interaction, new AbortController().signal, deliver))
      .rejects.toMatchObject({ code: 'SESSION_LANE_BUSY' })
    expect(f.acquireOwnership).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
  } finally {
    assertOwned.mockImplementation(() => {})
    await f.coordinator.closeForRestart()
  }
})
