import assert from 'node:assert/strict'
import type pg from 'pg'
import { assertGraphTransaction, ExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, type HarnessExecution,
  type NativeSessionReference, type ReviewJob } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { DEFAULT_WORKER_CREDENTIAL_TTL_MS } from '../src/modules/access/workerCredentials.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { RepeatNativeObservationStore } from '../src/modules/interactions/repeatObservation.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { DomainError } from '../src/modules/errors.js'
import type { NativeHistory } from '../src/modules/harnesses/port.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import { nativeCompleted, nativeFixture, nativeStored, nativeAt } from './eng04-native-fixtures.js'
import { idleWorkflowControls } from './helpers/idleWorkflowControls.js'

/** Doubles only. These tests never start a provider, DB, native process or browser. */
export function native2Fixture(completed = true,
  validateContinuation: (executionId: string, signal?: AbortSignal) => Promise<void> = async () => undefined) {
  const fixture = nativeFixture()
  const base = makeCurrentWorkflowFixture('eng04-native')
  const configuration = AgentConfigurationVersionSchema.parse({ ...base.configurations[0],
    id: fixture.execution.agentConfigurationVersionId, agentId: fixture.execution.agentId })
  const run = AcceptedWorkflowRunV3Schema.parse({ ...base.run, executionSemanticsVersion: 3,
    agentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds, executionState: 'running',
    authorizationPrincipalId: 'principal-native2-authorized',
    executionLocation: { runnerId: 'runner-native2', locationRevision: 1, rootPath: '/accepted/root',
      identityHash: `sha256:${'1'.repeat(64)}` } })
  let execution = completed ? nativeCompleted(fixture.execution) : fixture.execution
  const calls: string[] = []
  const persisted: { event: unknown; owner: unknown; lease: unknown; evidence: unknown }[] = []
  let owned = true, settled = false, closed = false, revoked = false, finished = false
  let proof: { execution: HarnessExecution; session: NativeSessionReference; durableGeneration: string } | undefined
  const session: NativeSessionReference = { harness: 'codex', providerVersion: 'synthetic-provider-1',
    nativeSessionId: execution.nativeSessionId! }
  const assertOwned = () => {
    if (!owned) throw new DomainError('RUN_OWNERSHIP_LOST', 'fixture owner replaced', 409)
  }
  // Read-only SQL protocol for cold credential repair. No durable principal is
  // inferred from the resident WeakMap: an unbound resource gap stays pending.
  // Tests that model durable bindings must name their exact purpose/identity.
  const recovery = { bindings: [] as Array<{ principalId: string; purpose: 'workflow' | 'reviewer'; revoked: boolean }>,
    statements: [] as string[], active: false }
  const query = async (text: string, values: unknown[] = []) => {
    const q = text.replace(/\s+/g, ' ').trim()
    recovery.statements.push(q)
    const result = (rows: unknown[]) => ({ rows: structuredClone(rows), rowCount: rows.length })
    if (q.startsWith('begin')) { assert.equal(recovery.active, false); recovery.active = true; return result([]) }
    if (q === 'commit' || q === 'rollback') { assert.equal(recovery.active, true); recovery.active = false; return result([]) }
    assertOwned()
    assert.equal(recovery.active, true, 'cold reads must use the real serialized transaction')
    if (q === 'select id from runs where id=$1 for update') {
      assert.deepEqual(values, [run.id]); return result([{ id: run.id }])
    }
    if (q === 'select record from harness_executions where id=$1 and run_id=$2 for update') {
      assert.deepEqual(values, [execution.id, run.id]); return result([{ record: execution }])
    }
    if (q.startsWith('select c.generation::text,c.execution_identity')) {
      assert.deepEqual(values, [execution.id, run.id])
      if (!proof) return result([])
      const e = proof.execution
      return result([{ generation: proof.durableGeneration, execution_identity: {
        id: e.id, runId: e.runId, workflowNodeId: e.workflowNodeId, agentId: e.agentId,
        agentConfigurationVersionId: e.agentConfigurationVersionId, attempt: e.attempt,
        ...(e.workingDirectory ? { workingDirectory: e.workingDirectory } : {}),
        ...(e.runtimeDirectory ? { runtimeDirectory: e.runtimeDirectory } : {}),
      }, expected_reference: proof.session, closed_reference: proof.session, closed: true,
      detached: false, closed_without_session: false, prior_unclosed: false, record: execution, reference: session }])
    }
    if (q.startsWith('select p.generation::text,p.execution_identity,p.reference')) {
      assert.deepEqual(values, [execution.id]); return result([]) // No fabricated registry recovery.
    }
    if (q.startsWith('select b.principal_id from worker_credential_bindings b')) {
      assert.deepEqual(values, [execution.id, run.id, execution.agentId])
      assert.ok(q.includes("b.execution_id=$1 and b.run_id=$2 and b.agent_id=$3 and b.purpose='workflow'"))
      assert.ok(q.endsWith('order by b.principal_id for share'))
      return result(recovery.bindings.filter((binding) => binding.purpose === 'workflow')
        .sort((a, b) => a.principalId.localeCompare(b.principalId)).map((binding) => ({ principal_id: binding.principalId })))
    }
    throw new Error(`Unexpected NATIVE-2 cold recovery SQL: ${q}`)
  }
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, assertOwned)
  const owner = { runId: execution.runId, client: {}, assertOwned, oneShotConnection: () => connection,
    readOneShotFence: async (sql: GraphTransactionSql) => {
      assertGraphTransaction(sql); assertOwned(); return { ownerId: 'native2-owner', fence: '1' }
    } }
  const forbidden = (name: string) => () => { calls.push(name); throw new Error(`Forbidden native operation: ${name}`) }
  const store = {
    readExecution: async (id: string) => { calls.push(`read:${id}`); return nativeStored(execution, fixture) },
    settleNativeExecution: async (id: string) => {
      calls.push(`settle:${id}`)
      if (!settled && !(closed && revoked && finished && recovery.bindings.every((binding) => binding.revoked))) {
        throw new DomainError('REPEAT_CLEANUP_PENDING', 'exact receipts pending', 409)
      }
    },
    assertNativeBoundary: async (id: string) => { owner.assertOwned(); calls.push(`boundary:${id}`) },
    exactSession: async (id: string) => { calls.push(`session:${id}`); return session },
    assertExecutionAdmission: async () => { owner.assertOwned(); calls.push('admission') },
    authorizeNativeSubmission: async () => { owner.assertOwned(); calls.push('authorize-submission') },
    consumeLaunch: (): boolean => false,
  } satisfies RepeatNativeObservationStore
  const runs = {
    ...idleWorkflowControls,
    ensureExecution: forbidden('ensureExecution'),
    get: async () => run,
    getRepeatSnapshot: async () => ({ run, stopRequested: false, cleanupPending: false }),
    getExecutionConfiguration: async () => configuration,
    getExecution: async () => execution,
    updateExecution: async (next: HarnessExecution) => { calls.push(`terminal:${next.result?.outcome ?? next.state}`); execution = next },
    recordActivity: async () => undefined,
    appendNativeEvent: async (event: unknown, owner?: unknown, lease?: unknown, _approval?: unknown, _legacy?: unknown, evidence?: unknown) => {
      calls.push('raw-event'); persisted.push({ event, owner, lease, evidence })
    },
    appendNativeEvents: async (frames: readonly { event: unknown; evidence: unknown }[], owner?: unknown, lease?: unknown) => {
      for (const { event, evidence } of frames) {
        calls.push('raw-event')
        persisted.push({ event, owner, lease, evidence })
      }
    },
  }
  const captureChannel = createWorkflowNativeCaptureChannel()
  const interactions = { coordination: {
    assertReviewPhysicalSettlement: async () => { calls.push('review-physical-settlement') },
    workflowSession: async () => ({ session, finalized: false, reviewerActive: false }),
    finalizeWorkflowSession: forbidden('unqualified-finalize'),
    bindWorkflowSession: async () => undefined,
    hasUnsettledReview: async () => false,
    acknowledgeLaneTurn: async (fence: { id: string; token: string }, correlationId: string, providerId: string) => {
      assertOwned()
      assert.deepEqual(fence, { id: 'lane-native2-exact', token: 'lease-native2-exact' })
      assert.equal(correlationId, `execution:${execution.id}`)
      assert.equal(providerId, 'turn-native2-exact')
    },
    getReviewJobContext: async () => ({ executionId: execution.id,
      workingDirectory: execution.workingDirectory!, providerVersion: session.providerVersion }),
    findReviewJob: async (): Promise<ReviewJob | undefined> => undefined,
  }, getForExecution: async () => undefined, cancelPendingForExecution: forbidden('cancel-pending') }
  const budgets = {
    finish: async (id: string) => { calls.push(`budget:${id}`); finished = true },
    ensure: async () => undefined, resume: async () => undefined, remaining: async () => 60_000,
    assertActive: async () => undefined, beginWait: async () => { calls.push('pause-budget') },
  }
  const credentials: Pick<ExecutionCredentialProvider, 'prepare' | 'revoke' | 'revokeForExecution'> = {
    prepare: forbidden('credential-prepare'),
    revoke: async ({ principalId }: { principalId: string }) => {
      calls.push(`revoke:${principalId}`); revoked = true
      for (const binding of recovery.bindings) if (binding.principalId === principalId) binding.revoked = true
    },
    revokeForExecution: async (id: string) => { calls.push(`revoke-execution:${id}`); revoked = true; return 1 },
  }
  const managers = { resolve: forbidden('resolve'), release: () => { calls.push('release-manager') } }
  const closures = {
    begin: async () => '41',
    recordDetached: forbidden('detached-close'), recordUnbound: forbidden('unbound-close'),
    readUnbound: async () => undefined,
    read: async () => proof,
    record: async (value: HarnessExecution, reference: NativeSessionReference, generation: string, check: () => void) => {
      check(); calls.push(`closure:${generation}`); closed = true
      proof = { execution: value, session: reference, durableGeneration: generation }
      return proof
    },
  }
  const coordinator = new ApprovalExecutionCoordinator(runs as never, interactions as never, budgets as never,
    managers as never, 60_000, credentials as never, validateContinuation, closures, undefined, captureChannel.capture)
  const history = () => ({ correlationId: `execution:${execution.id}`, nativeTurnId: 'turn-native2-exact',
    terminalTurn: { correlationId: `execution:${execution.id}`, providerId: 'turn-native2-exact', result: nativeCompleted(execution).result! },
    pendingInteractions: [], events: [], responseDeliveries: [] } as unknown as NativeHistory)
  const manager = {
    harness: 'codex' as const,
    assertCapturedLease: () => undefined,
    capturedLease: () => ({ fence: { id: 'lane-native2-exact', token: 'lease-native2-exact' },
      previous: { connectionGeneration: 1 }, providerId: 'turn-native2-exact' }),
    close: async (reference: NativeSessionReference) => { calls.push(`close:${reference.nativeSessionId}`) },
    capabilities: forbidden('capabilities'), createSession: forbidden('createSession'),
    attachSession: forbidden('attachSession'), startTurn: forbidden('startTurn'), respond: forbidden('respond'), cancel: forbidden('cancel'),
    startTurnBatches: forbidden('startTurnBatches'),
    history: async () => history(), reconcile: async () => history(),
    observeBoundary: async (reference: NativeSessionReference) => {
      assertOwned()
      assert.deepEqual(reference, session)
    },
    isActive: () => false,
    currentProjectionLease: () => ({ id: 'lane-native2-exact', token: 'lease-native2-exact', providerId: 'turn-native2-exact', live: true }),
    withLane: async (_reference: NativeSessionReference, correlation: string, _signal: AbortSignal | undefined,
      work: (manager: unknown, lane: unknown) => Promise<unknown>) => work(manager, {
        fence: { id: 'lane-native2-exact', token: 'lease-native2-exact' }, providerId: 'turn-native2-exact',
        previous: { connectionGeneration: 1, correlationId: correlation, currentTurnOrMessageId: 'turn-native2-exact', observedStatus: 'idle' },
        guard: { check: async () => undefined, signal: new AbortController().signal }, observedStatus: 'idle',
      }),
  }
  const resident = { execution, context: { harness: 'codex', executionId: execution.id, agentId: execution.agentId,
    workingDirectory: execution.workingDirectory, configuration } as Record<string, unknown>, manager,
    controller: new AbortController(), generation: 7, closureGeneration: '41', closureRegistration: Promise.resolve('41'), session }
  const internals = coordinator as unknown as {
    ownedSessions: Map<string, typeof resident>
    managerCredentials: WeakMap<object, unknown>
    resolveManager: () => { manager: typeof manager; processState: 'resident' | 'needs_start'; beginStart?(): void; markResident?(): void }
    prepareEnvironment: (context?: unknown, resolved?: unknown, signal?: AbortSignal, purpose?: unknown, enterNative?: () => Promise<void>) => Promise<undefined>
    closeRepeatLifetime: (value: typeof resident, check: () => void) => Promise<void>
  }
  const installResident = (reviewer = false) => {
    if (reviewer) resident.context.purpose = 'reviewer'
    internals.ownedSessions.set(execution.id, resident)
    internals.managerCredentials.set(manager, { principalId: 'principal-native2-captured',
      expiresAt: new Date(Date.now() + DEFAULT_WORKER_CREDENTIAL_TTL_MS).toISOString(), environment: { variables: {} } })
  }
  const observe = () => coordinator.observeExact({ execution, store,
    workflowId: run.workflowId, graphThreadId: run.id, owner: owner as never, signal: new AbortController().signal })
  return { fixture, configuration, run, owner, connection, recovery, store, coordinator, internals, resident, installResident, observe,
    calls, persisted, captureChannel, closures, credentials, budgets, manager, managers, interactions, runs, session, history,
    get: () => execution, set: (value: HarnessExecution) => { execution = HarnessExecutionSchema.parse(JSON.parse(JSON.stringify(value))) },
    loseOwner: () => { owned = false }, settled: () => { settled = true },
    closed: () => { closed = true; proof = { execution, session, durableGeneration: '41' } },
    getProof: () => proof, revoked: () => { revoked = true }, at: nativeAt }
}
