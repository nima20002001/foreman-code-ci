import assert from 'node:assert/strict'

import type { DurableInteraction, NativeSessionReference, PendingNativeInteraction } from '@foreman-code/contracts'
import { it } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { DomainError } from '../src/modules/errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeResponseIdentity } from '../src/modules/harnesses/port.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { matchingDeliveryEvidence, responseValueDigest, type InteractionDeliveryClaim, type NativeDeliveryOutcome, type NativeResponseDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import type { GraphResumeClaim } from '../src/modules/interactions/deliveryPostgres.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'
import type { InteractionNativeRuntime } from '../src/modules/interactions/runtimePorts.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { deferred } from './helpers/deferred.js'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'
import { input } from './fixtures/codex-test-helpers.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { ApprovalPostgresSaver } from '../src/infrastructure/approvalCheckpointSaver.js'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'

function fixture(): DurableInteraction {
  return {
    id: 'interaction-proof', revision: 0, workspaceId: 'workspace-fixture', workflowId: 'workflow-fixture',
    runId: 'run-fixture', executionId: 'execution-fixture', requestingAgentId: 'agent-coder', harness: 'codex',
    providerVersion: '0.154.0', nativeSessionId: 'native-session', nativeRequestId: 'native-request',
    nativeRequestType: 'item/commandExecution/requestApproval', graphThreadId: 'run-fixture', graphInterruptId: 'interrupt-proof',
    request: { command: ['pnpm', 'test'] }, approval: { handler: 'user' },
    responseOptions: [{ optionId: 'opaque-option', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
  }
}

const userPrincipal: ManagementPrincipal = { id: 'unit-user', name: 'Unit User', audience: 'user',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['interactions:respond'], scope: { workspaceIds: ['workspace-fixture'] } }] }
const reviewerPrincipal: ManagementPrincipal = { ...userPrincipal, id: 'unit-reviewer',
  audience: 'worker', agentId: 'agent-reviewer', grants: [{ actions: ['interactions:read', 'interactions:respond'],
    scope: { workspaceIds: ['workspace-fixture'], workflowIds: ['workflow-fixture'], runIds: ['run-fixture'] } }] }

/** Real current service and SingleWriterSessionManager; repository methods are
 * explicit recording ports, not PostgreSQL/native receipt qualification. The
 * delegate tests below retain exact token/decision checks and distinguish a
 * committed checkpoint fixture from a callback that merely returns. */
function harness(manager?: NativeHarnessSessionManager, pending?: PendingNativeInteraction) {
  let record = fixture()
  if (pending) record = { ...record, ...pending.session, nativeRequestId: pending.turn.nativeRequestId!,
    nativeRequestType: pending.nativeRequestType, request: pending.request, responseOptions: pending.responseOptions }
  let claim: InteractionDeliveryClaim | undefined
  let graphOwned = false
  let attempt = 0
  let resumeReceipt: GraphResumeClaim | undefined
  let writeStarted = false
  const control = {
    stopped: false, completedRun: false, timeout: false, crashCommit: false, commitResume: true,
    ownerHeld: false, ownerReleases: 0,
    reviewState: 'completed' as 'acknowledged' | 'completed',
    resumeState: 'absent' as 'absent' | 'required' | 'completed' | 'canceled',
    resumeError: undefined as string | undefined,
    attemptState: undefined as NativeDeliveryOutcome['state'] | 'submitted' | undefined,
    history: { events: [], pendingInteractions: [] } as NativeHistory,
    onAttach: async () => undefined as void,
    onSend: async () => undefined as void,
    onResume: async (_interaction: DurableInteraction) => { void _interaction },
  }
  const calls = { sends: 0, attaches: 0, reconciles: 0, resumes: 0, asserts: 0, budgetResumes: 0 }
  const session: NativeSessionReference = {
    harness: record.harness, providerVersion: record.providerVersion, nativeSessionId: record.nativeSessionId,
  }
  const ports = {
    assertOrchestratorConnection: async () => ({ orchestratorNodeId: 'node-reviewer' }),
    coordination: { findReviewJob: async () => ({ state: control.reviewState }) },
    get: async () => structuredClone(record),
    decide: async (input: Parameters<Wave25InteractionRepository['decide']>[0]) => {
      assert.equal(input.id, record.id)
      assert.ok(input.principal, 'the service must forward authenticated authority, including on replay')
      const option = record.responseOptions.find((item) => item.optionId === input.optionId)!
      assert.deepEqual(input.nativeResponse, { optionId: option.optionId, semantic: option.semantic })
      if (record.selectedOptionId) {
        if (record.selectedOptionId !== input.optionId) throw new DomainError('INTERACTION_ALREADY_DECIDED', 'Different persisted choice', 409)
        return { interaction: structuredClone(record), replayed: true }
      }
      assert.equal(input.expectedRevision, record.revision)
      record = { ...record, revision: record.revision + 1, selectedOptionId: input.optionId,
        selectedSemantic: option.semantic, nativeResponse: input.nativeResponse, decidedAt: record.createdAt,
        status: 'delivery_pending', deliveryState: 'pending' }
      return { interaction: structuredClone(record), replayed: false }
    },
    delivery: {
      claim: async (_id: string, ownerToken: string, reconcileOnly: boolean) => {
        if (claim || control.stopped || record.deliveryState === 'delivered') return undefined
        if (record.approval.handler === 'orchestrator' && control.reviewState !== 'completed') return undefined
        const mode = writeStarted || ['submitted', 'uncertain'].includes(record.deliveryState) ? 'reconcile' : 'submit'
        if (reconcileOnly && mode !== 'reconcile') return undefined
        if (mode === 'submit') attempt++
        control.attemptState = mode === 'submit' ? 'submitted' : 'uncertain'
        // A private lease claim does not itself publish a delivery revision.
        claim = { interaction: structuredClone(record), attempt, ownerToken, correlationId: 'persisted-correlation', mode }
        return claim
      },
      finish: async (owned: InteractionDeliveryClaim, outcome: NativeDeliveryOutcome | ((current: DurableInteraction, signal: AbortSignal) => Promise<NativeDeliveryOutcome>)) => {
        assert.equal(owned.ownerToken, claim?.ownerToken)
        if (control.stopped) throw new DomainError('DELIVERY_OWNER_LOST', 'Stop invalidated the delivery owner', 409)
        if (typeof outcome === 'function') {
          assert.equal(owned.mode, 'submit'); assert.equal(writeStarted, false)
          writeStarted = true
          record = { ...record, revision: record.revision + 1, deliveryState: 'submitted', status: 'delivery_pending' }
        }
        const result = typeof outcome === 'function' ? await outcome(structuredClone(record), new AbortController().signal) : outcome
        if (control.crashCommit) { control.crashCommit = false; throw new Error('database commit lost after native write') }
        control.attemptState = result.state
        record = { ...record, revision: record.revision + 1, deliveryState: result.state,
          status: result.state === 'delivered' ? 'delivered' : result.state === 'failed' ? 'delivery_failed' : 'delivery_pending' }
        if (result.state === 'delivered') control.resumeState = 'required'
        claim = undefined
        return structuredClone(record)
      },
      persistedResponseEvidence: async () => undefined,
      assertNativeDispatch: async (owned: InteractionDeliveryClaim) => {
        assert.equal(owned.ownerToken, claim?.ownerToken)
        assert.equal(owned.correlationId, claim?.correlationId)
        assert.ok(writeStarted)
        if (control.stopped) throw new DomainError('GRAPH_STOP_CONFLICT', 'stopped', 409)
        return { interaction: structuredClone(record), expiresAt: new Date(Date.now() + 30_000) }
      },
      claimAtomicGraphResume: async (_id: string, ownerToken: string) => {
        if (control.resumeState !== 'required' || graphOwned) return undefined
        if (control.stopped || control.completedRun) {
          return undefined // A terminal Run is not a checkpoint-consumption receipt.
        }
        if (!record.graphInterruptId) return undefined
        graphOwned = true
        return { interaction: structuredClone(record), ownerToken }
      },
      finishGraphResume: async (owned: GraphResumeClaim, error?: string) => {
        const committed = resumeReceipt?.ownerToken === owned.ownerToken
          && resumeReceipt.interaction.id === owned.interaction.id
          && resumeReceipt.interaction.graphInterruptId === owned.interaction.graphInterruptId
        control.resumeState = committed ? 'completed' : 'required'
        control.resumeError = committed ? undefined : error ?? 'GRAPH_RESUME_RECEIPT_MISSING'
        graphOwned = false
      },
      recoveryCandidates: async () => [structuredClone(record)],
    },
  }
  const noSql = () => { throw new Error('Unscripted SQL in the approval service unit fixture') }
  const repository = new Wave25InteractionRepository({ query: noSql, connect: noSql } as unknown as pg.Pool)
  Object.assign(repository, { get: ports.get, decide: ports.decide })
  Object.assign(repository.delivery, ports.delivery)
  const budgets = {
    assertActive: async () => {
      calls.asserts++
      if (control.timeout) throw new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'expired accounting', 409)
      if (control.stopped) throw new DomainError('EXECUTION_STOPPED', 'stopped', 409)
    },
    resume: async () => { calls.budgetResumes++ },
  } as unknown as PostgresApprovalBudgetRepository
  const rawManager = {
    harness: 'codex',
    respond: async (actualSession: NativeSessionReference, requestId: string) => {
      assert.deepEqual(actualSession, session); assert.equal(requestId, record.nativeRequestId)
      calls.sends++; await control.onSend()
    },
    history: async () => control.history,
    reconcile: async () => control.history,
    reconcileResponse: async (_session: NativeSessionReference, response: NativeResponseIdentity) => {
      assert.equal(response.nativeRequestId, record.nativeRequestId)
      assert.equal(response.nativeRequestType, record.nativeRequestType)
      assert.equal(response.option.optionId, record.selectedOptionId)
      calls.reconciles++; return control.history
    },
  } as unknown as NativeHarnessSessionManager
  const writer = new SingleWriterSessionManager(manager ?? rawManager, nativeLanes(), record.requestingAgentId)
  const runtime: InteractionNativeRuntime = {
    withInteractionOwner: async <T>(interaction: DurableInteraction, signal: AbortSignal,
      work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      assert.equal(interaction.id, record.id)
      control.ownerHeld = true
      try { return await work(signal) }
      finally { control.ownerHeld = false; control.ownerReleases++ }
    },
    validateInteraction: async () => { await budgets.assertActive(record.executionId) },
    attachOwnedSession: async () => {
      throw new Error('Unexpected owned-session attach')
    },
    attachInteraction: async () => {
      calls.attaches++; await control.onAttach()
      return { session, manager: writer }
    },
  }
  const service = () => {
    const instance = new InteractionService(repository, budgets, runtime, async () => {
      throw new Error('The retired void graph callback must not be used')
    })
    instance.useAtomicApprovalResume(async (owned) => {
      assert.ok(graphOwned); assert.equal(owned.interaction.id, record.id)
      assert.equal(owned.interaction.graphInterruptId, record.graphInterruptId)
      calls.resumes++; await control.onResume(owned.interaction)
      // Explicit simulated checkpoint COMMIT, not a native acknowledgement.
      if (control.commitResume) resumeReceipt = { interaction: structuredClone(owned.interaction), ownerToken: owned.ownerToken }
    })
    return instance
  }
  const respond = (instance = service()) => instance.respond({ kind: 'user', principal: userPrincipal }, {
    interactionId: record.id, optionId: record.responseOptions[0]!.optionId, expectedRevision: record.revision,
  })
  const proof = (): NativeResponseDeliveryEvidence => ({
    source: 'provider_history', harness: record.harness, providerVersion: record.providerVersion,
    nativeSessionId: record.nativeSessionId, nativeRequestId: record.nativeRequestId,
    nativeRequestType: record.nativeRequestType, optionId: 'opaque-option', semantic: 'approve_once',
  })
  // Independent provider-history fixture. Returning void from respond is never
  // converted into delivery proof by either this manager or the service.
  control.history = { events: [], pendingInteractions: [], responseDeliveries: [proof()] }
  return { control, calls, session, service, respond, proof, get: () => structuredClone(record),
    change: (fields: Partial<DurableInteraction>) => { record = { ...record, ...fields, revision: record.revision + 1 } },
    abandonOwner: () => { claim = undefined },
  }
}

it('holds the original Run owner through native attachment and delivery, then releases it before graph resume', async () => {
  const h = harness()
  h.control.onAttach = async () => { assert.equal(h.control.ownerHeld, true) }
  h.control.onSend = async () => { assert.equal(h.control.ownerHeld, true) }
  h.control.onResume = async () => { assert.equal(h.control.ownerHeld, false) }
  assert.equal((await h.respond()).interaction.deliveryState, 'delivered')
  assert.equal(h.calls.sends, 1)
  assert.equal(h.control.ownerHeld, false)
  assert.equal(h.control.ownerReleases, 1)
})

it('releases the Run owner when native delivery becomes uncertain', async () => {
  const h = harness()
  h.control.onSend = async () => { throw new Error('native response acknowledgement lost') }
  assert.equal((await h.respond()).interaction.deliveryState, 'uncertain')
  assert.equal(h.control.ownerHeld, false)
  assert.equal(h.control.ownerReleases, 1)
})

it('keeps native delivery proven when graph resume fails and recovers without another native send (#7)', async () => {
  const h = harness()
  h.control.onResume = async () => { throw new Error('checkpoint database unavailable') }
  assert.equal((await h.respond()).interaction.deliveryState, 'delivered')
  assert.equal(h.control.attemptState, 'delivered')
  assert.equal(h.control.resumeState, 'required')
  assert.equal(h.control.resumeError, 'GRAPH_RESUME_CHECKPOINT_UNCERTAIN')
  h.control.onResume = async () => undefined
  await h.service().recover({ limit: 10 })
  assert.equal(h.control.resumeState, 'completed')
  assert.equal(h.calls.sends, 1)
})

it('resumes an orchestrator-approved Worker only after the reviewer turn completes', async () => {
  const h = harness()
  h.change({ approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-reviewer' } })
  h.control.reviewState = 'acknowledged'
  const current = h.get()
  await h.service().respond({ kind: 'orchestrator', principal: reviewerPrincipal, authority: {
    agentId: 'agent-reviewer', workspaceId: current.workspaceId, workflowId: current.workflowId,
  } }, { interactionId: current.id, optionId: 'opaque-option', expectedRevision: current.revision })
  assert.equal(h.get().deliveryState, 'pending')
  assert.equal(h.calls.sends, 0)
  assert.equal(h.calls.resumes, 0)
  assert.equal(h.control.resumeState, 'absent')
  h.control.reviewState = 'completed'
  await h.service().recover({ limit: 10 })
  assert.equal(h.get().deliveryState, 'delivered')
  assert.equal(h.calls.sends, 1)
  assert.equal(h.calls.resumes, 1)
  assert.equal(h.control.resumeState, 'completed')
})

it('does not treat RUN_NOT_RESUMABLE as a successful graph handoff (#7/#8)', async () => {
  const h = harness()
  h.control.onResume = async () => { throw new DomainError('RUN_NOT_RESUMABLE', 'binding not ready', 409) }
  await h.respond()
  assert.equal(h.control.resumeState, 'required')
  assert.equal(h.get().deliveryState, 'delivered')
})

it('retains early delivery until interrupt binding and reloads the bound record (#8)', async () => {
  const h = harness()
  h.change({ graphInterruptId: undefined })
  await h.respond()
  assert.equal(h.calls.resumes, 0)
  assert.equal(h.control.resumeState, 'required')
  h.change({ graphInterruptId: 'bound-after-delivery' })
  h.control.onResume = async (current) => { assert.equal(current.graphInterruptId, 'bound-after-delivery') }
  await h.service().recover({ limit: 10 })
  assert.equal(h.calls.resumes, 1)
  assert.equal(h.calls.sends, 1)
})

it('does not lose a binding revision written during attachment (#8)', async () => {
  const h = harness()
  h.change({ graphInterruptId: undefined })
  h.control.onAttach = async () => { h.change({ graphInterruptId: 'racing-binding' }) }
  h.control.onResume = async (current) => { assert.equal(current.graphInterruptId, 'racing-binding') }
  await h.respond()
  assert.equal(h.get().deliveryState, 'delivered')
  assert.equal(h.calls.resumes, 1)
})

it('does not reconcile or send over another live submission (#11)', async () => {
  const h = harness()
  const entered = deferred()
  const release = deferred()
  h.control.onSend = async () => { entered.resolve(); await release.promise }
  const first = h.respond()
  await entered.promise
  const duplicate = await h.respond(h.service())
  assert.equal(duplicate.replayed, true)
  assert.equal(h.calls.sends, 1)
  assert.equal(h.calls.reconciles, 0)
  release.resolve()
  await first
  assert.equal(h.control.resumeState, 'completed')
})

it('does not confuse absence or a terminal result with exact delivery evidence (#10)', async () => {
  const h = harness()
  h.control.onSend = async () => { throw Object.assign(new Error('write outcome unknown'), { certainty: 'uncertain' }) }
  await h.respond()
  h.control.history = { events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } }
  await h.respond()
  assert.equal(h.get().deliveryState, 'uncertain')
  assert.equal(h.control.attemptState, 'uncertain')
  assert.equal(h.calls.sends, 1)
  assert.equal(h.calls.resumes, 0)
})

it('reconciles the original attempt only with a qualified exact receipt (#10)', async () => {
  const h = harness()
  h.control.onSend = async () => { throw new Error('unknown native outcome') }
  await h.respond()
  h.control.history = { events: [], pendingInteractions: [], responseDeliveries: [h.proof()] }
  await h.respond()
  assert.equal(h.get().deliveryState, 'delivered')
  assert.equal(h.control.attemptState, 'delivered')
  assert.equal(h.control.resumeState, 'completed')
  assert.equal(h.calls.sends, 1)
})

it('rejects receipts for another provider version, session, request, response, or source (#10)', async () => {
  const h = harness()
  await h.respond()
  const changes: Array<Partial<NativeResponseDeliveryEvidence>> = [
    { providerVersion: 'different' }, { harness: 'claude' }, { nativeSessionId: 'different' },
    { nativeRequestId: 'different' }, { nativeRequestType: 'different' }, { optionId: 'different' }, { semantic: 'reject' },
    { source: 'local_pending_eviction' as NativeResponseDeliveryEvidence['source'] },
  ]
  for (const change of changes) {
    assert.equal(matchingDeliveryEvidence(h.get(), h.session, { events: [], pendingInteractions: [], responseDeliveries: [{ ...h.proof(), ...change }] }), undefined)
  }
})

it('treats contradictory pending state as uncertain even alongside a receipt (#10)', async () => {
  const h = harness()
  await h.respond()
  const record = h.get()
  assert.equal(matchingDeliveryEvidence(record, h.session, {
    events: [], responseDeliveries: [h.proof()], pendingInteractions: [{
      session: h.session, turn: { nativeTurnId: 'delivery-turn', nativeRequestId: record.nativeRequestId },
      nativeRequestType: record.nativeRequestType, request: record.request, responseOptions: record.responseOptions,
    }],
  }), undefined)
})

it('fences a response when Stop wins during attachment (#12)', async () => {
  const h = harness()
  h.control.onAttach = async () => {
    h.control.stopped = true
    h.change({ status: 'canceled' })
  }
  await assert.rejects(h.respond(), { code: 'DELIVERY_OWNER_LOST' })
  assert.equal(h.get().status, 'canceled')
  assert.equal(h.calls.sends, 0)
  assert.equal(h.calls.resumes, 0)
})

it('does not resend after a process loses the delivery commit (#7/#11)', async () => {
  const h = harness()
  h.control.crashCommit = true
  await assert.rejects(h.respond(), /commit lost/)
  assert.equal(h.get().deliveryState, 'submitted')
  h.abandonOwner()
  h.control.history = { events: [], pendingInteractions: [], responseDeliveries: [h.proof()] }
  await h.service().recover({ limit: 10 })
  assert.equal(h.get().deliveryState, 'delivered')
  assert.equal(h.control.resumeState, 'completed')
  assert.equal(h.calls.sends, 1)
})

it('allows a completed same-option replay without expired active-time accounting (#28)', async () => {
  const h = harness()
  await h.respond()
  const previous = { ...h.calls }
  h.control.timeout = true
  const result = await h.respond()
  assert.equal(result.replayed, true)
  assert.deepEqual(h.calls, previous)
})

it('a terminal Run cannot manufacture an unconsumed graph handoff or touch its budget (#28)', async () => {
  const h = harness()
  h.control.commitResume = false
  await h.respond()
  h.control.resumeState = 'required'
  h.control.completedRun = true
  h.control.timeout = true
  const previous = { ...h.calls }
  await h.respond()
  assert.equal(h.control.resumeState, 'required')
  assert.deepEqual(h.calls, previous)
})

it('still checks responder authority on delivered replays (#28)', async () => {
  const h = harness()
  await h.respond()
  h.change({ approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'reviewer' } })
  await assert.rejects(h.respond(), (error: unknown) => error instanceof DomainError && error.code === 'INTERACTION_ACCESS_DENIED')
})

it('rejects conflicting options rather than reusing another durable decision', async () => {
  const h = harness()
  await h.respond()
  h.change({ responseOptions: [...h.get().responseOptions, { ...h.get().responseOptions[0]!, optionId: 'different', semantic: 'reject' }] })
  await assert.rejects(h.service().respond({ kind: 'user', principal: userPrincipal }, { interactionId: h.get().id, optionId: 'different', expectedRevision: 0 }),
    (error: unknown) => error instanceof DomainError && error.code === 'INTERACTION_ALREADY_DECIDED')
  assert.equal(h.calls.sends, 1)
})

it('keeps duplicate delivery and graph-resume ownership separate (#7/#11)', async () => {
  const h = harness()
  const entered = deferred()
  const release = deferred()
  h.control.onResume = async () => { entered.resolve(); await release.promise }
  const first = h.respond()
  await entered.promise
  try {
    const replay = await h.respond(h.service())
    assert.equal(replay.interaction.deliveryState, 'delivered')
    assert.equal(h.calls.sends, 1)
    assert.equal(h.calls.resumes, 1)
  } finally { release.resolve() }
  await first
})

it('treats the legacy pendingInteraction observation as a conflicting receipt (#10)', async () => {
  const h = harness()
  await h.respond()
  const current = h.get()
  assert.equal(matchingDeliveryEvidence(current, h.session, {
    events: [], pendingInteractions: [], responseDeliveries: [h.proof()], pendingInteraction: {
      session: h.session, turn: { nativeTurnId: 'delivery-turn', nativeRequestId: current.nativeRequestId }, nativeRequestType: current.nativeRequestType,
      request: current.request, responseOptions: current.responseOptions,
    },
  }), undefined)
})

it('a void atomic consumer cannot be mistaken for a checkpoint receipt', async () => {
  const h = harness(); h.control.commitResume = false
  await h.respond()
  assert.equal(h.get().deliveryState, 'delivered')
  assert.equal(h.control.resumeState, 'required')
  assert.equal(h.control.resumeError, 'GRAPH_RESUME_RECEIPT_MISSING')
  assert.equal(h.calls.budgetResumes, 0)
  assert.equal(h.calls.sends, 1)
})

it('an acknowledged send without exact provider evidence remains uncertain', async () => {
  const h = harness(); h.control.history = { events: [], pendingInteractions: [] }
  await h.respond()
  assert.equal(h.calls.sends, 1)
  assert.equal(h.get().deliveryState, 'uncertain')
  assert.equal(h.calls.resumes, 0)
})

const commandDecisions = ['accept', 'acceptForSession', 'decline', 'cancel',
  { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } },
  { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'example.test' } } },
  { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny', host: 'example.test' } } }]
const approvalChoices = [
  ...commandDecisions.map((decision, index) => ({ kind: 'command' as const, index, response: { decision } })),
  ...['accept', 'acceptForSession', 'decline', 'cancel'].map((decision, index) =>
    ({ kind: 'file' as const, index, response: { decision } })),
  { kind: 'permission' as const, index: 0, response: { permissions: { network: { enabled: true } }, scope: 'turn' } },
  { kind: 'permission' as const, index: 1, response: { permissions: { network: { enabled: true } }, scope: 'session' } },
  { kind: 'permission' as const, index: 2, response: { permissions: {}, scope: 'turn' } },
]

/** SQL recording port: the production saver serializes and consumes the saved interrupt. */
async function checkpointFixture(interaction: DurableInteraction) {
  const saver = new ApprovalPostgresSaver({} as pg.Pool)
  const [type, encoded] = await saver.serde.dumpsTyped([{ id: interaction.graphInterruptId,
    value: { interactionId: interaction.id } }])
  const writes = [{ task_id: 'approval-task', channel: '__interrupt__', type, blob: Buffer.from(encoded) }]
  let checkpointValues: unknown = []
  let staged: unknown = []
  const client = { query: async (statement: string, values: unknown[] = []) => {
    const rows = (data: unknown[] = []) => ({ rows: data, rowCount: data.length })
    const query = statement.trim()
    if (query.startsWith('begin')) { staged = checkpointValues; return rows() }
    if (query === 'commit') { checkpointValues = staged; return rows() }
    if (query === 'rollback') return rows()
    if (query.startsWith('select checkpoint_id')) return rows([{ checkpoint_id: 'saved-checkpoint' }])
    if (query.startsWith('select task_id,channel,type,blob')) return rows(writes)
    if (query.startsWith('insert into')) {
      staged = await saver.serde.loadsTyped(String(values[6]), values[7] as Buffer)
      return rows()
    }
    throw new Error(`Unexpected checkpoint query: ${query}`)
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(client, () => {})
  return { values: () => checkpointValues, close: () => connection.close(),
    consume: (delivered: DurableInteraction) => connection.transaction(sql => saver.consumeApprovalInterrupt(sql, delivered)) }
}

it.each(approvalChoices)('delivers $kind choice $index and consumes its saved checkpoint', async choice => {
  const replay = new ActivityProductionReplay('approval-choice')
  const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
    undefined, 'scoped', undefined, replay.infrastructure().codex!)
  const session = await manager.createSession(input('/project'))
  const turn = manager.startTurn(session, { prompt: 'Approval choice', clientCorrelationId: 'approval-choice' })
  const stream = turn[Symbol.asyncIterator]()
  let checkpoint: Awaited<ReturnType<typeof checkpointFixture>> | undefined
  try {
    let event = await stream.next()
    while (!event.done && event.value.type !== 'turn.started') event = await stream.next()
    assert.equal(event.done, false)
    const thread = replay.threads.get(session.nativeSessionId)!
    const common = { threadId: session.nativeSessionId, turnId: thread.turns.at(-1)!.id, itemId: 'approval-item' }
    const requests = {
      command: { method: 'item/commandExecution/requestApproval', params: { ...common,
        command: 'echo approved', cwd: '/project', availableDecisions: commandDecisions } },
      file: { method: 'item/fileChange/requestApproval', params: { ...common, reason: null, grantRoot: null } },
      permission: { method: 'item/permissions/requestApproval', params: { ...common, cwd: '/project',
        permissions: { network: { enabled: true } } } },
    }
    replay.requests.set('approval-rpc', session.nativeSessionId)
    await replay.channels.get(session.nativeSessionId)!.request({ id: 'approval-rpc', ...requests[choice.kind] })
    const pending = (await manager.pending(session))!
    assert(pending)
    const counts = { command: commandDecisions.length, file: 4, permission: 3 }
    assert.equal(pending.responseOptions.length, counts[choice.kind])
    const selected = pending.responseOptions[choice.index]!
    const h = harness(manager, { ...pending,
      responseOptions: [selected, ...pending.responseOptions.filter(option => option !== selected)] })
    checkpoint = await checkpointFixture(h.get())
    h.control.onResume = delivered => checkpoint!.consume(delivered)
    assert.deepEqual(checkpoint.values(), [])
    const result = await h.respond()
    assert.deepEqual(replay.toolReplies.get('approval-rpc'), choice.response)
    assert.equal(result.interaction.status, 'delivered')
    assert.equal(result.interaction.deliveryState, 'delivered')
    assert.deepEqual(checkpoint.values(), [{ interactionId: result.interaction.id }])
    assert.equal(h.control.resumeState, 'completed')
    assert.equal(h.calls.resumes, 1)
    const history = await manager.history(session)
    assert.equal(history.pendingInteractions.length, 0)
    assert.equal(history.events.some(event => event.type === 'item.completed'), false)
    assert.deepEqual(history.responseDeliveries, [{ source: 'provider_acknowledgement', ...session,
      nativeRequestId: pending.turn.nativeRequestId, nativeRequestType: pending.nativeRequestType,
      optionId: selected.optionId, semantic: selected.semantic, responseDigest: responseValueDigest(selected.response) }])
    await h.respond()
    assert.equal(replay.responses.length, 1)
    assert.equal(h.calls.resumes, 1)
  } finally {
    await checkpoint?.close()
    await stream.return?.(undefined)
    await manager.shutdown()
  }
})
