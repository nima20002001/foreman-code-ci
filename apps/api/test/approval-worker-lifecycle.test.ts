import { DurableInteractionSchema } from '@foreman-code/contracts'
import type {
  AgentConfigurationVersion, AgentHarness, HarnessExecution, HarnessExecutionRequest,
  NativeHarnessEvent, NativeSessionReference,
} from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeLanes } from './helpers/nativeLanes.js'
import { reviewerFixture } from './helpers/reviewerAudit.js'

import { DEFAULT_WORKER_CREDENTIAL_TTL_MS, type IssuedWorkerCredential } from '../src/modules/access/workerCredentials.js'
import { WorkerLaunchCredentialService, type ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../src/modules/harnesses/port.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import type { WorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import type { RepeatNativeObservationStore } from '../src/modules/interactions/repeatObservation.js'
import { DomainError } from '../src/modules/errors.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'

const createdAt = '2026-09-16T00:00:00.000Z'

afterEach(() => vi.restoreAllMocks())

it('rejects unsupported Claude configuration before allocating worker fixture authority', () => {
  expect(() => fixture('claude')).toThrow('supports only Codex')
})

function fixture(harness: AgentHarness = 'codex', started = true) {
  if (harness === 'claude') throw new Error('Approval worker fixture supports only Codex')
  const configuration: AgentConfigurationVersion = {
    id: 'config-1', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1,
    prompt: {}, assignedSkills: [], contentHash: 'sha256:pinned', createdAt,
    harness: { harness, model: 'fixture', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' },
  }
  let execution: HarnessExecution = {
    id: 'execution-1', runId: 'run-1', workflowNodeId: 'node-1', agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1, input: {},
    state: started ? 'waiting' : 'starting', createdAt,
    workingDirectory: '/project', runtimeDirectory: '/runtime',
    ...(started ? { nativeSessionId: 'exact-native-session' } : {}),
  }
  const session = {
    harness, providerVersion: '0.154.0', nativeSessionId: 'exact-native-session',
  } satisfies NativeSessionReference
  const request: HarnessExecutionRequest = {
    executionId: execution.id, runId: execution.runId, workspaceId: configuration.workspaceId,
    workflowNodeId: execution.workflowNodeId, workingDirectory: '/project', runtimeDirectory: '/runtime',
    configuration, input: {},
  }
  const context = {
    harness, executionId: execution.id, agentId: configuration.agentId, workingDirectory: '/project', configuration,
    runId: execution.runId, attempt: execution.attempt, workflowRequest: request,
  }
  function manager() {
    return {
      harness,
      capabilities: vi.fn(async () => ({ providerVersion: session.providerVersion })),
      createSession: vi.fn(async (_input: NativeSessionStart) => { void _input; return session }),
      attachSession: vi.fn(async (reference: NativeSessionReference, _input: NativeSessionStart) => { void _input; return reference }),
      startTurn: vi.fn(async function* (): AsyncIterable<NativeHarnessEvent> {
        yield { sequence: 0, type: 'turn.completed', occurredAt: createdAt, payload: {} }
      }),
      pending: vi.fn(async () => undefined),
      history: vi.fn(async (): Promise<NativeHistory> => ({ events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } })),
      reconcile: vi.fn(async (_session: NativeSessionReference, correlationId: string): Promise<NativeHistory> => ({ events: [], pendingInteractions: [], correlationId, nativeTurnId: 'workflow-turn', terminalTurn: { correlationId, providerId: 'workflow-turn', result: { outcome: 'succeeded' } } })),
      cancel: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
    }
  }
  const managers: Array<ReturnType<typeof manager>> = []
  const resolver = new ExecutionScopedNativeSessionManagerResolver(() => {
    const instance = manager()
    managers.push(instance)
    return instance as unknown as NativeHarnessSessionManager
  })
  const issued: IssuedWorkerCredential[] = []
  const credentials = {
    prepare: vi.fn(async () => {
      const credential: IssuedWorkerCredential = {
        principalId: `principal-${issued.length + 1}`,
        environment: Object.freeze({
          agentId: configuration.agentId,
          variables: Object.freeze({ GRAPHQL_MCP_TOKEN: `token-${issued.length + 1}` }),
        }),
        expiresAt: new Date(Date.now() + DEFAULT_WORKER_CREDENTIAL_TTL_MS).toISOString(),
      }
      issued.push(credential)
      return { credential, detection: {} as never }
    }),
    renew: vi.fn<NonNullable<ExecutionCredentialProvider['renew']>>(
      async () => new Date(Date.now() + DEFAULT_WORKER_CREDENTIAL_TTL_MS).toISOString(),
    ),
    revoke: vi.fn(async () => undefined),
    revokeForExecution: vi.fn(async () => 1),
  }
  const budgets = {
    resume: vi.fn(async () => undefined), remaining: vi.fn(async () => 60_000),
    ensure: vi.fn(async () => undefined), assertActive: vi.fn(async () => undefined),
    beginWait: vi.fn(async () => undefined), finish: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
  }
  const runs = {
    getExecution: vi.fn(async () => execution),
    get: vi.fn(async () => ({ id: execution.runId, workspaceId: configuration.workspaceId })),
    getExecutionConfiguration: vi.fn(async () => configuration),
    ensureExecution: vi.fn(async () => ({ execution, created: !execution.nativeSessionId })),
    updateExecution: vi.fn(async (next: HarnessExecution) => { execution = next }),
    recordActivity: vi.fn(async () => undefined),
    appendNativeEvent: vi.fn(async () => undefined),
    appendNativeEvents: vi.fn(async () => undefined),
  }
  const pendingApproval = DurableInteractionSchema.parse({
    id: 'worker-pending', revision: 0, workspaceId: configuration.workspaceId, workflowId: 'workflow-1',
    runId: execution.runId, executionId: execution.id, requestingAgentId: configuration.agentId,
    ...session, nativeRequestId: 'worker-request', nativeRequestType: 'approval', graphThreadId: execution.runId,
    request: { command: 'unit-only' }, approval: { handler: 'user' },
    responseOptions: [{ optionId: 'approve', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt, updatedAt: createdAt,
  })
  const interactions = { getNativeRequest: vi.fn(async (id: string, provider: AgentHarness, sessionId: string, requestId: string) => {
    expect([id, provider, sessionId, requestId]).toEqual([execution.id, harness, session.nativeSessionId, pendingApproval.nativeRequestId])
    return pendingApproval
  }), cancelPendingForExecution: vi.fn(async () => undefined), coordination: nativeLanes(),
    assertOrchestratorConnection: async () => ({ orchestratorNodeId: 'node-reviewer' }), getForExecution: vi.fn(async () => undefined) }
  const capture = createWorkflowNativeCaptureChannel()
  let closed: Awaited<ReturnType<WorkflowClosureStore['read']>>
  const closures: WorkflowClosureStore = {
    async recoverDetached() { return undefined },
    async begin() { closed = undefined; return '1' },
    async record(execution, session, durableGeneration, check) { check(); closed = { execution, session, durableGeneration }; return closed },
    async read() { return closed },
    async recordDetached(_execution, _session, _generation, check) { check() },
    async recordUnbound(execution, durableGeneration, check) { check(); return { execution: { ...execution, workingDirectory: execution.workingDirectory!, runtimeDirectory: execution.runtimeDirectory! }, durableGeneration } },
    async readUnbound() { return undefined },
  }
  let launch = !started
  const store: RepeatNativeObservationStore = {
    async readExecution() { return { execution, ref: { nodeId: execution.workflowNodeId, occurrence: null }, slotId: 'worker-slot',
      input: { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [] },
      inputDigest: `sha256:${'1'.repeat(64)}`, accepted: false } },
    async assertExecutionAdmission() {}, async assertNativeBoundary() {},
    async exactSession() { return session }, async authorizeNativeSubmission() {},
    consumeLaunch() { const available = launch; launch = false; return available },
    async settleNativeExecution() { if (!closed) throw new DomainError('REPEAT_CLEANUP_PENDING', 'Original close required', 409) },
  }
  const coordinator = new ApprovalExecutionCoordinator(runs as never, interactions as never, budgets as never, resolver, 60_000, credentials,
    undefined, closures, undefined, capture.capture)
  const observe = () => coordinator.observeExact({
    execution, store, request, approval: { handler: 'user' }, workflowId: 'workflow-1', graphThreadId: execution.runId,
    owner: { runId: execution.runId, client: {}, assertOwned() {} } as never, signal: new AbortController().signal,
  })
  // Establish the original owner-scoped observation before exercising resident
  // control/renewal. This runs the real coordinator, writer and lease checks;
  // a saved nativeSessionId alone must never be used as a residence fixture.
  const observeRequester = async () => {
    await interactions.coordination.ensureLane({
      id: `lane-${execution.id}`, harness, nativeSessionId: session.nativeSessionId,
      ownerAgentId: execution.agentId, observedStatus: 'busy', connectionGeneration: 0,
      correlationId: `execution:${execution.id}`, currentTurnOrMessageId: 'workflow-turn',
      observedAt: createdAt, revision: 1,
    })
    resolver.resolve(context)
    const raw = managers[0]!
    raw.reconcile.mockResolvedValueOnce({ events: [], correlationId: `execution:${execution.id}`, nativeTurnId: 'workflow-turn',
      pendingInteractions: [{ session, turn: { nativeTurnId: 'workflow-turn', nativeRequestId: pendingApproval.nativeRequestId },
        nativeRequestType: pendingApproval.nativeRequestType, request: pendingApproval.request, responseOptions: pendingApproval.responseOptions }] })
    const result = await observe()
    expect(result.state).toBe('waiting')
    expect(resolver.resolve(context).processState).toBe('resident')
    expect(raw.createSession).not.toHaveBeenCalled()
    expect(raw.startTurn).not.toHaveBeenCalled()
    return result
  }
  return { configuration, context, session, resolver, managers, coordinator, credentials, issued, budgets, runs, observe, observeRequester }
}

it('does not mistake allocation or startup for residency, and fences stale handles', () => {
  const f = fixture()
  const first = f.resolver.resolve(f.context)
  expect(first.lifecycle).toBe('allocated')
  expect(f.resolver.resolve(f.context).processState).toBe('needs_start')
  expect(() => first.markResident!()).toThrow('unstarted')
  first.beginStart!()
  expect(first.lifecycle).toBe('starting')
  expect(f.resolver.resolve(f.context).processState).toBe('needs_start')
  expect(() => first.beginStart!()).toThrow('already starting')
  first.markResident!()
  expect(f.resolver.resolve(f.context).processState).toBe('resident')
  f.resolver.release(f.context, first.manager)
  expect(first.lifecycle).toBe('released')
  const second = f.resolver.resolve(f.context)
  f.resolver.release(f.context, first.manager, 'failed')
  expect(f.resolver.resolve(f.context)).toBe(second)
  expect(() => first.markResident!()).toThrow('released')
})

it('rejects changed Run ownership, configuration and accepted input while retaining the original manager', () => {
  const f = fixture()
  const original = f.resolver.resolve(f.context)
  const contexts = [
    { ...f.context, runId: 'other-run' },
    { ...f.context, configuration: { ...f.configuration, prompt: { system: 'Changed instructions' } } },
    { ...f.context, workflowRequest: { ...f.context.workflowRequest, input: { changed: true } } },
    { ...f.context, workflowRequest: { ...f.context.workflowRequest,
      systemPrompt: { value: { text: 'Changed prompt' }, revision: 1, versionId: 'prompt-version' } } },
  ]
  for (const context of contexts) {
    expect(() => f.resolver.resolve(context)).toThrow('cannot change native manager ownership context')
  }
  expect(f.resolver.resolve(f.context)).toBe(original)
  expect(f.managers).toHaveLength(1)
  expect(f.credentials.prepare).not.toHaveBeenCalled()
})

it('rejects a cold requester before preflight and never allocates a replacement lifetime', async () => {
  const f = fixture()
  const first = f.resolver.resolve(f.context)
  f.credentials.prepare.mockRejectedValueOnce(new Error('preflight must not run'))
  for (let replay = 0; replay < 2; replay++) {
    await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toMatchObject({ code: 'NATIVE_SESSION_RECOVERY_REQUIRED' })
  }
  expect(first.lifecycle).toBe('allocated')
  expect(f.credentials.prepare).not.toHaveBeenCalled()
  expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
  expect(f.managers).toHaveLength(1)
  expect(f.managers[0]!.attachSession).not.toHaveBeenCalled()
  expect(f.managers[0]!.createSession).not.toHaveBeenCalled()
  expect(f.managers[0]!.startTurn).not.toHaveBeenCalled()
})

for (const started of [false, true]) {
  it(`preserves uncertain credential preflight in observeExact (${started ? 'recovery' : 'first start'})`, async () => {
    const f = fixture('codex', started)
    // An uncoded runtime error is transient and abandons the attempt; a rejected preflight is preserved.
    f.credentials.prepare.mockRejectedValueOnce(new DomainError('CREDENTIAL_PREFLIGHT_REJECTED', 'preflight failed', 409))
    await expect(f.observe()).rejects.toThrow('preflight failed')
    expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
    const failed = f.managers[0]!
    expect(failed.createSession).not.toHaveBeenCalled()
    expect(failed.attachSession).not.toHaveBeenCalled()
    expect((await f.runs.getExecution()).state).toBe(started ? 'waiting' : 'starting')
    expect(f.managers).toHaveLength(1)
    expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  })
}

it('revokes resident credentials after attachment failure without preparing another environment', async () => {
  const f = fixture()
  await f.observeRequester()
  const resident = f.resolver.resolve(f.context)
  f.managers[0]!.history.mockRejectedValueOnce(new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'attachment failed', 409))
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('attachment failed')
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  expect(f.credentials.revokeForExecution).toHaveBeenCalledWith(f.context.executionId)
  expect(f.managers[0]!.close).toHaveBeenCalledWith(f.session, expect.any(AbortSignal))
  expect(resident.lifecycle).toBe('failed')
})

for (const harness of ['codex'] as const) {
  it(`renews ${harness} before credential expiry without changing its process, environment, or native identity`, async () => {
    const f = fixture(harness)
    await f.observeRequester()
    const credential = f.issued[0]!
    const originalExpiry = credential.expiresAt
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(originalExpiry) - 30_000)
    await f.coordinator.attachOwnedSession(f.context, f.session)
    await f.coordinator.attachOwnedSession(f.context, f.session)
    expect(f.credentials.renew).toHaveBeenCalledTimes(1)
    expect(f.credentials.renew).toHaveBeenCalledWith(
      f.context.executionId,
      expect.objectContaining({ principalId: credential.principalId }),
      expect.any(AbortSignal),
    )
    expect(f.credentials.renew.mock.calls[0]![2]?.aborted).toBe(false)
    expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
    expect(f.managers).toHaveLength(1)
    const manager = f.managers[0]!
    expect(manager.attachSession.mock.calls[0]![1].environment).toBe(credential.environment)
    expect(manager.attachSession).toHaveBeenCalledTimes(1)
    expect(manager.history).toHaveBeenCalledTimes(2)
    expect(credential.expiresAt).toBe(originalExpiry)
    for (const [reference] of manager.attachSession.mock.calls) expect(reference).toBe(f.session)
    expect(manager.createSession).not.toHaveBeenCalled()
    expect(manager.startTurn).not.toHaveBeenCalled()
    expect(manager.close).not.toHaveBeenCalled()
  })
}

it('fails closed when renewal is refused rather than replacing a paused native process', async () => {
  const f = fixture()
  await f.observeRequester()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.issued[0]!.expiresAt) - 30_000)
  f.credentials.renew.mockRejectedValueOnce(new DomainError('WORKER_CREDENTIAL_NOT_RENEWABLE', 'revoked credential', 409))
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('revoked credential')
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  expect(f.managers[0]!.attachSession).toHaveBeenCalledTimes(1)
  expect(f.managers[0]!.createSession).not.toHaveBeenCalled()
  expect(f.credentials.revokeForExecution).toHaveBeenCalledWith(f.context.executionId)
})

it('rejects an expired resident credential even when same-token renewal is available', async () => {
  const f = fixture()
  await f.observeRequester()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.issued[0]!.expiresAt) + 1)
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('cannot be renewed')
  expect(f.credentials.renew).not.toHaveBeenCalled()
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  expect(f.managers[0]!.createSession).not.toHaveBeenCalled()
  expect(f.managers[0]!.startTurn).not.toHaveBeenCalled()
  // The uncoded refusal is transient: the paused process is left to the retry and Run recovery.
  expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
})

it('never rotates a paused process when a provider has no same-token renewal support', async () => {
  const f = fixture()
  // Exercise the optional provider seam without changing an active process environment.
  Reflect.deleteProperty(f.credentials, 'renew')
  await f.observeRequester()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.issued[0]!.expiresAt) + 1)
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('cannot be renewed')
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  expect(f.managers).toHaveLength(1)
  expect(f.managers[0]!.createSession).not.toHaveBeenCalled()
  expect(f.managers[0]!.startTurn).not.toHaveBeenCalled()
  expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
})

it('cannot replace the captured native manager through a bare resolver release', async () => {
  const f = fixture()
  await f.observeRequester()
  const old = f.managers[0]!
  await old.close()
  f.resolver.release(f.context, old as unknown as NativeHarnessSessionManager)
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('no exact manager owner')
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  expect(f.managers[1]!.attachSession).not.toHaveBeenCalled()
  expect(f.managers[1]!.createSession).not.toHaveBeenCalled()
  expect(f.managers[1]!.startTurn).not.toHaveBeenCalled()
})

it('does not start a reviewer process with an expired prepared credential', async () => {
  const f = await reviewerFixture()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.credential.expiresAt) + 1)
  await expect(f.attach()).rejects.toThrow('not live')
  expect(f.prepared).toEqual(['reviewer'])
  expect(f.attaches).toEqual([])
  expect(f.starts).toEqual([])
  expect(f.revoked).not.toContain(`execution:${f.execution.id}`)
})

it('a concurrent startup loser does not revoke the winning startup credentials', async () => {
  const f = fixture()
  const prepared = await f.credentials.prepare()
  f.credentials.prepare.mockClear()
  let unblock!: () => void
  let announce!: () => void
  const started = new Promise<void>((resolve) => { announce = resolve })
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  f.credentials.prepare.mockImplementationOnce(async () => { announce(); await gate; return prepared })
  const first = f.observeRequester()
  await Promise.race([started, first.then(() => { throw new Error('Startup completed before the preflight barrier') })])
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('already starting')
    }
    expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
    expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
    expect(f.managers[0]!.attachSession).not.toHaveBeenCalled()
  } finally {
    unblock()
    await first
  }
  expect(f.resolver.resolve(f.context).lifecycle).toBe('resident')
})

it('preserves the original credential environment when another requester competes during preparation', async () => {
  const f = fixture()
  const prepared = await f.credentials.prepare()
  f.credentials.prepare.mockClear()
  let announce!: () => void
  let unblock!: () => void
  const preparing = new Promise<void>(resolve => { announce = resolve })
  const gate = new Promise<void>(resolve => { unblock = resolve })
  f.credentials.prepare.mockImplementationOnce(async () => {
    announce()
    await gate
    return prepared
  })
  const first = f.observeRequester()
  await Promise.race([preparing, first.then(() => { throw new Error('Preparation did not reach the barrier') })])
  try {
    await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('already starting')
    expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
    expect(f.credentials.revokeForExecution).not.toHaveBeenCalled()
  } finally {
    unblock()
    await first
  }
  expect(f.managers[0]!.attachSession).toHaveBeenCalledTimes(1)
  expect(f.managers[0]!.attachSession.mock.calls[0]![1].environment).toBe(prepared.credential.environment)
})

it('fences reuse until failed resident cleanup finishes', async () => {
  const f = fixture()
  await f.observeRequester()
  let unblock!: () => void
  let announce!: () => void
  const closing = new Promise<void>((resolve) => { announce = resolve })
  const gate = new Promise<void>((resolve) => { unblock = resolve })
  f.managers[0]!.history.mockRejectedValueOnce(new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'attachment failed', 409))
  f.managers[0]!.close.mockImplementationOnce(async () => { announce(); await gate })
  const failed = expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('attachment failed')
  await closing
  await expect(f.coordinator.attachOwnedSession(f.context, f.session)).rejects.toThrow('being released')
  expect(f.credentials.prepare).toHaveBeenCalledTimes(1)
  unblock()
  await failed
  expect(f.resolver.resolve(f.context).lifecycle).toBe('allocated')
})

it('finalizes newly terminal work and reuses the persisted finish time before any active-time assertion', async () => {
  const f = fixture('codex', false)
  const first = await f.observe()
  expect(first.state).toBe('completed')
  const activeChecks = f.budgets.assertActive.mock.calls.length
  expect(f.budgets.finish).toHaveBeenCalledWith(f.context.executionId, first.execution.finishedAt)
  f.budgets.assertActive.mockRejectedValue(new Error('must not re-check a completed execution'))
  const replay = await f.observe()
  expect(replay).toEqual(first)
  expect(f.budgets.assertActive).toHaveBeenCalledTimes(activeChecks)
  expect(f.budgets.finish).toHaveBeenLastCalledWith(f.context.executionId, first.execution.finishedAt)
  expect(f.managers).toHaveLength(1)
  expect(f.managers[0]!.createSession).toHaveBeenCalledTimes(1)
  expect(f.managers[0]!.startTurn).toHaveBeenCalledTimes(1)
})

it('retains the terminal lifetime until budget finalization succeeds, without replay', async () => {
  const f = fixture('codex', false)
  f.budgets.finish.mockRejectedValueOnce(new Error('accounting unavailable'))
  await expect(f.observe()).rejects.toThrow('accounting unavailable')
  expect(f.credentials.revoke).not.toHaveBeenCalled()
  expect(f.managers[0]!.close).not.toHaveBeenCalled()
  const persisted = await f.runs.getExecution()
  expect(persisted.state).toBe('completed')
  await f.observe()
  expect(f.budgets.finish).toHaveBeenLastCalledWith(f.context.executionId, persisted.finishedAt)
  expect(f.managers).toHaveLength(1)
  expect(f.managers[0]!.startTurn).toHaveBeenCalledTimes(1)
  // A finalized workflow replay cannot revoke a subsequently issued review credential.
  expect(f.managers[0]!.close).toHaveBeenCalledWith(f.session, expect.any(AbortSignal))
  const revoked = f.credentials.revoke.mock.calls.length
  await expect(f.observe()).resolves.toMatchObject({ state: 'completed' })
  expect(f.credentials.revoke).toHaveBeenCalledTimes(revoked)
})

it('revokes superseded credentials only after preflight and before a new process credential is issued', async () => {
  const order: string[] = []
  const detection = { preflight: async () => { order.push('preflight'); return {} } }
  const credentials = {
    revokeForExecution: async () => { order.push('revoke'); return 1 },
    issueForExecution: async () => { order.push('issue'); return {} },
  }
  const launch = new WorkerLaunchCredentialService(detection as never, credentials as never, 'runner-1')
  await launch.prepare({ executionId: 'execution-1', harness: 'codex', workingDirectory: '/project' })
  expect(order).toEqual(['preflight', 'revoke', 'issue'])
})

it('revokes a credential issued while the launch signal was being aborted', async () => {
  const controller = new AbortController()
  const credential = { principalId: 'aborted-start' }
  const credentials = {
    revokeForExecution: vi.fn(async () => 1),
    issueForExecution: vi.fn(async () => { controller.abort(); return credential }),
    revoke: vi.fn(async () => undefined),
  }
  const launch = new WorkerLaunchCredentialService({ preflight: async () => ({}) } as never, credentials as never, 'runner-1')
  await expect(launch.prepare({
    executionId: 'execution-1', harness: 'codex', workingDirectory: '/project', signal: controller.signal,
  })).rejects.toThrow()
  expect(credentials.revoke).toHaveBeenCalledWith(credential)
})
