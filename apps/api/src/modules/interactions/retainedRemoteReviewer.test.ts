import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { HarnessExecutionSchema, HarnessExecutionRequestSchema, ReviewJobSchema, type ReviewJob } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import { readExecutionPlacement } from '../placement/persistence.js'
import { remoteReviewerPolicy } from '../placement/remoteReviewerAuthority.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { finalizeRetainedRemoteReviewerLocked, readRecoverableRemoteReviewer,
  readRetainedRemoteReviewer } from './retainedRemoteReviewer.js'
import { ApprovalExecutionCoordinator } from './execution.js'
import type { RunOwnership } from '../runs/ownership.js'
import { RemoteNativeSessionManager } from '../runs/remote/nativeManagerProxy.js'
import { pageNativeHistory } from '../runs/remote/nativeHistoryPage.js'
import { nativeLanes } from '../../../test/helpers/nativeLanes.js'
import { DomainError } from '../errors.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { workflowExecutionRequest } from '../runs/workflowExecutionRequest.js'

vi.mock('../placement/persistence.js', () => ({ readExecutionPlacement: vi.fn() }))
vi.mock('../placement/remoteReviewerAuthority.js', () => ({
  remoteReviewerPolicy: vi.fn(), assertRemoteReviewerReceipt: vi.fn(async () => undefined),
}))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

// The placement/policy ports are validated fixtures. Session, original terminal,
// Worker grants and transactional retention use the production readers below.
function fixture() {
  const base = makeCurrentWorkflowFixture('reviewer-retention', 'approval')
  const node = base.version.definition.nodes.find(node => node.id === base.version.entryNodeId)!
  node.initialPrompt = 'Keep the saved workflow startup instructions.'
  const execution = HarnessExecutionSchema.parse({ id: 'execution', runId: base.run.id,
    workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: base.version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, state: 'completed', createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), nativeSessionId: 'original-session', result: { outcome: 'succeeded' }, input: {},
    workingDirectory: '/project', runtimeDirectory: '/runtime' })
  const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: execution.nativeSessionId! }
  const digest = 'a'.repeat(64)
  const intent = { schemaVersion: 1, protocolVersion: 1, mainId: randomUUID(), runId: execution.runId,
    nodeId: node.id, executionId: execution.id, occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: 'attempt', operationId: 'operation', bindingHash: digest, inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } }
  const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent,
    connection: { mainId: intent.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
      bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 },
    workerIncarnationId: randomUUID(), sequence: 1, phase: 'running', entryAttempted: true,
    turnEntryAttempted: true, stopFence: false, controls: [],
    native: { sessionId: session.nativeSessionId, turnId: 'original-turn', processIdentityDigest: digest },
    turnInput: { correlationId: `execution:${execution.id}`, promptDigest: digest },
    retainedReviewer: { agentId: execution.agentId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      workflowTurnId: 'original-turn', result: execution.result } })
  const placement = { hostRef: { kind: 'device' }, bindingHash: digest } as
    NonNullable<Awaited<ReturnType<typeof readExecutionPlacement>>>
  vi.mocked(readExecutionPlacement).mockResolvedValue(placement)
  vi.mocked(remoteReviewerPolicy).mockResolvedValue({ run: { ...base.run, executionState: 'running', outcome: 'pending' },
    version: base.version, configuration: base.configurations[0]!, execution, session, finalized: false })
  vi.mocked(readReconciledDispatchIntent).mockResolvedValue(receipt.intent)
  const state = { finalized: false, purpose: 'workflow', committed: false, revoked: false,
    terminal: true, lane: true, live: true, detached: false, closed: false,
    generation: '1', drift: false, lifetimeReads: 0, reviewJobs: [] as ReviewJob[] }
  const principal = { id: 'original-principal', name: 'Reviewer', audience: 'worker', agent_id: execution.agentId,
    expires_at: new Date(Date.now() + 60_000), revoked_at: null,
    grants: [{ actions: ['interactions:read', 'interactions:respond'],
      scope: { workspaceIds: [base.run.workspaceId], workflowIds: [base.run.workflowId], runIds: [base.run.id] } }] }
  let saved = { finalized: false, purpose: 'workflow' }
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length })
  const client = { async query(statement: string, values: unknown[] = []) {
    const text = statement.replace(/\s+/g, ' ').trim()
    if (text.startsWith('begin')) {
      saved = { finalized: state.finalized, purpose: state.purpose }
      return result([])
    }
    if (text === 'rollback') { Object.assign(state, saved); return result([]) }
    if (text === 'commit') { state.committed = true; return result([]) }
    if (text.startsWith('select r.receipt')) return result([{ receipt }])
    if (text.startsWith('select c.generation')) {
      state.lifetimeReads++
      return result([{ generation: state.drift && state.lifetimeReads > 1 ? '2' : state.generation,
        live: !state.closed && (values[2] === true || state.live && !state.detached),
        detached: state.detached, reference: session }])
    }
    if (text.startsWith('select 1 from workflow_native_proofs')) return result(state.terminal ? [{}] : [])
    if (text.startsWith('select b.principal_id')) return result(state.revoked ? [] : [{ principal_id: principal.id }])
    if (text.startsWith('select id,name,audience')) return result([principal])
    if (text.includes('from review_jobs where execution_id=$1')) {
      return result(state.reviewJobs.map(record => ({ record })))
    }
    if (text.startsWith('update execution_native_sessions')) {
      expect(values).toEqual([execution.id, JSON.stringify(session)])
      state.finalized = true
      return result([{ execution_id: execution.id }])
    }
    if (text.startsWith("select record->>'connectionGeneration'")) return result(state.lane ? [{ generation: '1' }] : [])
    if (text.includes('update worker_credential_bindings')) {
      expect(values).toEqual([principal.id, execution.id, execution.agentId, session.nativeSessionId, '1'])
      state.purpose = 'reviewer'
      return result([{}])
    }
    throw new Error('Unexpected retention query')
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(client, () => undefined)
  const retain = () => connection.transaction(sql => finalizeRetainedRemoteReviewerLocked(sql, execution))
  return { base, placement, session, execution, receipt, state, principal, connection, retain }
}

async function recoveryFixture(options: { handoff?: boolean } = {}) {
  const f = fixture()
  if (options.handoff) {
    f.base.version.definition.handoffs = { contractVersion: 1 }
    const input = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: {},
      occurrence: null, entry: null, predecessors: [], work: { kind: 'entry', activation: {
        scope: f.base.scope, activationId: 'original-activation', workflowNodeId: f.execution.workflowNodeId,
        lineageId: 'original-lineage', cause: { kind: 'entry' },
      } } })
    f.execution.input = HarnessExecutionSchema.shape.input.parse(input)
  }
  const coordination = nativeLanes()
  await coordination.bindWorkflowSession(f.execution.id, f.session)
  await coordination.finalizeWorkflowSession(f.execution.id)
  const owner = {
    runId: f.execution.runId, assertOwned() {}, oneShotConnection: () => f.connection,
    retain: () => async () => {}, release: async () => {},
  } as unknown as RunOwnership
  const acquireOwnership = vi.fn(async (): Promise<RunOwnership | undefined> => owner)
  const originalRequest = workflowExecutionRequest({ execution: f.execution, version: f.base.version,
    configuration: f.base.configurations[0]!, workspaceId: f.base.run.workspaceId,
    ...(options.handoff ? { executionContext: { parentRequest: null } } : {}) })
  const beforeReattach: (signal?: AbortSignal) => Promise<void> = async () => {}
  const worker = { receipt: structuredClone(f.receipt), authenticated: true, session: f.session,
    principalId: f.principal.id, beforeApplicationAccess: () => {},
    beforeReattach }
  const requests: string[] = []
  const proxies: RemoteNativeSessionManager[] = []
  const credentials = { bindReviewerJob: vi.fn(async (_executionId: string, _credential: unknown, job: ReviewJob) => {
    if (!f.state.live || f.state.detached) throw new Error('Worker recovery must refresh its receipt before binding a review job')
    if (!job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now()) {
      throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The review lease expired.', 409)
    }
  }), recoverRemote: vi.fn(async () => ({ principalId: worker.principalId,
    expiresAt: f.principal.expires_at.toISOString(),
    environment: { agentId: f.execution.agentId, variables: { GRAPHQL_MCP_TOKEN: 'original-token' } } })) }
  const closures = {
    begin: vi.fn(async () => {
      if (!f.state.detached) throw new Error('An open lifetime cannot be replaced')
      f.state.detached = false
      f.state.generation = String(Number(f.state.generation) + 1)
      return f.state.generation
    }),
    recordDetached: vi.fn(async () => { f.state.detached = true }),
  }
  const resident = vi.fn()
  const requestCleanup = vi.fn(async () => {})
  const coordinator = () => {
    const manager = new RemoteNativeSessionManager({ intent: f.receipt.intent, placement: f.placement,
      harness: 'codex', configuration: f.base.configurations[0]!,
      transport: { async request(method, raw, signal) {
        requests.push(method)
        if (!worker.authenticated) throw new Error('Authenticated Worker connection unavailable')
        const status = { status: 'known', receipt: structuredClone(worker.receipt) }
        if (method === 'reattach') {
          const request = HarnessExecutionRequestSchema.parse((raw as { request: unknown }).request)
          expect(request).toEqual(originalRequest)
          await worker.beforeReattach(signal)
          return { session: worker.session, status }
        }
        if (method === 'get-application-access') {
          worker.beforeApplicationAccess()
          return { status, applicationAccess: {
            kind: 'scoped-worker-mcp',
            executionId: f.execution.id, operationId: f.receipt.intent.operationId,
            attemptId: f.receipt.intent.attemptId, bindingHash: f.receipt.intent.bindingHash,
            agentId: f.execution.agentId, token: 'original-token',
          } }
        }
        if (method === 'history') return { ...pageNativeHistory({ events: [], pendingInteractions: [] }), status }
        throw new Error(`Unexpected recovery request: ${method}`)
      } },
      async observeReceipt(receipt) {
        Object.assign(f.receipt, structuredClone(receipt))
        f.state.live = Date.parse(receipt.retainedReviewer!.expiresAt) > Date.now()
      },
      controlFor: async () => { throw new Error('Recovery cannot start or stop native work') },
    })
    proxies.push(manager)
    type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
    return new ApprovalExecutionCoordinator({ getExecution: async () => f.execution,
      getExecutionConfiguration: async () => f.base.configurations[0],
      getRepeatVersion: async () => f.base.version,
      repeat: async () => ({ readWorkExecutionContext: async () => ({ parentRequest: null }) }),
      get: async () => ({ ...f.base.run, executionState: 'running', outcome: 'pending' }),
      getRepeatSnapshot: async () => ({ run: f.base.run, stopRequested: false, cleanupPending: false }),
      async *executionPages() { yield [f.execution] },
      requestCleanup,
      acquireOwnership,
    } as unknown as Args[0], { coordination } as Args[1], {} as Args[2],
    { resolve: () => ({ manager, processState: 'resident', markResident: resident }) }, 60_000,
    credentials as unknown as Args[5], undefined, closures as unknown as Args[7],
    undefined, undefined, undefined, undefined, undefined,
    async context => ({ ...context, acceptedPlacement: f.placement }))
  }
  const attach = (main: ApprovalExecutionCoordinator, job?: ReviewJob) => main.attachOwnedSession({
    executionId: f.execution.id, agentId: f.execution.agentId, harness: 'codex',
    workingDirectory: f.execution.workingDirectory!, purpose: 'reviewer',
    ...(job ? { reviewJob: job } : {}),
  }, f.session)
  return { ...f, worker, coordination, requests, proxies, originalRequest, credentials, closures, resident,
    owner, acquireOwnership, requestCleanup, coordinator, attach }
}

describe('atomic original remote reviewer retention', () => {
  it('retains the engine Run owner before a cold reviewer has a resident session', async () => {
    const f = await recoveryFixture()
    const main = f.coordinator()
    f.acquireOwnership.mockResolvedValue(undefined)
    const releaseReviewOwner = vi.fn(async () => {})
    const retain = vi.spyOn(f.owner, 'retain').mockReturnValue(releaseReviewOwner)
    const release = vi.spyOn(f.owner, 'release')
    const stopSharingOwner = main.shareRunOwner(f.owner)
    try {
      expect((await f.attach(main)).session).toEqual(f.session)
      expect(f.acquireOwnership).not.toHaveBeenCalled()
      expect(retain).toHaveBeenCalledTimes(1)
      expect(releaseReviewOwner).not.toHaveBeenCalled()
      stopSharingOwner()
      await main.releaseReviewSession(f.execution.id)
      expect(releaseReviewOwner).toHaveBeenCalledTimes(1)
      expect(release).not.toHaveBeenCalled()
      expect(f.credentials.recoverRemote).toHaveBeenCalledTimes(1)
      expect(f.requests).toEqual(['reattach', 'get-application-access'])
      await main.closeForRestart()
    } finally {
      stopSharingOwner()
      await f.connection.close()
    }
  })

  it.each(['finished', 'another Run', 'lost'] as const)(
    'does not reuse a shared engine owner from %s for cold reviewer recovery', async scope => {
      const f = await recoveryFixture()
      const main = f.coordinator()
      f.acquireOwnership.mockResolvedValue(undefined)
      let owner = f.owner
      if (scope === 'another Run') owner = { ...f.owner, runId: 'unrelated-run' } as RunOwnership
      const stopSharingOwner = main.shareRunOwner(owner)
      if (scope === 'finished') stopSharingOwner()
      if (scope === 'lost') vi.spyOn(owner, 'assertOwned').mockImplementation(() => {
        throw new DomainError('RUN_OWNERSHIP_LOST', 'The engine owner disconnected.', 409)
      })
      try {
        await expect(f.attach(main)).rejects.toMatchObject({ code: 'SESSION_LANE_BUSY' })
        expect(f.acquireOwnership).toHaveBeenCalledTimes(1)
        expect(f.requests).toEqual([])
        expect(f.credentials.recoverRemote).not.toHaveBeenCalled()
      } finally {
        stopSharingOwner()
        await f.connection.close()
      }
    },
  )

  it('commits finalized session and reviewer purpose together for the same Worker credential', async () => {
    const f = fixture()
    // Completed workflow-purpose credentials are ineligible until retention commits.
    expect(f.state.purpose).toBe('workflow')
    await f.retain()
    expect(f.state).toMatchObject({ finalized: true, purpose: 'reviewer', committed: true, revoked: false })
    expect(f.principal.id).toBe('original-principal')
    await f.connection.close()
  })
  it('keeps the original reviewer credential readable after repeated retention', async () => {
    const f = fixture()
    try {
      await f.retain()
      await f.retain()
      expect(await readRetainedRemoteReviewer(f.connection, f.execution)).toEqual({
        generation: '1', principalId: f.principal.id, session: f.session,
      })
      expect(f.state).toMatchObject({ finalized: true, purpose: 'reviewer', committed: true, revoked: false })
      f.state.revoked = true
      expect(await readRecoverableRemoteReviewer(f.connection, f.execution)).toBeUndefined()
      await expect(readRetainedRemoteReviewer(f.connection, f.execution))
        .rejects.toMatchObject({ code: 'REMOTE_REVIEWER_DENIED' })
    } finally {
      await f.connection.close()
    }
  })
  it.each(['revoked', 'terminal', 'lane', 'drift', 'readOnly'] as const)('rolls back retention on %s', async field => {
    const f = fixture()
    if (field === 'revoked') f.state.revoked = true
    if (field === 'terminal') f.state.terminal = false
    if (field === 'lane') f.state.lane = false
    if (field === 'drift') f.state.drift = true
    if (field === 'readOnly') f.principal.grants[0]!.actions = ['interactions:read']
    await expect(f.retain()).rejects.toMatchObject({ code: field === 'readOnly'
      ? 'REVIEWER_CREDENTIAL_LOST' : 'REMOTE_REVIEWER_DENIED' })
    expect(f.state).toMatchObject({ finalized: false, purpose: 'workflow', committed: false })
    await f.connection.close()
  })
  it('does not retain an original session whose physical lifetime ended', async () => {
    const f = fixture()
    f.state.live = false
    await f.retain()
    expect(f.state).toMatchObject({ finalized: false, purpose: 'workflow' })
    await f.connection.close()
  })
})

describe('retained remote reviewer recovery', () => {
  it.each(['attachment', 'application access', 'credential', 'review lease'] as const)(
    'retries a transient %s failure on the same original reviewer', async stage => {
      const f = await recoveryFixture()
      const main = f.coordinator()
      const original = structuredClone(f.execution)
      const failure = stage === 'review lease'
        ? new DomainError('REVIEW_JOB_LEASE_LOST', 'The review lease changed.', 409)
        : new DeviceApplicationError('timeout')
      let interrupted = true
      const failWhileInterrupted = () => {
        if (interrupted) throw failure
      }
      if (stage === 'attachment' || stage === 'review lease') {
        f.worker.beforeReattach = async () => failWhileInterrupted()
      }
      if (stage === 'application access') f.worker.beforeApplicationAccess = failWhileInterrupted
      if (stage === 'credential') f.credentials.recoverRemote.mockRejectedValueOnce(failure)
      try {
        await expect(f.attach(main)).rejects.toBe(failure)
        expect(f.resident).not.toHaveBeenCalled()
        interrupted = false
        const recovered = await f.attach(main)
        expect(recovered.session).toEqual(f.session)
        expect(f.execution).toEqual(original)
        expect(f.resident).toHaveBeenCalledOnce()
        expect(f.proxies).toHaveLength(1)
        expect(f.credentials.recoverRemote).toHaveBeenLastCalledWith(f.execution.id,
          expect.objectContaining({ token: 'original-token' }), undefined)
        expect(f.closures.begin).not.toHaveBeenCalled()
        expect(f.requests.every(method => ['reattach', 'get-application-access'].includes(method))).toBe(true)
        await main.releaseReviewSession(f.execution.id)
        await main.closeForRestart()
      } finally { await f.connection.close() }
    },
  )

  it('requests Run cleanup when the Worker closes the original reviewer during cold recovery', async () => {
    const f = await recoveryFixture()
    const original = structuredClone(f.execution)
    f.worker.receipt = RemoteOperationReceiptSchema.parse({ ...f.worker.receipt,
      sequence: f.worker.receipt.sequence + 1, phase: 'confirmed_terminal', stopFence: true,
      terminal: { kind: 'cancelled', closureEvidenceDigest: 'b'.repeat(64) },
    })
    try {
      const main = f.coordinator()
      await expect(main.requestColdRunCleanup(f.owner)).resolves.toBe(true)
      expect(f.requestCleanup).toHaveBeenCalledWith(f.owner.runId, f.owner, {
        outcome: 'failed', error: { code: 'REVIEWER_AUTHORITY_LOST',
          message: 'The original remote reviewer lifetime has already closed.', retryable: false },
      })
      expect(f.execution).toEqual(original)
      expect(f.credentials.recoverRemote).not.toHaveBeenCalled()
      expect(f.resident).not.toHaveBeenCalled()
      expect(f.requests).toEqual(['reattach'])
    } finally {
      await f.connection.close()
    }
  })

  it('leaves a failed Worker connection retryable during cold reviewer recovery', async () => {
    const f = await recoveryFixture()
    f.worker.authenticated = false
    try {
      await expect(f.coordinator().requestColdRunCleanup(f.owner))
        .rejects.toThrow('Authenticated Worker connection unavailable')
      expect(f.requestCleanup).not.toHaveBeenCalled()
      expect(f.credentials.recoverRemote).not.toHaveBeenCalled()
    } finally {
      await f.connection.close()
    }
  })

  it('declines recovery after credential revocation while live reviewer access remains denied', async () => {
    const f = fixture()
    f.state.revoked = true
    try {
      expect(await readRecoverableRemoteReviewer(f.connection, f.execution)).toBeUndefined()
      await expect(readRetainedRemoteReviewer(f.connection, f.execution))
        .rejects.toMatchObject({ code: 'REMOTE_REVIEWER_DENIED' })
      expect(f.state).toMatchObject({ finalized: false, purpose: 'workflow', committed: false })
    } finally { await f.connection.close() }
  })

  it('reconstructs saved startup instructions and work context when recovering the original reviewer', async () => {
    const f = await recoveryFixture({ handoff: true })
    try {
      const main = f.coordinator()
      expect((await f.attach(main)).session).toEqual(f.session)
      expect(f.originalRequest.initialPrompt).toContain('Keep the saved workflow startup instructions.')
      expect(f.originalRequest.initialPrompt).toContain('Foreman Code work-handoff result contract')
      expect(f.originalRequest.executionContext).toEqual({ parentRequest: null })
      expect(f.requests).toEqual(['reattach', 'get-application-access'])
      await main.closeForRestart()
      await f.proxies[0]!.dispose()
      expect(f.worker.receipt.terminal).toBeUndefined()
      expect(f.worker.receipt.stopFence).toBe(false)
    } finally { await f.connection.close() }
  })

  it.each([false, true])('hands over an interrupted remote attachment with a reconnect failure=%s', async reconnectFailure => {
    const f = await recoveryFixture()
    const reviewTurn = { assignment: { jobId: 'original-review', interactionId: 'pending-interaction',
      reviewerAgentId: f.execution.agentId, correlationId: 'original-review-turn', session: f.session },
      promptDigest: 'a'.repeat(64), afterSequence: -1, providerId: 'original-review-provider', entered: true, settled: false }
    f.worker.receipt.reviewTurns = [reviewTurn]
    f.receipt.reviewTurns = [structuredClone(reviewTurn)]
    await f.coordination.ensureLane({ id: 'original-review-lane', harness: f.session.harness,
      nativeSessionId: f.session.nativeSessionId, ownerAgentId: f.execution.agentId,
      correlationId: reviewTurn.assignment.correlationId, currentTurnOrMessageId: reviewTurn.providerId,
      observedStatus: 'disconnected', connectionGeneration: 1, revision: 1, observedAt: f.base.createdAt })
    let entered!: () => void
    const attaching = new Promise<void>(resolve => { entered = resolve })
    let interrupted = false
    f.worker.beforeReattach = async signal => {
      if (!signal || interrupted) return
      interrupted = true
      entered()
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DeviceApplicationError('cancelled')), { once: true })
      })
    }
    const first = f.coordinator()
    const opening = expect(f.attach(first)).rejects.toMatchObject({ code: 'ENGINE_RESTART' })
    try {
      await attaching
      if (reconnectFailure) {
        f.worker.authenticated = false
        await expect(first.closeForRestart()).rejects.toThrow('Native restart closure was incomplete')
        expect(f.closures.recordDetached).not.toHaveBeenCalled()
        expect(f.state).toMatchObject({ detached: false, closed: false, generation: '1' })
        f.worker.authenticated = true
      }
      await first.closeForRestart()
      await opening
      await f.proxies[0]!.dispose()
      expect(f.state).toMatchObject({ detached: true, closed: false, generation: '1', revoked: false })
      expect(f.worker.receipt.native).toEqual(f.receipt.native)
      expect(f.worker.receipt.reviewTurns).toEqual([reviewTurn])
      expect(f.worker.receipt.terminal).toBeUndefined()
      expect(f.worker.receipt.stopFence).toBe(false)
      expect(f.credentials.recoverRemote).not.toHaveBeenCalled()
      f.worker.beforeReattach = async () => {}
      const replacement = f.coordinator()
      expect((await f.attach(replacement)).session).toEqual(f.session)
      expect(f.state).toMatchObject({ detached: false, closed: false, generation: '2' })
      expect(f.credentials.recoverRemote).toHaveBeenCalledTimes(1)
      expect(await f.coordination.getLane(f.session.harness, f.session.nativeSessionId)).toMatchObject({
        correlationId: reviewTurn.assignment.correlationId, currentTurnOrMessageId: reviewTurn.providerId,
      })
      await replacement.closeForRestart()
      await f.proxies[1]!.dispose()
      expect(f.requests.every(method => ['reattach', 'history', 'get-application-access'].includes(method))).toBe(true)
    } finally { await f.connection.close() }
  })

  it('recovers the original process when the crashed Main review lease expires during attachment', async () => {
    const f = await recoveryFixture()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      f.state.reviewJobs = [ReviewJobSchema.parse({ id: 'crashed-review', interactionId: 'pending-interaction',
        reviewerAgentId: f.execution.agentId, attempt: 1, state: 'acknowledged', provider: f.session.harness,
        nativeSessionId: f.session.nativeSessionId, correlationId: 'original-review-turn',
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
        leaseOwner: 'crashed-main', leaseToken: 'old-review-lease',
        leaseExpiresAt: new Date(now + 1_000).toISOString() })]
      f.worker.beforeApplicationAccess = () => { clock.mockReturnValue(now + 2_000) }
      const main = f.coordinator()
      expect((await f.attach(main)).session).toEqual(f.session)
      expect(f.credentials.bindReviewerJob).not.toHaveBeenCalled()
      expect(f.state.purpose).toBe('reviewer')
      expect(f.resident).toHaveBeenCalledTimes(1)
      expect(f.credentials.recoverRemote).toHaveBeenCalledWith(f.execution.id,
        expect.objectContaining({ token: 'original-token' }), undefined)
      await main.closeForRestart()
    } finally {
      clock.mockRestore()
      await f.connection.close()
    }
  })

  it.each(['expired', 'detached'] as const)('requires Worker recovery before authorizing a %s reviewer', async state => {
    const f = fixture()
    try {
      if (state === 'expired') {
        f.state.live = false
        f.receipt.retainedReviewer!.expiresAt = new Date(Date.now() - 60_000).toISOString()
      }
      if (state === 'detached') f.state.detached = true
      expect(await readRetainedRemoteReviewer(f.connection, f.execution)).toBeUndefined()
      expect(await readRecoverableRemoteReviewer(f.connection, f.execution)).toEqual({
        generation: '1', principalId: f.principal.id, session: f.session, detached: f.state.detached,
      })
      expect(f.state).toMatchObject({ finalized: false, purpose: 'workflow' })
    } finally { await f.connection.close() }
  })

  it('reattaches the original reviewer after graceful Main shutdown without closing its native lifetime', async () => {
    const f = await recoveryFixture()
    const original = structuredClone(f.execution)
    try {
      const first = f.coordinator()
      expect((await f.attach(first)).session).toEqual(f.session)
      await first.closeForRestart()
      expect(f.state.detached).toBe(true)
      const second = f.coordinator()
      expect((await f.attach(second)).session).toEqual(f.session)
      expect(f.closures.begin).toHaveBeenCalledTimes(1)
      expect(f.state).toMatchObject({ detached: false, closed: false, generation: '2' })
      expect(f.execution).toEqual(original)
      expect(f.requests).toEqual(['reattach', 'get-application-access', 'reattach', 'get-application-access'])
      expect(f.closures.recordDetached).toHaveBeenNthCalledWith(1, original, f.session, '1', expect.any(Function))
      expect(f.credentials.recoverRemote.mock.results).toHaveLength(2)
      await second.closeForRestart()
      expect(f.closures.recordDetached).toHaveBeenCalledTimes(2)
      expect(f.closures.recordDetached).toHaveBeenNthCalledWith(2, original, f.session, '2', expect.any(Function))
    } finally { await f.connection.close() }
  })

  it('refreshes an expired Main receipt from the living original Worker reviewer', async () => {
    const f = await recoveryFixture()
    try {
      f.receipt.retainedReviewer!.expiresAt = new Date(Date.now() - 60_000).toISOString()
      f.state.live = false
      f.worker.receipt.sequence++
      const main = f.coordinator()
      expect((await f.attach(main)).session).toEqual(f.session)
      expect(f.receipt.retainedReviewer!.expiresAt).toBe(f.worker.receipt.retainedReviewer!.expiresAt)
      expect(f.credentials.recoverRemote).toHaveBeenCalledTimes(1)
      expect(f.closures.begin).not.toHaveBeenCalled()
      expect(f.requests).toEqual(['reattach', 'get-application-access'])
      await main.closeForRestart()
    } finally { await f.connection.close() }
  })

  it('refreshes authenticated Worker evidence before rebinding the original reviewer to a recovered job', async () => {
    const f = await recoveryFixture()
    try {
      f.receipt.retainedReviewer!.expiresAt = new Date(Date.now() - 60_000).toISOString()
      f.state.live = false
      f.worker.receipt.sequence++
      const now = new Date().toISOString()
      const job = ReviewJobSchema.parse({ id: 'recovered-review', interactionId: 'pending-interaction',
        reviewerAgentId: f.execution.agentId, attempt: 2, state: 'acknowledged', provider: f.session.harness,
        nativeSessionId: f.session.nativeSessionId, correlationId: 'original-review-turn',
        createdAt: now, updatedAt: now, leaseOwner: 'main', leaseToken: 'review-lease',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })
      const main = f.coordinator()
      expect((await f.attach(main, job)).session).toEqual(f.session)
      expect(f.credentials.bindReviewerJob).toHaveBeenCalledTimes(2)
      expect(f.receipt.retainedReviewer!.expiresAt).toBe(f.worker.receipt.retainedReviewer!.expiresAt)
      expect(f.requests).toEqual(['reattach', 'get-application-access'])
      await main.closeForRestart()
    } finally { await f.connection.close() }
  })

  it.each(['unauthenticated', 'expiredWorker', 'changedSession', 'changedCredential', 'closed', 'missingTerminal'] as const)(
    'rejects recovery with %s evidence without making the reviewer resident', async failure => {
      const f = await recoveryFixture()
      try {
        f.receipt.retainedReviewer!.expiresAt = new Date(Date.now() - 60_000).toISOString()
        f.state.live = false
        if (failure === 'unauthenticated') f.worker.authenticated = false
        if (failure === 'expiredWorker') f.worker.receipt.retainedReviewer!.expiresAt = f.receipt.retainedReviewer!.expiresAt
        if (failure === 'changedSession') f.worker.session = { ...f.session, nativeSessionId: 'replacement-session' }
        if (failure === 'changedCredential') f.worker.principalId = 'replacement-principal'
        if (failure === 'closed') f.state.closed = true
        if (failure === 'missingTerminal') f.state.terminal = false
        const main = f.coordinator()
        const errors = {
          unauthenticated: { message: 'Authenticated Worker connection unavailable' },
          expiredWorker: { code: 'REVIEWER_AUTHORITY_LOST' },
          changedSession: { message: 'Original remote session recovery required' },
          changedCredential: { code: 'REVIEWER_AUTHORITY_LOST' },
          closed: { code: 'REVIEWER_AUTHORITY_LOST' },
          missingTerminal: { code: 'REMOTE_REVIEWER_DENIED' },
        }
        await expect(f.attach(main)).rejects.toMatchObject(errors[failure])
        await expect(f.attach(main)).rejects.toMatchObject({
          code: failure === 'missingTerminal' ? 'REMOTE_REVIEWER_DENIED' : 'REVIEWER_AUTHORITY_LOST',
        })
        expect(f.resident).not.toHaveBeenCalled()
        expect(f.requests.every(method => ['reattach', 'get-application-access'].includes(method))).toBe(true)
        expect(f.closures.begin).not.toHaveBeenCalled()
      } finally { await f.connection.close() }
    },
  )
})
