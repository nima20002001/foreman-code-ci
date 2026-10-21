import { pendingSessionControls } from '../../harnesses/sessionControlDefaults.js'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { createRemoteExecutionHandler } from './executionRouter.js'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { deferred } from '../../../../test/helpers/deferred.js'
import { HarnessExecutionError } from '../../harnesses/errors.js'
import type { RemoteJobDispatchIntent } from '@foreman-code/contracts/remote-job-execution'
import { RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { persistentFixtureRoot } from '../../../../test/helpers/fixtureStorage.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DeviceHistoryPageSchema } from '@foreman-code/contracts/device-application'
import { RemoteNativeHistorySchema } from '@foreman-code/contracts/remote-workflow-physical'
import { DEFAULT_HARNESS_DEFAULTS, CODEX_APPROVAL_OPTIONS_FIXTURE, withInteractionResponse,
  type ApprovalResponseOption, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../interactions/runtimePorts.js'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteNativeSessionManager } from './nativeManagerProxy.js'
import { RemoteExecutionHost, type RemoteExecutionHostPorts } from './executionHost.js'
import { pageNativeHistory } from './nativeHistoryPage.js'
import { loadConfig } from '../../../config.js'
import { createDatabase } from '../../../infrastructure/database.js'
import { createCheckpointStore } from '../../../infrastructure/checkpoints.js'
import { OperatorRuntimeOwner } from '../../../infrastructure/operatorRuntimeOwner.js'
import { OperatorChatService } from '../../conversations/operatorChat.js'
import { AutomaticReviewService } from '../../interactions/automaticReview.js'
import { ApprovalExecutionCoordinator } from '../../interactions/execution.js'
import { LangGraphWorkflowEngine } from '../engine.js'
import { ProductionDeviceRuntime } from '../../devices/productionRuntime.js'
import { buildProductionApp } from '../../../production.js'
const roots: string[] = []
const journals: RemoteOperationJournal[] = []
const hosts: RemoteExecutionHost[] = []
const HistoryReplySchema = z.object({
  history: RemoteNativeHistorySchema, page: DeviceHistoryPageSchema,
}).passthrough()
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.drain())); await Promise.all(journals.splice(0).map(journal => journal.close())); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup(expectedToken?: string) {
  const root = await mkdtemp(join(persistentFixtureRoot, 'remote-execution-host-')); roots.push(root)
  const journalPath = join(root, 'journal')
  const journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
  journals.push(journal)
  const mainId = randomUUID(), deviceId = randomUUID(), installationId = randomUUID(), digest = 'a'.repeat(64)
  const configuration: AgentConfigurationVersion = { id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1, prompt: { system: 'test' }, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'sha256:test', createdAt: '2026-10-01T00:00:00.000Z' }
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run', nodeId: 'node', hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId: installationId, keyRevision: 1, authorizationRevision: 1 }, mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest }, source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const input = { value: 'accepted' }, inputDigest = `sha256:${createHash('sha256').update(canonicalGraphJson(input)).digest('hex')}`
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest, owner: { grantId: 'grant', epoch: '1' } })
  const request = { executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node', workingDirectory: '/project', runtimeDirectory: '/runtime/execution', configuration, input }
  const state = { starts: 0, turns: 0, cancels: 0, responds: 0, allowed: true }
  const session = { harness: 'codex' as const, providerVersion: 'test', nativeSessionId: 'native-session' }
  const manager: NativeHarnessSessionManager = { harness: 'codex', capabilities: async () => { throw new Error('unused') }, inspectMcp: async () => { throw new Error('unused') }, createSession: async () => { state.starts++; return session }, attachSession: async () => session,
    startTurn: async function* (_session, turn) { state.turns++; await turn.onSubmitted?.('native-turn'); yield { sequence: 1, type: 'event', occurredAt: '2026-10-01T00:00:00.000Z', payload: {} } }, pending: async () => undefined, respond: async () => { state.responds++ }, cancel: async () => { state.cancels++; return false }, history: async () => {
      const pending = await manager.pending(session)
      return { events: [], pendingInteractions: pending ? [pending] : [] }
    }, reconcile: async () => ({ events: [], pendingInteractions: [] }), close: async () => {} }
  const managers = new ExecutionScopedNativeSessionManagerResolver(() => manager)
  const ports: RemoteExecutionHostPorts = { journal, connection: { mainId, deviceId, workerInstallationId: installationId, bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }, incarnationId: randomUUID(), managers, authorize: async () => { if (!state.allowed) throw new Error('revoked') }, attestRuntimeLeaf: async (intent, placement, request) => { if (!placement.source.materializationId || !placement.source.materializationDigest) throw new Error('Original fixture has no materialized source'); return ({ executionId: intent.executionId, attemptId: intent.attemptId, operationId: intent.operationId, bindingHash: intent.bindingHash, canonicalRuntimeDirectory: request.runtimeDirectory, directoryIdentityHash: digest, materializationId: placement.source.materializationId, materializationDigest: placement.source.materializationDigest }) }, preflight: async (_request,access) => { if (expectedToken) { expect(access?.token).toBe(expectedToken); return {agentId:'agent',variables:{GRAPHQL_MCP_TOKEN:expectedToken}} } }, nativeEvidence: async () => ({ sessionId: 'native-session', processIdentityDigest: digest }), settle: async () => null }
  const host = new RemoteExecutionHost(ports)
  hosts.push(host)
  return { host, manager, managers, session, journal, journalPath, intent, placement, request, state, ports }
}

async function productionShutdownFixture() {
  const ownerClose = vi.spyOn(OperatorRuntimeOwner.prototype, 'close').mockResolvedValue()
  const managerDispose = vi.spyOn(ExecutionScopedNativeSessionManagerResolver.prototype, 'dispose').mockResolvedValue()
  const detach = vi.spyOn(ApprovalExecutionCoordinator.prototype, 'closeForRestart')
  const admission = vi.spyOn(ProductionDeviceRuntime.prototype, 'stopAdmission')
  const channels = vi.spyOn(ProductionDeviceRuntime.prototype, 'stop')
  const mocks = [ownerClose, managerDispose, detach, admission, channels,
    vi.spyOn(OperatorChatService.prototype, 'shutdown').mockResolvedValue(),
    vi.spyOn(AutomaticReviewService.prototype, 'shutdown').mockResolvedValue(),
    vi.spyOn(LangGraphWorkflowEngine.prototype, 'shutdown').mockResolvedValue()]
  const config = loadConfig({ DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_shutdown_fixture' })
  const database = createDatabase(config.database)
  const checkpoints = createCheckpointStore(config.database.connectionString, 'remote_shutdown_fixture', config.database)
  const production = buildProductionApp(config, database, checkpoints, false)
  return { production, ownerClose, managerDispose, detach, admission, channels,
    async close() {
      // Expected lifecycle rejections are asserted before this fixture releases its idle pools.
      await Promise.allSettled([production.app.close()])
      await Promise.all([database.close(), checkpoints.close()])
      for (const mock of mocks) mock.mockRestore()
    } }
}

describe('actual worker native-port adapter', () => {
  it('joins retained reviewer cancellation when Main closes the same session during physical settlement', async () => {
    const f = await setup()
    f.request.configuration.productRole = 'orchestrator'
    const correlationId = `execution:${f.intent.executionId}`
    const result = { outcome: 'succeeded' as const, output: { text: 'Original workflow result' } }
    const history = { events: [], pendingInteractions: [], correlationId, nativeTurnId: 'native-turn',
      terminalResult: result, terminalTurn: { correlationId, providerId: 'native-turn', result } }
    const settling = deferred()
    const releaseClosure = deferred()
    const controlEntered = deferred()
    let physicallyClosed = false
    let closingProvider = false
    f.manager.reconcile = async () => structuredClone(history)
    f.manager.cancel = async () => {
      f.state.cancels++
      if (closingProvider) throw new Error('The native session is already closing')
      return false
    }
    f.ports.settle = async (_intent, original) => {
      const status = await f.journal.status(f.intent.operationId)
      if (status.status !== 'known') throw new Error('Missing original settlement receipt')
      if (!status.receipt.stopFence) {
        await f.journal.retainReviewer(f.intent.operationId, { agentId: f.request.configuration.agentId,
          expiresAt: new Date(Date.now() + 60_000).toISOString() }, original)
        return null
      }
      closingProvider = true
      settling.resolve()
      await releaseClosure.promise
      physicallyClosed = true
      return { kind: 'cancelled', closureEvidenceDigest: 'a'.repeat(64) }
    }
    const enter = f.journal.enterControlDelivery.bind(f.journal)
    vi.spyOn(f.journal, 'enterControlDelivery').mockImplementation(async command => {
      const entered = await enter(command)
      if (entered) controlEntered.resolve()
      return entered
    })
    const command = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1,
      commandId: 'close-original-reviewer', operationId: f.intent.operationId, attemptId: f.intent.attemptId,
      executionId: f.intent.executionId, bindingHash: f.intent.bindingHash, owner: f.intent.owner,
      action: { kind: 'stop' } })
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement,
      harness: 'codex', configuration: f.request.configuration,
      transport: { request: (_method, frame) => f.host.handle(frame) },
      observeReceipt: async () => {}, controlFor: async () => command })
    const session = await proxy.createSession({ request: f.request, correlationId })
    await f.host.startTurn(f.intent.operationId, 'workflow', correlationId)
    await f.host.drain()
    const maintenance = f.host.closeRetainedReviewer(f.intent.operationId)
    let closing: Promise<void> | undefined
    try {
      await settling.promise
      closing = proxy.close(session)
      const outcome = Promise.allSettled([closing])
      await controlEntered.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(f.state.cancels).toBe(1)
      expect(physicallyClosed).toBe(false)
      releaseClosure.resolve()
      await expect(closing).resolves.toBeUndefined()
      await outcome
      await maintenance
      expect(physicallyClosed).toBe(true)
      expect(await f.journal.controlDelivery(command)).toBe('acknowledged')
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
        phase: 'confirmed_terminal', stopFence: true, terminal: { kind: 'cancelled' },
      } })
      expect(f.state).toMatchObject({ starts: 1, turns: 1, cancels: 1 })
    } finally {
      releaseClosure.resolve()
      await Promise.allSettled([maintenance, ...(closing ? [closing] : [])])
    }
  })

  it('finishes retained review closure when Stop overlaps an older retention settlement', async () => {
    const f = await setup()
    f.request.configuration.productRole = 'orchestrator'
    f.ports.authorizeReview = async () => {}
    const retaining = deferred()
    const releaseRetention = deferred()
    const stopped = deferred()
    const workflowCorrelation = `execution:${f.intent.executionId}`
    const reviewCorrelation = 'review-correlation'
    const result = { outcome: 'succeeded' as const, output: { text: 'original result' } }
    let activeCorrelation = workflowCorrelation
    let physicallyClosed = false
    let settlements = 0
    const history = (correlationId: string) => {
      const providerId = correlationId === workflowCorrelation ? 'native-turn' : 'review-turn'
      return { events: [], pendingInteractions: [], correlationId, nativeTurnId: providerId,
        terminalResult: result, terminalTurn: { correlationId, providerId, result } }
    }
    f.manager.history = async () => history(activeCorrelation)
    f.manager.reconcile = async (_session, correlationId) => history(correlationId)
    f.manager.startTurn = async function* (_session, input) {
      f.state.turns++
      activeCorrelation = input.clientCorrelationId
      await input.onSubmitted?.(activeCorrelation === workflowCorrelation ? 'native-turn' : 'review-turn')
      yield { sequence: f.state.turns, type: 'turn.completed', occurredAt: new Date().toISOString(), payload: {} }
    }
    f.manager.cancel = async () => { f.state.cancels++; stopped.resolve(); return false }
    f.ports.settle = async (_intent, original) => {
      settlements++
      const status = await f.journal.status(f.intent.operationId)
      if (status.status !== 'known') throw new Error('Missing original settlement receipt')
      if (!status.receipt.stopFence) {
        await f.journal.retainReviewer(f.intent.operationId, {
          agentId: f.request.configuration.agentId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, original)
        retaining.resolve()
        await releaseRetention.promise
        return null
      }
      physicallyClosed = true
      return { kind: 'cancelled', closureEvidenceDigest: 'a'.repeat(64) }
    }
    const controlFor = vi.fn(async (input: Parameters<ConstructorParameters<typeof RemoteNativeSessionManager>[0]['controlFor']>[0]) => ({
      schemaVersion: 1 as const, protocolVersion: 1 as const, commandId: 'original-stop',
      operationId: f.intent.operationId, attemptId: f.intent.attemptId, executionId: f.intent.executionId,
      bindingHash: f.intent.bindingHash, owner: f.intent.owner, native: input.native, action: { kind: 'stop' as const },
    }))
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement,
      harness: 'codex', configuration: f.request.configuration,
      transport: { request: (_method, frame) => f.host.handle(frame) }, observeReceipt: async () => {}, controlFor })
    let closing: Promise<void> | undefined
    try {
      const session = await proxy.createSession({ request: f.request, correlationId: workflowCorrelation })
      await f.host.startTurn(f.intent.operationId, 'workflow', workflowCorrelation)
      await retaining.promise
      await f.host.startTurn(f.intent.operationId, 'review', reviewCorrelation, {
        jobId: 'original-review', interactionId: 'interaction', reviewerAgentId: f.request.configuration.agentId,
        correlationId: reviewCorrelation, session, leaseToken: 'review-lease',
      })
      await f.host.drain()
      expect(await f.journal.reviewHistory(f.intent.operationId, reviewCorrelation)).toEqual(history(reviewCorrelation))
      closing = proxy.close(session)
      const outcome = Promise.allSettled([closing])
      await stopped.promise
      expect(physicallyClosed).toBe(false)
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'stop_requested', stopFence: true },
      })
      releaseRetention.resolve()
      await expect(closing).resolves.toBeUndefined()
      await outcome
      expect(physicallyClosed).toBe(true)
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'confirmed_terminal', terminal: { kind: 'cancelled' } },
      })
      expect(await f.journal.reviewHistory(f.intent.operationId, reviewCorrelation)).toEqual(history(reviewCorrelation))
      expect(f.state).toMatchObject({ starts: 1, turns: 2, cancels: 1 })
      expect(controlFor).toHaveBeenCalledOnce()
      expect(settlements).toBe(2)
    } finally {
      releaseRetention.resolve()
      await Promise.allSettled(closing ? [closing] : [])
      await f.host.drain()
    }
  })

  it('coalesces duplicate Stop closure checks after the pending pass already observed its fence', async () => {
    const f = await setup()
    const settling = deferred()
    const release = deferred()
    const acknowledged = deferred()
    let settlements = 0
    f.ports.settle = async () => {
      settlements++
      settling.resolve()
      await release.promise
      return null
    }
    const command = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1,
      commandId: 'original-stop', operationId: f.intent.operationId, attemptId: f.intent.attemptId,
      executionId: f.intent.executionId, bindingHash: f.intent.bindingHash, owner: f.intent.owner,
      action: { kind: 'stop' } })
    await f.host.prepare(f)
    const first = f.host.control(command)
    await settling.promise
    const delivery = f.journal.controlDelivery.bind(f.journal)
    const spy = vi.spyOn(f.journal, 'controlDelivery').mockImplementation(async value => {
      const phase = await delivery(value)
      if (phase === 'acknowledged') acknowledged.resolve()
      return phase
    })
    const second = f.host.control(command)
    try {
      await acknowledged.promise
      // The acknowledged branch enters settlement before the next event-loop turn.
      await new Promise<void>(resolve => setImmediate(resolve))
      release.resolve()
      await Promise.all([first, second])
      expect(settlements).toBe(1)
      expect(f.state.cancels).toBe(1)
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'stop_requested', stopFence: true },
      })
    } finally {
      release.resolve()
      await Promise.allSettled([first, second])
      spy.mockRestore()
    }
  })

  it('aborts operation preflight before awaiting preparation cleanup', async () => {
    const f = await setup()
    const entered = deferred()
    const release = deferred()
    let preflightSignal: AbortSignal | undefined
    f.ports.preflight = async (_request, _access, signal) => {
      preflightSignal = signal
      entered.resolve()
      await release.promise
      signal?.throwIfAborted()
    }
    const preparing = f.host.prepare(f)
    const preparationResult = Promise.allSettled([preparing])
    await entered.promise
    await expect(f.host.prepare({ ...f, request: { ...f.request, input: { changed: true } } }))
      .rejects.toThrow('binding mismatch')
    const stopping = f.host.abortPreparation(f.intent.operationId)
    try {
      expect(preflightSignal).toBeDefined()
      expect(preflightSignal?.aborted).toBe(true)
    } finally {
      release.resolve()
      await stopping
      await preparationResult
    }
    expect(f.state.starts).toBe(0)
  })

  it.each(['same', 'changed-host', 'unclosed'] as const)(
    'continues only a closed native session on its accepted placement (%s)', async scenario => {
      const f = await setup()
      const create = vi.spyOn(f.manager, 'createSession')
      f.ports.settle = async () => ({ kind: 'completed', closureEvidenceDigest: 'a'.repeat(64),
        result: { outcome: 'succeeded' } })
      await f.host.prepare(f)
      if (scenario !== 'unclosed') {
        await f.host.startTurn(f.intent.operationId, 'original turn', `execution:${f.intent.executionId}`)
        await f.host.drain()
      }
      const pins: Omit<typeof f.placement, 'bindingHash'> & { bindingHash?: string } = { ...f.placement }
      delete pins.bindingHash
      const placement = scenario === 'changed-host' ? freezePlacement({ ...pins,
        hostRef: { kind: 'device', mainId: f.placement.hostRef.mainId, deviceId: randomUUID() } }) : f.placement
      const intent = deriveDispatch(placement, { executionId: 'reactivated', occurrenceId: null,
        occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'reactivated-attempt',
        operationId: 'reactivated-operation', inputDigest: f.intent.inputDigest, owner: f.intent.owner })
      const sessionContinuation = { previousExecutionId: f.intent.executionId,
        previousOperationId: f.intent.operationId, session: f.session }
      const preparing = f.host.prepare({ intent, placement, request: { ...f.request,
        executionId: intent.executionId, runtimeDirectory: '/runtime/reactivated' }, sessionContinuation })
      if (scenario === 'same') {
        expect(await preparing).toMatchObject({ session: f.session })
        expect(create.mock.calls[1]![0]).toMatchObject({ sessionContinuation })
      } else {
        const reason = scenario === 'changed-host' ? 'Remote launch binding mismatch'
          : 'closed execution on the same host and placement'
        await expect(preparing).rejects.toThrow(reason)
        expect(create).toHaveBeenCalledTimes(1)
      }
    })
  it('forwards the saved workflow system prompt into worker native session startup', async () => {
    const f = await setup()
    const systemPrompt = { value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3' }
    const create = vi.spyOn(f.manager, 'createSession')
    const preflight = vi.spyOn(f.ports, 'preflight')
    await f.host.prepare({ ...f, request: { ...f.request, systemPrompt } })
    expect(preflight.mock.calls[0]![0].systemPrompt).toEqual(systemPrompt)
    expect(create.mock.calls[0]![0]).toMatchObject({ request: { systemPrompt } })
    expect(f.state.starts).toBe(1)
  })

  it.each(['prepare', 'inspect'] as const)('rejects retired OpenCode before %s can allocate a native manager', async operation => {
    const f = await setup()
    const configuration: AgentConfigurationVersion = {
      ...f.request.configuration,
      harness: { harness: 'opencode', model: 'saved-provider/model', variant: '',
        nativeAgent: 'build', thinking: true, autoApprove: false },
    }
    const resolve = vi.spyOn(f.managers, 'resolve')
    const preflight = vi.spyOn(f.ports, 'preflight')
    const result = operation === 'prepare'
      ? f.host.prepare({ ...f, request: { ...f.request, configuration } })
      : f.host.inspect({ ...f, configuration }, 'capabilities')
    await expect(result).rejects.toMatchObject({ code: 'HARNESS_RETIRED' })
    expect(resolve).not.toHaveBeenCalled()
    expect(preflight).not.toHaveBeenCalled()
    expect(await f.journal.status(f.intent.operationId)).toEqual({
      status: 'unknown', reason: 'journal_absence_requires_reconciliation',
    })
    expect(f.state.starts).toBe(0)
    expect(configuration.harness.harness).toBe('opencode')
  })
  it.each(['questions', 'form'] as const)('delivers validated %s values once and recovers the complete response', async kind => {
    const f = await setup()
    await f.host.prepare(f)
    await f.host.startTurn('operation', 'prompt', 'execution:execution')
    await f.host.drain()
    const offered: ApprovalResponseOption = { ...CODEX_APPROVAL_OPTIONS_FIXTURE[0]!, input: kind === 'form'
      ? { kind, schema: { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 1 } } } }
      : { kind, questions: [{ id: 'answer', header: 'Answer', question: 'Enter a value', isSecret: false,
        isOther: true, options: null }] } }
    const response = kind === 'form' ? { count: 2 } : { answer: { answers: ['Entered'] } }
    const selected = withInteractionResponse(offered, response)
    f.manager.pending = async () => ({ session: f.session,
      turn: { nativeTurnId: 'native-turn', nativeRequestId: 'question' },
      nativeRequestType: 'input', request: {}, responseOptions: [offered] })
    const respond = vi.fn(async () => {})
    f.manager.respond = respond
    const status = await f.journal.status('operation')
    if (status.status !== 'known') throw new Error('Missing receipt')
    const command = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1, commandId: 'response', operationId: f.intent.operationId,
      attemptId: f.intent.attemptId, executionId: f.intent.executionId, bindingHash: f.intent.bindingHash,
      owner: f.intent.owner, native: status.receipt.native, action: { kind: 'respond', interactionId: 'interaction',
        interactionRevision: '1', nativeInteractionId: 'question', response: selected } })
    await expect(f.host.control({ ...command, action: { ...command.action,
      response: { ...selected, response: {} } } })).rejects.toThrow()
    expect(respond).not.toHaveBeenCalled()
    await f.host.control(command)
    await f.host.control(command)
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith(f.session, 'question', selected)
    await f.journal.close()
    const reopened = await RemoteOperationJournal.open(f.journalPath)
    journals.push(reopened)
    expect((await reopened.control(command)).dispatch).toBe(false)
    expect((await reopened.status('operation'))).toMatchObject({ receipt: { controls: [command] } })
  })

  it('pages authenticated history without relaxing grants or the original execution owner', async () => {
    const f = await setup()
    await f.host.prepare({ intent: f.intent, placement: f.placement, request: f.request })
    const events = Array.from({ length: 70 }, (_, sequence) => ({ sequence, type: 'native.notification',
      occurredAt: '2026-10-01T00:00:00.000Z', payload: { text: 'x'.repeat(20_000) } }))
    f.manager.reconcile = vi.fn(async () => ({ events, pendingInteractions: [], firstRetainedSequence: 0,
      nextSequence: events.length }))
    const request = { method: 'history', intent: f.intent, placement: f.placement, afterSequence: -1 }
    const first = HistoryReplySchema.parse(await f.host.handle(request))
    expect(first.page.hasMore).toBe(true)
    expect(first.history.events[0]?.sequence).toBe(0)
    const second = HistoryReplySchema.parse(await f.host.handle({
      ...request, afterSequence: first.page.nextAfterSequence,
    }))
    expect(second.history.events[0]?.sequence).toBe(first.page.nextAfterSequence + 1)
    f.state.allowed = false
    await expect(f.host.handle(request)).rejects.toThrow('revoked')
    f.state.allowed = true
    await expect(f.host.handle({ ...request, intent: { ...f.intent, executionId: 'foreign-execution' } }))
      .rejects.toThrow('RPC stale execution owner')
    expect(f.manager.reconcile).toHaveBeenCalledTimes(2)
  })

  it('refreshes Main context usage from paginated Worker history without a controls read', async () => {
    const f = await setup()
    const events = Array.from({ length: 70 }, (_, sequence) => ({ sequence, type: 'native.notification',
      occurredAt: '2026-10-01T00:00:00.000Z', payload: { text: 'x'.repeat(20_000) } }))
    let usedTokens = 120
    f.manager.reconcile = async () => ({ events, pendingInteractions: [], firstRetainedSequence: 0,
      nextSequence: events.length })
    f.manager.contextSnapshot = () => ({ nativeSessionId: f.session.nativeSessionId,
      model: f.request.configuration.harness.model, generation: 'worker', sequence: usedTokens,
      observedAt: new Date().toISOString(), source: 'codex', accuracy: 'native',
      usedTokens, capacityTokens: 1000, lifetimeTokens: usedTokens, cost: null, stale: false })
    const replies: unknown[] = []
    const methods: string[] = []
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex',
      configuration: f.request.configuration, transport: { request: async (method, frame) => {
        methods.push(method)
        const response = await f.host.handle(frame)
        if (method === 'history') replies.push(response)
        return response
      } }, observeReceipt: async () => {}, controlFor: async () => { throw new Error('No control requested') } })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    const firstPage = await f.host.handle({ method: 'history', intent: f.intent,
      placement: f.placement, afterSequence: -1 })
    expect(firstPage).toMatchObject({ context: { usedTokens: 120 }, page: { hasMore: true } })
    expect((await proxy.history(session)).events.length).toBeLessThan(events.length)
    expect(replies[0]).toMatchObject({ context: { usedTokens: 120 } })
    expect(proxy.contextSnapshot(session)?.usedTokens).toBe(120)
    usedTokens = 450
    await proxy.history(session)
    expect(proxy.contextSnapshot(session)?.usedTokens).toBe(450)
    expect(methods).toEqual(['prepare', 'history', 'history'])
    f.state.allowed = false
    await expect(proxy.history(session)).rejects.toThrow('revoked')
    expect(proxy.contextSnapshot(session)?.usedTokens).toBe(450)
  })

  it('production detaches the running remote resident before closing channels or releasing ownership', async () => {
    const f = await setup()
    let channelsClosed = false
    let detachEntered!: () => void
    let releaseDetachment!: () => void
    const entered = new Promise<void>(resolve => { detachEntered = resolve })
    const released = new Promise<void>(resolve => { releaseDetachment = resolve })
    const order: string[] = []
    const proxy = new RemoteNativeSessionManager({
      intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: async (method, frame) => {
        if (channelsClosed) throw new Error('Device channel closed')
        expect(method).toBe('prepare')
        return f.host.handle(frame)
      } },
      observeReceipt: async () => {}, controlFor: async () => { throw new Error('No control is requested') },
    })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    await f.host.startTurn(f.intent.operationId, 'original prompt', 'execution:execution')
    await f.host.drain()
    const original = await f.journal.status(f.intent.operationId)
    const runtime = await productionShutdownFixture()
    runtime.detach.mockImplementation(async () => {
      detachEntered()
      await released
      await proxy.closeForRestart(session)
      order.push('resident detached')
    })
    runtime.managerDispose.mockImplementation(async () => { await proxy.dispose(); order.push('manager disposed') })
    runtime.channels.mockImplementation(() => { channelsClosed = true; order.push('channels closed') })
    runtime.ownerClose.mockImplementation(async () => { order.push('ownership released') })
    const closing = runtime.production.shutdown()
    try {
      await Promise.race([entered, closing.then(() => {
        throw new Error('Shutdown finished before detaching the remote resident')
      })])
      expect(runtime.admission).toHaveBeenCalledOnce()
      expect(runtime.channels).not.toHaveBeenCalled()
      expect(runtime.managerDispose).not.toHaveBeenCalled()
      expect(runtime.ownerClose).not.toHaveBeenCalled()
      await expect(runtime.production.initialize()).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_CLOSING' })
      releaseDetachment()
      await closing
      expect(order).toEqual(['resident detached', 'manager disposed', 'channels closed', 'ownership released'])
      expect(await f.journal.status(f.intent.operationId)).toEqual(original)
      expect(f.state).toMatchObject({ starts: 1, turns: 1, cancels: 0 })
    } finally {
      releaseDetachment()
      await Promise.allSettled([closing])
      await runtime.close()
    }
  })

  it('production retains the channel and manager after failed detachment persistence and retries before releasing ownership', async () => {
    const f = await setup()
    let persistenceUnavailable = true
    const proxy = new RemoteNativeSessionManager({
      intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (method, frame) => {
        expect(method).toBe('prepare')
        return f.host.handle(frame)
      } },
      observeReceipt: async () => {}, controlFor: async () => { throw new Error('No control is requested') },
    })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    const original = await f.journal.status(f.intent.operationId)
    const runtime = await productionShutdownFixture()
    runtime.detach.mockImplementation(async () => {
      await proxy.closeForRestart(session)
      if (persistenceUnavailable) throw new Error('Detachment persistence unavailable')
    })
    runtime.managerDispose.mockImplementation(() => proxy.dispose())
    try {
      await expect(runtime.production.shutdown()).rejects.toThrow('runtime ownership was not released')
      expect(runtime.channels).not.toHaveBeenCalled()
      expect(runtime.managerDispose).not.toHaveBeenCalled()
      expect(runtime.ownerClose).not.toHaveBeenCalled()
      expect(proxy.canDetachForRestart(session)).toBe(false)
      expect(await f.journal.status(f.intent.operationId)).toEqual(original)
      expect(f.state).toMatchObject({ starts: 1, turns: 0, cancels: 0 })
      persistenceUnavailable = false
      await runtime.production.drainShutdown()
      expect(runtime.detach).toHaveBeenCalledTimes(2)
      expect(runtime.managerDispose).toHaveBeenCalledOnce()
      expect(runtime.channels).toHaveBeenCalledOnce()
      expect(runtime.ownerClose).toHaveBeenCalledOnce()
      expect(await f.journal.status(f.intent.operationId)).toEqual(original)
      expect(f.state).toMatchObject({ starts: 1, turns: 0, cancels: 0 })
    } finally { await runtime.close() }
  })

  it('detaches a resident session once and can repeat detachment after transport closes', async () => {
    const f = await setup()
    let connected = true
    const methods: string[] = []
    const proxy = new RemoteNativeSessionManager({
      intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (method, frame) => {
        if (!connected) throw new Error('Device channel closed')
        methods.push(method)
        return f.host.handle(frame)
      } },
      observeReceipt: async () => {}, controlFor: async () => { throw new Error('No control is requested') },
    })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    await proxy.closeForRestart(session)
    connected = false
    await proxy.closeForRestart(session)
    await proxy.dispose()
    await expect(proxy.closeForRestart({ ...session, nativeSessionId: 'another-session' })).rejects.toThrow('Wrong remote native session')
    expect(methods).toEqual(['prepare'])
    expect(f.state.starts).toBe(1)
    expect(f.state.cancels).toBe(0)
    expect((await f.journal.status(f.intent.operationId)).status).toBe('known')
  })

  it('detaches the admitted session while history is unavailable and preserves its continuation', async () => {
    const f = await setup()
    let unavailable = false
    const proxy = new RemoteNativeSessionManager({
      intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (method, frame) => {
        if (unavailable && method === 'history') throw new Error('History unavailable')
        return f.host.handle(frame)
      } },
      observeReceipt: async () => {}, controlFor: async () => { throw new Error('No control is requested') },
    })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    unavailable = true
    const original = await f.journal.status(f.intent.operationId)
    await expect(proxy.closeForRestart(session)).resolves.toBeUndefined()
    await expect(proxy.dispose()).resolves.toBeUndefined()
    expect(await f.journal.status(f.intent.operationId)).toEqual(original)
    unavailable = false
    await proxy.closeForRestart(session)
    await proxy.dispose()
    expect(f.state.starts).toBe(1)
    expect(f.state.cancels).toBe(0)
  })

  it('forwards controls and usage with journaled compact retries without settling the workflow', async () => {
    const f = await setup()
    let compactions = 0
    Object.assign(f.manager, {
      sessionControlCapabilities: async () => pendingSessionControls(f.request.configuration.harness),
      contextSnapshot: () => ({ nativeSessionId: f.session.nativeSessionId, model: f.request.configuration.harness.model,
        generation: 'worker', sequence: 1, observedAt: new Date().toISOString(), source: 'codex', accuracy: 'native',
        usedTokens: 120, capacityTokens: 1000, lifetimeTokens: 300, cost: null, stale: false }),
      appliedSessionPreferences: () => SessionPreferencesSchema.parse({}),
      compactSession: async (_session: unknown, input: { requestId: string }) => {
        compactions++
        return { requestId: input.requestId, nativeSessionId: f.session.nativeSessionId, nativeOperationId: 'native-boundary',
          status: 'completed', message: 'Context compacted.', beforeTokens: 120, observedAt: new Date().toISOString() }
      },
    })
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex',
      configuration: f.request.configuration, transport: { request: async (_method, frame) => f.host.handle(frame) },
      observeReceipt: async () => {}, controlFor: async () => { throw new Error('Stop/response was not requested') } })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    await proxy.sessionControlCapabilities(session)
    expect(proxy.contextSnapshot(session)?.usedTokens).toBe(120)
    const input = { requestId: 'compact-worker-request', clientCorrelationId: 'compact-worker-correlation', onProgress: async () => {} }
    expect((await proxy.compactSession(session, input)).status).toBe('completed')
    expect((await proxy.compactSession(session, input)).status).toBe('completed')
    expect(compactions).toBe(1)
    const status = await f.journal.status(f.intent.operationId)
    expect(status.status === 'known' && status.receipt.phase).not.toBe('confirmed_terminal')
    f.state.allowed = false
    await expect(proxy.sessionControlCapabilities(session)).rejects.toThrow('revoked')
  })

  it('reuses a streamed history and acknowledges a refreshed turn before its next event', async () => {
    const f = await setup()
    const events = [0, 1].map(sequence => ({ sequence, type: 'native.notification',
      occurredAt: '2026-10-01T00:00:00.000Z', payload: { sequence } }))
    const submitted: string[] = []
    const observedEvents: Array<{ sequence: number; turnId: string | undefined; submitted: string[] }> = []
    let historyReads = 0
    const proxy = new RemoteNativeSessionManager({
      intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: async (method, frame) => {
        if (method === 'start-turn') {
          await f.journal.reserveTurn(f.intent.operationId, {
            correlationId: 'execution:execution', promptDigest: createHash('sha256').update('prompt').digest('hex'),
          })
          return f.journal.status(f.intent.operationId)
        }
        if (method !== 'history') return f.host.handle(frame)
        historyReads++
        const status = await f.journal.status(f.intent.operationId)
        if (status.status !== 'known') throw new Error('Original receipt is unavailable')
        const turnId = status.receipt.native?.turnId
        return { status, ...pageNativeHistory({ events, pendingInteractions: [], correlationId: 'execution:execution',
          ...(turnId ? { nativeTurnId: turnId } : {}) }, (frame as { afterSequence?: number }).afterSequence) }
      } },
      observeReceipt: async () => {},
      observeOriginalSource: async (receipt, source) => {
        if (source.type === 'event') {
          observedEvents.push({ sequence: source.event.sequence, turnId: receipt.native?.turnId,
            submitted: [...submitted] })
        }
      },
      controlFor: async () => { throw new Error('No control is requested') },
    })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    const stream = proxy.startTurn(session, { prompt: 'prompt', clientCorrelationId: 'execution:execution',
      onSubmitted: async id => { submitted.push(id) } })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      expect((await stream.next()).value).toEqual(events[0])
      expect((await proxy.history(session)).events).toEqual(events)
      expect((await proxy.history(session)).events).toEqual(events)
      expect(historyReads).toBe(1)
      await f.journal.acknowledgeTurn(f.intent.operationId, 'native-turn')
      clock.mockReturnValue(now + 30_001)
      expect((await proxy.history(session)).nativeTurnId).toBe('native-turn')
      expect(historyReads).toBe(2)
      expect((await stream.next()).value).toEqual(events[1])
      expect(observedEvents).toEqual([
        { sequence: 0, turnId: undefined, submitted: [] },
        { sequence: 1, turnId: 'native-turn', submitted: ['native-turn'] },
      ])
      // The refreshed cursor page already owns event 1 for this receipt.
      expect(historyReads).toBe(2)
      await stream.return(undefined)
      expect((await proxy.history(session)).events).toEqual(events)
      expect(historyReads).toBe(3)
      expect(f.state.starts).toBe(1)
    } finally {
      await stream.return(undefined)
      clock.mockRestore()
    }
  })

  it('retains the real terminal provider history when an authoritative closure callback disposes the manager', async () => {
    const { host, manager, ports, intent, placement, request } = await setup()
    const history = { events: [], pendingInteractions: [], correlationId: 'execution:execution', terminalResult: { outcome: 'succeeded' as const, output: { answer: 'original provider result' } } }
    const reconcile = vi.fn(async () => history)
    manager.reconcile = reconcile
    ports.settle = vi.fn(async () => {
      manager.reconcile = async () => { throw new Error('Original native runtime already closed') }
      manager.pending = async () => { throw new Error('Closed native runtime must not be re-entered') }
      return { kind: 'completed' as const, closureEvidenceDigest: 'a'.repeat(64), result: history.terminalResult }
    })
    await host.prepare({ intent, placement, request })
    await host.startTurn('operation', 'accepted prompt', 'execution:execution')
    await host.drain()
    expect(await host.read('operation', 'history')).toMatchObject({ history, status: { status: 'known', receipt: { phase: 'confirmed_terminal' } } })
    expect(await host.read('operation', 'pending')).toBeUndefined()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(ports.settle).toHaveBeenCalledTimes(1)
  })

  it('recovers response history after terminal settlement disposes the original provider', async () => {
    const f = await setup()
    const history = { events: [], pendingInteractions: [], correlationId: 'execution:execution',
      terminalResult: { outcome: 'succeeded' as const, output: { text: 'Original result' } } }
    f.manager.reconcile = async () => history
    f.manager.reconcileResponse = vi.fn(async () => { throw new Error('Original provider was disposed') })
    f.ports.settle = async () => ({ kind: 'completed', closureEvidenceDigest: 'a'.repeat(64),
      result: history.terminalResult })
    await f.host.prepare(f)
    await f.host.startTurn(f.intent.operationId, 'original prompt', 'execution:execution')
    await f.host.drain()
    const request = { method: 'reconcile-response', intent: f.intent, placement: f.placement,
      response: { nativeRequestId: 'question', nativeRequestType: 'approval', option: CODEX_APPROVAL_OPTIONS_FIXTURE[0]! } }
    const reply = HistoryReplySchema.parse(await f.host.handle(request))
    expect(reply.history).toMatchObject(history)
    expect(reply.history.responseDeliveries).toBeUndefined()
    expect(f.manager.reconcileResponse).not.toHaveBeenCalled()
    f.state.allowed = false
    await expect(f.host.handle(request)).rejects.toThrow('revoked')
  })

  it('releases acknowledged terminal residents while preserving status and rejecting replacement launch', async () => {
    const f = await setup()
    f.ports.settle = async () => ({ kind: 'completed', closureEvidenceDigest: 'a'.repeat(64),
      result: { outcome: 'succeeded', output: { text: 'Original result' } } })
    f.manager.dispose = vi.fn(async () => {})
    const release = vi.spyOn(f.managers, 'release')
    await f.host.prepare(f)
    await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution')
    await f.host.drain()
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known') throw new Error('Missing terminal receipt')
    await expect(f.host.retireSettled(f.intent.operationId)).rejects.toThrow('journal retirement required')
    expect(f.manager.dispose).not.toHaveBeenCalled()
    await f.journal.retireSettled(f.intent, status.receipt.sequence)
    await f.host.retireSettled(f.intent.operationId)
    await f.host.retireSettled(f.intent.operationId)
    expect(f.manager.dispose).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(await f.host.handle({ method: 'status', intent: f.intent, placement: f.placement })).toEqual(status)
    await expect(f.host.prepare(f)).rejects.toThrow('requires reconciliation')
    await expect(f.host.read(f.intent.operationId, 'history')).rejects.toThrow('Original native owner requires reconciliation')
    expect(f.state.starts).toBe(1)
    expect(f.state.turns).toBe(1)
  })
  it('retires an inspected manager without retaining it for a second shutdown disposal', async () => {
    const f = await setup()
    f.manager.capabilities = async () => ({ provider: 'codex', providerVersion: 'test',
      persistentSessions: true, reconnect: false, sameRequestResponses: true, cancellation: true,
      history: true, configurationInspection: true, mcpDetection: true, supportedInteractionKinds: [] })
    f.manager.dispose = vi.fn(async () => {})
    await f.host.inspect({ intent: f.intent, placement: f.placement,
      configuration: f.request.configuration }, 'capabilities')
    await f.host.control({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop',
      operationId: f.intent.operationId, executionId: f.intent.executionId, attemptId: f.intent.attemptId,
      bindingHash: f.intent.bindingHash, owner: f.intent.owner, action: { kind: 'stop' } })
    const terminal = await f.journal.terminal(f.intent.operationId, {
      kind: 'not_started', closureEvidenceDigest: 'a'.repeat(64),
    })
    await f.journal.retireSettled(f.intent, terminal.sequence)
    await f.host.retireSettled(f.intent.operationId)
    await f.host.shutdown()
    expect(f.manager.dispose).toHaveBeenCalledOnce()
    expect(f.state.starts).toBe(0)
  })
  it('keeps a workflow-only host available without substituting it for the missing OCI Job runtime', async () => {
    const { host } = await setup()
    const execution = jobExecution()
    const intent: RemoteJobDispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: execution.acceptedSpec.target.mainId,
      subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId },
      executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId,
      bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, owner: execution.owner }
    const called = vi.spyOn(host, 'handle')
    const handler = createRemoteExecutionHandler(host)
    expect(() => handler({ method: 'job-status', intent })).toThrow('no installed Job runtime')
    expect(called).not.toHaveBeenCalled()
  })

  it('joins a pending native allocation and disposes its actual manager before shutdown returns', async () => {
    const { host, manager, session, intent, placement, request, state } = await setup()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
    manager.createSession = async (_input, signal) => { enter(); await released; signal?.throwIfAborted(); state.starts++; return session }
    manager.dispose = vi.fn(async () => {})
    const pending = host.prepare({ intent, placement, request })
    await entered
    let closed = false
    const closing = host.shutdown().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await expect(pending).rejects.toThrow()
    await closing
    await host.shutdown()
    expect(manager.dispose).toHaveBeenCalledTimes(1)
    expect(state.starts).toBe(0)
    await expect(host.prepare({ intent, placement, request })).rejects.toThrow('shutting down')
  })

  it.each(['physical-readout', 'physical-ack'] as const)('refuses generic %s without claiming installed physical evidence', async method => {
    const f = await setup()
    await expect(f.host.handle({ method, intent: f.intent, placement: f.placement, receiptSequence: 1, sourceDigest: 'a'.repeat(64) })).rejects.toThrow('generic execution host')
    expect(f.state.starts).toBe(0)
  })
  it('retains authenticated receipt before observing the actual source and returning its session', async () => {
    const f = await setup(), order: string[] = []
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (_method, frame) => f.host.handle(frame) },
      observeReceipt: async receipt => { order.push(`receipt:${receipt.phase}`) },
      observeOriginalSource: async (_receipt, source) => { expect(f.state.starts).toBe(1); order.push(`source:${source.type}`) },
      controlFor: async () => { throw new Error('unused') } })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' }); order.push('returned')
    expect(order).toEqual(['receipt:start_acknowledged', 'source:session_created', 'returned'])
    order.length = 0
    await proxy.observeBoundary(session)
    await proxy.observeBoundary(session)
    expect(order).toEqual(['receipt:start_acknowledged', 'source:boundary',
      'receipt:start_acknowledged', 'source:boundary'])
    expect(f.state.starts).toBe(1)
    expect(f.state.turns).toBe(0)
  })
  it('retains uncertainty when physical source verification fails after the worker created its session', async () => {
    const f = await setup()
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (_method, frame) => f.host.handle(frame) }, observeReceipt: async () => {},
      observeOriginalSource: async () => { throw new Error('original physical source unavailable') },
      controlFor: async () => { throw new Error('unused') } })
    await expect(proxy.createSession({ request: f.request, correlationId: 'execution:execution' })).rejects.toThrow('original physical source unavailable')
    await expect(proxy.dispose()).rejects.toThrow('disposal is unconfirmed')
    expect(f.state.starts).toBe(1)
  })
  it('uses the native manager once across duplicated delivery and turn requests', async () => { const { host, intent, placement, request, state } = await setup(); await host.prepare({ intent, placement, request }); await host.prepare({ intent, placement, request }); expect(state.starts).toBe(1); await host.startTurn('operation', 'accepted prompt', 'execution:execution'); await host.startTurn('operation', 'accepted prompt', 'execution:execution'); expect(state.turns).toBe(1); await host.drain() })
  it('routes the main native port through the shared bound RPC and observes requested cancellation', async () => {
    const { host, intent, placement, request, state } = await setup()
    const observed: string[] = []
    const proxy = new RemoteNativeSessionManager({ intent, placement, harness: 'codex', configuration: request.configuration,
      transport: { request: (_method, frame) => host.handle(frame) }, observeReceipt: async receipt => { observed.push(receipt.phase) },
      controlFor: async ({ native }) => ({ schemaVersion: 1, protocolVersion: 1, commandId: 'proxy-stop', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner, native, action: { kind: 'stop' } }) })
    const session = await proxy.createSession({ request, correlationId: 'execution:execution' })
    expect(await proxy.cancel(session)).toBe(false)
    expect(state.starts).toBe(1)
    expect(state.cancels).toBe(1)
    expect(observed).toEqual(['start_acknowledged', 'start_acknowledged', 'stop_requested', 'stop_requested'])
  })
  it('reuses only the exact ephemeral main worker MCP lease without journaling it', async () => {
    const token = 'test-exact-main-lease', { host, intent, placement, request, journal, state } = await setup(token)
    const proxy = new RemoteNativeSessionManager({ intent, placement, harness: 'codex', configuration: request.configuration,
      transport: { request: (_method, frame) => host.handle(frame) }, observeReceipt: async () => {},
      controlFor: async ({ native }) => ({ schemaVersion:1,protocolVersion:1,commandId:'stop',operationId:intent.operationId,attemptId:intent.attemptId,executionId:intent.executionId,bindingHash:intent.bindingHash,owner:intent.owner,native,action:{kind:'stop'} }) })
    await expect(proxy.createSession({request,correlationId:'execution:execution',environment:{agentId:'agent',variables:{GRAPHQL_MCP_TOKEN:token,OPENAI_API_KEY:'must-stay-host-local'}}})).rejects.toThrow('Only the exact scoped')
    expect(state.starts).toBe(0)
    await proxy.createSession({request,correlationId:'execution:execution',environment:{agentId:'agent',variables:{GRAPHQL_MCP_TOKEN:token}}})
    expect(state.starts).toBe(1);expect(JSON.stringify(await journal.status(intent.operationId))).not.toContain(token)
  })
  it('Stop delivered before Start persists a negative fence before any native manager launch', async () => { const { host, intent, placement, request, state } = await setup(); await host.control({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner, action: { kind: 'stop' } }, { intent, placement }); await expect(host.prepare({ intent, placement, request })).rejects.toThrow('reconciliation'); expect(state.starts).toBe(0) })
  it('Stop during delayed native creation aborts the owned launch signal and retains uncertainty', async () => {
    const { host, manager, session, journal, intent, placement, request, state } = await setup()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
    manager.createSession = async (_input, signal) => { enter(); await released; signal?.throwIfAborted(); state.starts++; return session }
    const pending = host.prepare({ intent, placement, request }); await entered
    await host.control({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop-during-start', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner, action: { kind: 'stop' } })
    release(); await expect(pending).rejects.toThrow()
    expect(state.starts).toBe(0)
    const status = await journal.status('operation'); expect(status.status === 'known' && status.receipt.phase).toBe('uncertain'); expect(status.status === 'known' && status.receipt.stopFence).toBe(true)
  })
  it('validates native offered responses before reserving one exact idempotent answer', async () => {
    const { host, manager, session, journal, intent, placement, request, state } = await setup()
    await host.prepare({ intent, placement, request }); await host.startTurn('operation', 'prompt', 'execution:execution'); await host.drain()
    const option = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
    manager.pending = async () => ({ session, turn: { nativeTurnId: 'native-turn', nativeRequestId: 'native-question' }, nativeRequestType: 'question', request: {}, responseOptions: [option] })
    const status = await journal.status('operation')
    if (status.status !== 'known') throw new Error('missing receipt')
    const command = { schemaVersion: 1, protocolVersion: 1, commandId: 'response', operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner,
      native: status.receipt.native, action: { kind: 'respond', interactionId: 'interaction', interactionRevision: '1', nativeInteractionId: 'native-question', response: option } }
    await expect(host.control({ ...command, action: { ...command.action, response: { ...option, optionId: 'unoffered' } } })).rejects.toThrow('not offered')
    expect(state.responds).toBe(0)
    await host.control(command); await host.control(command)
    expect(state.responds).toBe(1)
  })
  it.each(['stop', 'respond'] as const)('retries %s after failed authorization before native delivery', async kind => {
    const f = await setup()
    await f.host.prepare(f)
    await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution')
    await f.host.drain()
    const option = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
    f.manager.pending = async () => ({ session: f.session,
      turn: { nativeTurnId: 'native-turn', nativeRequestId: 'question' },
      nativeRequestType: 'approval', request: {}, responseOptions: [option] })
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known') throw new Error('Missing original receipt')
    const action = kind === 'stop' ? { kind: 'stop' as const } : {
      kind: 'respond' as const, interactionId: 'interaction', interactionRevision: '1',
      nativeInteractionId: 'question', response: option,
    }
    const command = { schemaVersion: 1, protocolVersion: 1, commandId: 'control',
      operationId: f.intent.operationId, attemptId: f.intent.attemptId,
      executionId: f.intent.executionId, bindingHash: f.intent.bindingHash,
      owner: f.intent.owner, native: status.receipt.native, action }
    let authorizations = 0
    f.ports.authorize = async () => {
      if (++authorizations === 2) throw new Error('Temporary authorization failure')
    }
    await expect(f.host.control(command)).rejects.toThrow('Temporary authorization failure')
    expect(f.state.cancels + f.state.responds).toBe(0)
    await f.host.control(command)
    await f.host.control(command)
    expect(f.state.cancels + f.state.responds).toBe(1)
    expect(f.state.starts).toBe(1)
    expect(f.state.turns).toBe(1)
  })
  it('retries Stop after a lost cancellation acknowledgement until physical closure is confirmed', async () => {
    const f = await setup()
    await f.host.prepare(f)
    f.manager.cancel = async () => {
      f.state.cancels++
      if (f.state.cancels === 1) throw new Error('Lost acknowledgement')
      return true
    }
    f.ports.settle = async () => f.state.cancels >= 2
      ? { kind: 'cancelled', closureEvidenceDigest: 'a'.repeat(64) } : null
    const command = { schemaVersion: 1, protocolVersion: 1, commandId: 'stop',
      operationId: f.intent.operationId, attemptId: f.intent.attemptId,
      executionId: f.intent.executionId, bindingHash: f.intent.bindingHash,
      owner: f.intent.owner, action: { kind: 'stop' } }
    await f.host.control(command)
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({
      status: 'known', receipt: { phase: 'uncertain', stopFence: true },
    })
    await f.host.control(command)
    await f.host.control(command)
    expect(f.state.cancels).toBe(2)
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({
      status: 'known', receipt: { phase: 'confirmed_terminal', stopFence: true },
    })
  })
  it.each(['reserved', 'entered'] as const)('recovers a %s approval through the Main proxy without duplicate delivery', async phase => {
    const f = await setup()
    const option = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
    const proxy = new RemoteNativeSessionManager({
      intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (_method, frame) => f.host.handle(frame) },
      observeReceipt: async () => {},
      controlFor: async () => command,
      readResponseControl: async () => command,
      authorizeResponseRetry: async () => {
        if (!f.state.allowed) throw new Error('Retry authority revoked')
      },
    })
    const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution')
    await f.host.drain()
    await proxy.history(session)
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known') throw new Error('Missing original receipt')
    const command = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1,
      commandId: 'original-response', operationId: f.intent.operationId, attemptId: f.intent.attemptId,
      executionId: f.intent.executionId, bindingHash: f.intent.bindingHash,
      owner: f.intent.owner, native: status.receipt.native,
      action: { kind: 'respond', interactionId: 'interaction', interactionRevision: '1',
        nativeInteractionId: 'question', response: option } })
    const pending = { session, turn: { nativeTurnId: 'native-turn', nativeRequestId: 'question' },
      nativeRequestType: 'approval', request: {}, responseOptions: [option] }
    f.manager.pending = async () => f.state.responds ? undefined : pending
    f.manager.reconcileResponse = async () => ({ events: [], pendingInteractions: f.state.responds ? [] : [pending] })
    if (phase === 'reserved') {
      f.ports.authorize = async () => {
        if (await f.journal.controlDelivery(command) === 'reserved') throw new Error('Temporary authorization failure')
      }
      await expect(proxy.respond(session, 'question', option)).rejects.toThrow('Temporary authorization failure')
      expect(f.state.responds).toBe(0)
      f.ports.authorize = async () => {}
      f.state.allowed = false
      await expect(proxy.reconcileResponse(session, { nativeRequestId: 'question', nativeRequestType: 'approval', option }))
        .rejects.toThrow('Retry authority revoked')
      expect(f.state.responds).toBe(0)
      f.state.allowed = true
    } else {
      f.manager.respond = async () => { f.state.responds++; throw new Error('Native acknowledgment lost') }
      await proxy.respond(session, 'question', option)
      expect(f.state.responds).toBe(1)
    }
    await proxy.reconcileResponse(session, { nativeRequestId: 'question', nativeRequestType: 'approval', option })
    await proxy.reconcileResponse(session, { nativeRequestId: 'question', nativeRequestType: 'approval', option })
    expect(f.state.responds).toBe(1)
    expect(f.state.starts).toBe(1)
    expect(f.state.turns).toBe(1)
    expect(await f.journal.controlDelivery(command)).toBe(phase === 'reserved' ? 'acknowledged' : 'entered')
    const recovered = await f.journal.status(f.intent.operationId)
    expect(recovered.status === 'known' && recovered.receipt.controls).toEqual([command])
    await expect(f.host.handle({ method: 'control-delivery', intent: f.intent, placement: f.placement,
      command: { ...command, executionId: 'foreign-execution' } })).rejects.toThrow('Control delivery ownership mismatch')
  })
  it('revocation fences and requests physical cancellation without inventing closure', async () => { const { host, journal, intent, placement, request, state } = await setup(); await host.prepare({ intent, placement, request }); state.allowed = false; await host.refreshAuthority(); expect(state.cancels).toBe(1); const status = await journal.status('operation'); expect(status.status === 'known' && status.receipt.stopFence).toBe(true); expect(status.status === 'known' && status.receipt.phase).toBe('stop_requested') })
  it.each(['permission revoked', 'source changed', 'root changed', 'harness changed'])('cancels the original turn after %s', async reason => {
    const f = await setup()
    await f.host.prepare(f)
    await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution')
    await f.host.drain()
    f.ports.authorize = vi.fn(async (_intent, _placement, action) => {
      if (action !== 'stop' && action !== 'read') throw new Error(reason)
    })
    f.ports.settle = vi.fn(async () => f.state.cancels ? {
      kind: 'cancelled' as const, closureEvidenceDigest: 'c'.repeat(64),
    } : null)
    const before = await f.journal.status(f.intent.operationId)
    if (before.status !== 'known') throw new Error('Missing native receipt')
    const command = { schemaVersion: 1, protocolVersion: 1, commandId: 'stop-original',
      operationId: f.intent.operationId, attemptId: f.intent.attemptId, executionId: f.intent.executionId,
      bindingHash: f.intent.bindingHash, owner: f.intent.owner, native: before.receipt.native,
      action: { kind: 'stop' } }
    await expect(f.host.startTurn(f.intent.operationId, 'replacement', 'execution:execution')).rejects.toThrow(reason)
    await expect(f.host.handle({ method: 'control', intent: f.intent, placement: f.placement, command: {
      ...command, native: { ...before.receipt.native, sessionId: 'foreign' },
    } })).rejects.toThrow('native control target')
    expect(f.state.cancels).toBe(0)
    expect(await f.host.handle({ method: 'control', intent: f.intent, placement: f.placement, command })).toMatchObject({
      status: 'known', receipt: { phase: 'confirmed_terminal', stopFence: true, terminal: { kind: 'cancelled' } },
    })
    expect(f.state.cancels).toBe(1)
    expect(f.state.starts).toBe(1)
    expect(f.state.turns).toBe(1)
  })
  it.each(['/runtime','/runtime/../other','/project/runtime','/another/runtime'])('rejects unbound runtime leaf %s before native work', async runtimeDirectory => { const { host, intent, placement, request, state } = await setup(); await expect(host.prepare({ intent, placement, request: { ...request, runtimeDirectory } })).rejects.toThrow('runtime leaf'); expect(state.starts).toBe(0) })
  it('rejects placement/input drift and revoked authority before native work', async () => { const { host, intent, placement, request, state } = await setup(); await expect(host.prepare({ intent, placement, request: { ...request, input: { edited: true } } })).rejects.toThrow('binding mismatch'); state.allowed = false; await expect(host.prepare({ intent, placement, request })).rejects.toThrow('revoked'); expect(state.starts).toBe(0) })
  it('recovers the surviving original resident after observation uncertainty without native start or attach', async () => {
    const f = await setup()
    await f.host.prepare(f)
    await f.journal.uncertain(f.intent.operationId, 'lost observation')
    f.ports.verifyRecovery = vi.fn(async () => {})
    f.manager.attachSession = vi.fn(async () => { throw new Error('must not attach a replacement') })
    const recovered = await f.host.recover({ ...f, evidenceDigest: 'a'.repeat(64) })
    expect(recovered.status).toMatchObject({ status: 'known', receipt: { phase: 'start_acknowledged' } })
    expect(f.state.starts).toBe(1)
    expect(f.manager.attachSession).not.toHaveBeenCalled()
  })
  it('refuses cold allocation even with provider-thread recovery proof', async () => {
    const f = await setup()
    await f.host.prepare(f)
    await f.journal.uncertain(f.intent.operationId, 'lost host')
    const attach = vi.fn(async () => f.session)
    f.manager.attachSession = attach
    const cold = new RemoteExecutionHost({ ...f.ports,
      managers: new ExecutionScopedNativeSessionManagerResolver(() => f.manager), verifyRecovery: async () => {} })
    hosts.push(cold)
    await expect(cold.recover({ ...f, evidenceDigest: 'a'.repeat(64) })).rejects.toThrow('cold recovery unavailable')
    expect(attach).not.toHaveBeenCalled()
    expect(f.state.starts).toBe(1)
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'known', receipt: { phase: 'uncertain' } })
  })
  it.each(['input', 'runId', 'workflowNodeId', 'workingDirectory'] as const)('rejects recovery request drift in %s before manager allocation', async field => {
    const f = await setup()
    await f.host.prepare(f)
    f.ports.verifyRecovery = vi.fn(async () => {})
    const request = { ...f.request, [field]: field === 'input' ? { edited: true } : 'changed' }
    await expect(f.host.recover({ ...f, request, evidenceDigest: 'a'.repeat(64) })).rejects.toThrow('Recovery binding mismatch')
    expect(f.ports.verifyRecovery).not.toHaveBeenCalled()
    expect(f.state.starts).toBe(1)
  })
  it('retains uncertainty when original physical process proof changes during recovery', async () => {
    const f = await setup()
    await f.host.prepare(f)
    await f.journal.uncertain(f.intent.operationId, 'lost observation')
    f.ports.verifyRecovery = async () => {}
    f.ports.nativeEvidence = async () => ({ sessionId: f.session.nativeSessionId, processIdentityDigest: 'b'.repeat(64) })
    await expect(f.host.recover({ ...f, evidenceDigest: 'a'.repeat(64) })).rejects.toThrow('original native lifetime')
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'known', receipt: { phase: 'uncertain' } })
  })
  it('observes an attached original session source before returning it and retains disposal guard on failed observation', async () => {
    const f = await setup()
    await f.host.prepare(f)
    const observe = vi.fn(async () => { throw new Error('physical evidence missing') })
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: (_method, frame) => f.host.handle(frame) }, observeReceipt: async () => {},
      observeOriginalSource: observe, controlFor: async () => { throw new Error('unused') } })
    await expect(proxy.attachSession(f.session, { request: f.request, correlationId: 'execution:execution' })).rejects.toThrow('physical evidence missing')
    expect(observe).toHaveBeenCalledWith(expect.anything(), { type: 'session_created', session: f.session })
    await expect(proxy.dispose()).rejects.toThrow('disposal is unconfirmed')
    expect(f.state.starts).toBe(1)
  })
  it.each(['owner', 'sequence', 'process'] as const)('rejects proxy %s drift before receipt observation', async field => {
    const f = await setup()
    let forged = false
    const observed = vi.fn(async () => {})
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: async (_method, frame) => {
        const response = await f.host.handle(frame)
        if (!forged) return response
        const status = await f.journal.status(f.intent.operationId)
        if (status.status !== 'known') throw new Error('missing receipt')
        if (field === 'owner') status.receipt.intent.owner.epoch = '2'
        if (field === 'sequence') status.receipt.sequence--
        if (field === 'process') status.receipt.native!.processIdentityDigest = 'b'.repeat(64)
        return { session: f.session, status }
      } }, observeReceipt: observed, controlFor: async () => { throw new Error('unused') } })
    await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
    forged = true
    await expect(proxy.attachSession(f.session, { request: f.request, correlationId: 'execution:execution' })).rejects.toThrow(/receipt (binding mismatch|changed)/)
    expect(observed).toHaveBeenCalledTimes(1)
    expect(f.state.starts).toBe(1)
  })

  it('reattaches only the exact resident through authenticated RPC without provider attach or launch', async () => {
    const f = await setup()
    const request = { ...f.request, initialPrompt: 'Saved workflow startup instructions.',
      executionContext: { parentRequest: { requestId: 'original-request', requesterNodeId: 'requester-node' } } }
    await f.host.prepare({ ...f, request })
    f.manager.attachSession = vi.fn(async () => { throw new Error('replacement forbidden') })
    const original = await f.journal.status(f.intent.operationId)
    const frame = { method: 'reattach', intent: f.intent, placement: f.placement, request, session: f.session }
    expect(await f.host.handle(frame)).toEqual({ session: f.session, status: original })
    await expect(f.host.handle({ ...frame, request: { ...request, runtimeDirectory: '/runtime/replacement' } })).rejects.toThrow('reattachment binding mismatch')
    for (const field of ['initialPrompt', 'executionContext']) {
      const incomplete = Object.fromEntries(Object.entries(request).filter(([key]) => key !== field))
      await expect(f.host.handle({ ...frame, request: incomplete })).rejects.toThrow('reattachment binding mismatch')
    }
    expect(f.manager.attachSession).not.toHaveBeenCalled()
    expect(f.state.starts).toBe(1)
    await f.journal.uncertain(f.intent.operationId, 'lost native observation')
    f.ports.nativeEvidence = async () => ({ sessionId: f.session.nativeSessionId,
      processIdentityDigest: 'b'.repeat(64) })
    await expect(f.host.handle(frame)).rejects.toThrow('Reattachment replaced original native lifetime')
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({
      status: 'known', receipt: { phase: 'uncertain' },
    })
  })

  it('reattaches an uncertain observation only after proving the original resident identity', async () => {
    const f = await setup()
    await f.host.prepare(f)
    await f.journal.uncertain(f.intent.operationId, 'Main disconnected')
    f.manager.attachSession = vi.fn(async () => { throw new Error('replacement forbidden') })
    const frame = { method: 'reattach', intent: f.intent, placement: f.placement,
      request: f.request, session: f.session }
    f.state.allowed = false
    await expect(f.host.handle(frame)).rejects.toThrow('revoked')
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({
      status: 'known', receipt: { phase: 'uncertain' },
    })
    f.state.allowed = true
    expect(await f.host.handle(frame)).toMatchObject({ session: f.session,
      status: { status: 'known', receipt: { phase: 'start_acknowledged' } } })
    expect(f.manager.attachSession).not.toHaveBeenCalled()
    expect(f.state.starts).toBe(1)
    expect(f.state.turns).toBe(0)
  })

  it('reattaches the closed original session to collect its saved terminal without launching native work', async () => {
    const f = await setup()
    const result = { outcome: 'succeeded' as const, output: { text: 'Original result' } }
    f.manager.reconcile = async () => ({ events: [], pendingInteractions: [], terminalResult: result })
    f.ports.settle = async () => ({ kind: 'completed', closureEvidenceDigest: 'a'.repeat(64), result })
    await f.host.prepare(f)
    await f.host.startTurn(f.intent.operationId, 'original prompt', 'execution:execution')
    await f.host.drain()
    f.manager.attachSession = vi.fn(async () => { throw new Error('replacement forbidden') })
    f.ports.nativeEvidence = vi.fn(async () => { throw new Error('Original process already closed') })
    const frame = { method: 'reattach', intent: f.intent, placement: f.placement,
      request: f.request, session: f.session }
    const original = await f.journal.status(f.intent.operationId)
    expect(await f.host.handle(frame)).toEqual({ session: f.session, status: original })
    expect(original).toMatchObject({ status: 'known', receipt: { phase: 'confirmed_terminal', terminal: { result } } })
    f.state.allowed = false
    await expect(f.host.handle(frame)).rejects.toThrow('revoked')
    expect(f.ports.nativeEvidence).not.toHaveBeenCalled()
    expect(f.manager.attachSession).not.toHaveBeenCalled()
    expect(f.state.starts).toBe(1)
    expect(f.state.turns).toBe(1)
  })

  it('recovers a lost prepare acknowledgement by observing the original resident without replaying prepare', async () => {
    const f = await setup(), sources: string[] = []
    const methods: string[] = []
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement, harness: 'codex', configuration: f.request.configuration,
      transport: { request: async (method, frame) => {
        methods.push(method)
        const response = await f.host.handle(frame)
        if (method === 'prepare') throw new Error('lost prepare acknowledgement')
        return response
      } }, observeReceipt: async () => {}, observeOriginalSource: async (_receipt, source) => { sources.push(source.type) },
      controlFor: async () => { throw new Error('unused') } })
    await expect(proxy.createSession({ request: f.request, correlationId: 'execution:execution' })).rejects.toThrow('lost prepare acknowledgement')
    expect(await proxy.attachSession(f.session, { request: f.request, correlationId: 'execution:execution' })).toEqual(f.session)
    expect(methods).toEqual(['prepare', 'reattach'])
    expect(sources).toEqual(['session_created'])
    expect(f.state.starts).toBe(1)
  })

  it('does not replay an exact response whose native acknowledgement was lost', async () => {
    const f = await setup()
    await f.host.prepare(f)
    await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution')
    await f.host.drain()
    const option = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
    f.manager.pending = async () => ({ session: f.session, turn: { nativeTurnId: 'native-turn', nativeRequestId: 'question' }, nativeRequestType: 'approval', request: {}, responseOptions: [option] })
    f.manager.respond = async () => { f.state.responds++; throw new Error('lost acknowledgement') }
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known') throw new Error('missing original')
    const command = { schemaVersion: 1, protocolVersion: 1, commandId: 'original-response', operationId: f.intent.operationId,
      attemptId: f.intent.attemptId, executionId: f.intent.executionId, bindingHash: f.intent.bindingHash, owner: f.intent.owner, native: status.receipt.native,
      action: { kind: 'respond', interactionId: 'interaction', interactionRevision: '1', nativeInteractionId: 'question', response: option } }
    expect(await f.host.control(command)).toMatchObject({ status: 'known', receipt: { phase: 'uncertain' } })
    expect(await f.host.control(command)).toMatchObject({ status: 'known', receipt: { phase: 'uncertain' } })
    expect(f.state.responds).toBe(1)
    expect(f.state.starts).toBe(1)
  })

})

it('keeps the admitted mode in worker turn replay identity after journal restart', async () => {
  const f = await setup()
  await f.host.prepare({ intent: f.intent, placement: f.placement, request: f.request })
  await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution', undefined, 'plan')
  await expect(f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution', undefined, 'regular'))
    .rejects.toThrow('Turn input binding conflict')
  await f.host.drain()
  await f.journal.close()
  const reopened = await RemoteOperationJournal.open(join(roots.at(-1)!, 'journal'))
  journals.push(reopened)
  await expect(reopened.reserveTurn(f.intent.operationId, {
    correlationId: 'execution:execution', promptDigest: createHash('sha256').update('prompt').digest('hex'),
    sessionMode: 'regular',
  })).rejects.toThrow('Turn input binding conflict')
  expect(f.state.turns).toBe(1)
})

it('reports original startup events before the native turn is acknowledged', async () => {
  const f = await setup()
  const entered = deferred()
  const ready = deferred()
  const startup = { sequence: 0, type: 'turn.mcp_startup_retry', occurredAt: new Date().toISOString(),
    payload: { serverName: 'graphql', attempt: 2, delayMs: 10_000 } }
  f.manager.startTurn = async function* (_session, turn) {
    yield startup
    entered.resolve()
    await ready.promise
    await turn.onSubmitted?.('native-turn')
  }
  const history = vi.spyOn(f.manager, 'history').mockResolvedValue({ events: [startup], pendingInteractions: [] })
  const reconcile = vi.spyOn(f.manager, 'reconcile').mockRejectedValue(new HarnessExecutionError(
    'CODEX_RECONCILIATION_UNCERTAIN', 'The native turn has not been submitted.'))
  try {
    await f.host.prepare({ intent: f.intent, placement: f.placement, request: f.request })
    await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution')
    await entered.promise
    const response = await f.host.handle({ method: 'history', intent: f.intent, placement: f.placement,
      correlationId: 'execution:execution', afterSequence: -1 })
    expect(response).toMatchObject({ history: { events: [startup], pendingInteractions: [] },
      status: { status: 'known', receipt: { phase: 'start_acknowledged' } },
      page: { hasMore: false, nextAfterSequence: 0 } })
    expect(history).toHaveBeenCalledWith(f.session)
    expect(reconcile).not.toHaveBeenCalled()
    expect(await f.journal.status(f.intent.operationId)).toMatchObject({
      status: 'known', receipt: { native: { sessionId: f.session.nativeSessionId } },
    })
  } finally { ready.resolve() }
})
