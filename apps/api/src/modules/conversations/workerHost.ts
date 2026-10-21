import { errorMessage } from '../../shared/errorMessage.js'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import {
  WorkerConversationRpcRequestSchema, workerConversationProfileSelection, type WorkerConversationBinding, type WorkerConversationConfiguration,
  type WorkerConversationReceipt, type WorkerConversationRpcRequest,
  WorkerConversationResponsePageSchema, WORKER_CONVERSATION_RESPONSE_BYTES,
} from '@foreman-code/contracts/remote-execution-rpc'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import { createJsonContinuationPager } from '../runs/remote/jsonContinuation.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { RemoteNativeIdentity } from '@foreman-code/contracts/remote-execution'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../harnesses/port.js'
import type { WorkerConversationJournal } from './workerJournal.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import { compactionBlocksSend, type CompactionState } from '@foreman-code/contracts'
import { isDefiniteCompactionRejection, NativeDeliveryError } from '../harnesses/errors.js'
import { recoverPersistedClaudeCompaction } from '../harnesses/claudeSdk/recoverCompaction.js'
import { unavailableNativeResponse } from '../harnesses/responseAvailability.js'
import { sameConversationForAppAccess } from './conversationAppAccess.js'
import { readWorkerConversationResults } from './workerConversationResults.js'
import { validWorkerConfigurationTransition } from './workerConfigurationTransition.js'
import { WorkerEventWait } from './workerEventWait.js'

export interface WorkerConversationAllocation {
  observationOnly?: true
  hasExited?(): boolean
  manager: NativeHarnessSessionManager
  inspector?: NativeMcpInspector
  start(input: { correlationId: string; instructionsDelivered: boolean;
    applicationAccess?: Extract<WorkerConversationRpcRequest, { method: 'conversation.initial-turn' }>['applicationAccess'] }): Promise<NativeSessionStart>
  nativeOwner(session: NativeSessionReference, options?: { allowExited: true }): Promise<RemoteNativeIdentity>
  close(): Promise<void>
  deliverClaudeCredential?(token: string, signal: AbortSignal): Promise<void>
  refreshApplicationAccess?(token: string, signal: AbortSignal): Promise<void>
  recoverClaudeAuthority?(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.history' | 'conversation.reconcile' }>,
    submission: NonNullable<WorkerConversationReceipt['turns'][number]['nativeSubmission']>, signal: AbortSignal): Promise<void>
  recoverFiles?(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.history' | 'conversation.reconcile' }>,
    nativeTurnId: string, signal: AbortSignal): Promise<void>
}
export interface WorkerConversationHostPorts {
  journal: WorkerConversationJournal
  currentBinding(): Readonly<DeviceSessionBinding>
  /** Main verifies the original admitted message/control and current role grants. */
  authorize(request: WorkerConversationRpcRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<void>
  allocate(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<WorkerConversationAllocation>
  prepare?(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<WorkerConversationAllocation>
  recover?(record: WorkerConversationReceipt, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal,
    request: WorkerConversationRpcRequest): Promise<WorkerConversationAllocation>
  closePersistedRuntime?(record: WorkerConversationReceipt,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<void>
  closeRecoveredSession?(record: WorkerConversationReceipt, signal: AbortSignal): Promise<void>
  readCompaction?(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.compact-read' }>,
    record: WorkerConversationReceipt, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<CompactionState>
  /** Native callbacks stay behind Main's persisted identity acknowledgement. */
  observeSession(binding: WorkerConversationBinding, session: NativeSessionReference,
    request: WorkerConversationRpcRequest, signal: AbortSignal): Promise<void>
  observeSubmission(binding: WorkerConversationBinding, correlationId: string,
    identity: Pick<NativeHistory, 'nativeTurnId' | 'nativeSubmission'>,
    request: WorkerConversationRpcRequest, signal: AbortSignal): Promise<void>
  observeSettings?(request: WorkerConversationRpcRequest, correlationId: string, signal: AbortSignal): Promise<void>
  observeTerminal?(request: WorkerConversationRpcRequest,
    observation: import('../harnesses/port.js').NativeTerminalObservation, signal: AbortSignal): Promise<void>
}
interface Resident {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  allocation: WorkerConversationAllocation
}
function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', message, 409)
}
function sessionOwner(identity: RemoteNativeIdentity): RemoteNativeIdentity {
  return { sessionId: identity.sessionId, processIdentityDigest: identity.processIdentityDigest }
}
function validateConfiguration(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration) {
  const owner = binding.owner
  const roleMatches = owner.kind === 'operator'
    ? 'operatorId' in configuration && configuration.operatorId === owner.operatorId
    : 'agentId' in configuration && configuration.agentId === owner.agentId
      && configuration.workspaceId === owner.workspaceId
  if (!roleMatches || configuration.id !== owner.configurationVersionId
    || commandInputHash(configuration) !== owner.configurationHash
    || configuration.harness.harness !== binding.harness
    || !isDeepStrictEqual(workerConversationProfileSelection(binding, configuration), binding.profile)) {
    unavailable('The saved chat configuration differs from its selected worker owner.')
  }
}

/** Conversation operations share execution-v1 and the existing native adapters. */
export class WorkerConversationHost {
  private readonly residents = new Map<string, Resident>()
  private readonly responseTransfers = new Map<string, {
    binding: WorkerConversationBinding; connection: Readonly<DeviceSessionBinding>; byteSize: number;
    page: ReturnType<typeof createJsonContinuationPager>; expiresAt: number
  }>()
  private responseBytes = 0
  private readonly preparations = new Map<string, Resident>()
  private readonly inspections = new Set<WorkerConversationAllocation>()
  private readonly allocating = new Map<string, Promise<unknown>>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly running = new Map<string, { connection: Readonly<DeviceSessionBinding>; task: Promise<void> }>()
  private readonly runningCompactions = new Map<string, Promise<void>>()
  private readonly eventWait = new WorkerEventWait()
  private readonly lifetime = new AbortController()
  private readonly log = componentLogger('harness')
  private closing = false

  constructor(private readonly ports: WorkerConversationHostPorts) {}

  private current(binding: WorkerConversationBinding, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    signal.throwIfAborted()
    const target = binding.profile.target
    if (this.closing || !isDeepStrictEqual(this.ports.currentBinding(), connection)
      || target.hostRef.kind !== 'device' || target.hostRef.mainId !== connection.mainId
      || target.hostRef.deviceId !== connection.deviceId
      || target.applicationInstallationId !== connection.workerInstallationId) {
      unavailable('The selected chat worker connection changed.')
    }
  }

  private async authorize(request: WorkerConversationRpcRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    this.current(request.binding, connection, signal)
    await this.ports.authorize(request, connection, signal)
    this.current(request.binding, connection, signal)
  }

  private async allocate(request: Extract<WorkerConversationRpcRequest, { configuration: WorkerConversationConfiguration }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<Resident> {
    validateConfiguration(request.binding, request.configuration)
    const id = request.binding.owner.conversationId
    const original = this.residents.get(id)
    const recoveringExited = original?.allocation.hasExited?.() === true
    const upgradingObservation = original?.allocation.observationOnly && request.method === 'conversation.open'
      && request.mode === 'attach' && request.applicationAccess
    if (original) {
      if (!isDeepStrictEqual(original.binding, request.binding)
        || !isDeepStrictEqual(original.configuration, request.configuration)) unavailable('The native chat owner changed.')
      if (!upgradingObservation && !recoveringExited) return original
    }
    const opening = this.allocating.get(id)
    if (opening) {
      await opening
      return this.allocate(request, connection, signal)
    }
    const task = (async () => {
      if (upgradingObservation && !recoveringExited) {
        if (this.hasRunningOperation(id)) unavailable('The native conversation is busy.')
        await original.allocation.close()
        this.residents.delete(id)
      }
      const record = await this.ports.journal.read(request.binding)
      if (record?.closed || record?.closing) unavailable('The native chat is closing or closed.')
      if (record?.applicationAccessChange?.state === 'reserved') unavailable('The native App MCP access change needs recovery.')
      let allocation: WorkerConversationAllocation
      if (original && recoveringExited) {
        if (!record) unavailable('The original native chat session is unavailable.')
        allocation = (await this.recoverResident(original, record, request, connection, signal)).allocation
      } else if (record?.session) {
        allocation = await this.recover(record, request.configuration, connection, signal, request)
      } else {
        allocation = await this.ports.allocate(request.binding, request.configuration, connection, signal)
      }
      try {
        this.current(request.binding, connection, signal)
        if (allocation.manager.harness !== request.binding.harness) unavailable('The worker allocated another native driver.')
        const resident = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
        this.residents.set(id, resident)
        const preparation = this.preparations.get(id)
        if (preparation) {
          await preparation.allocation.close()
          this.preparations.delete(id)
        }
        return resident
      } catch (error) { this.residents.delete(id); await allocation.close(); throw error }
    })()
    this.allocating.set(id, task)
    try { return await task } finally { if (this.allocating.get(id) === task) this.allocating.delete(id) }
  }

  private async prepare(request: Extract<WorkerConversationRpcRequest, { configuration: WorkerConversationConfiguration }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<Resident> {
    validateConfiguration(request.binding, request.configuration)
    const id = request.binding.owner.conversationId
    const live = this.residents.get(id)
    const previousPreparation = this.preparations.get(id)
    if (previousPreparation && !isDeepStrictEqual(previousPreparation.binding, request.binding)
      && sameConversationForAppAccess(previousPreparation.binding, request.binding)) {
      await previousPreparation.allocation.close()
      this.preparations.delete(id)
    }
    const resident = live && isDeepStrictEqual(live.binding, request.binding) ? live : this.preparations.get(id)
    if (resident) {
      if (!isDeepStrictEqual(resident.binding, request.binding)
        || !isDeepStrictEqual(resident.configuration, request.configuration)) unavailable('The native chat owner changed.')
      return resident
    }
    const record = await this.ports.journal.inspectBinding(request.binding)
    if (!this.ports.prepare) {
      if (!record?.session) return this.allocate(request, connection, signal)
      unavailable('The original chat is not available for inspection.')
    }
    if (record?.closing || record?.closed) unavailable('The original chat is not available for inspection.')
    const opening = this.allocating.get(id)
    if (opening) {
      await opening
      return this.prepare(request, connection, signal)
    }
    const task = (async () => {
      const allocation = await this.ports.prepare!(request.binding, request.configuration, connection, signal)
      try {
        this.current(request.binding, connection, signal)
        const prepared = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
        this.preparations.set(id, prepared)
        return prepared
      } catch (error) { await allocation.close(); throw error }
    })()
    this.allocating.set(id, task)
    try { return await task } finally { if (this.allocating.get(id) === task) this.allocating.delete(id) }
  }

  private async inspectConfiguration(
    request: Extract<WorkerConversationRpcRequest, { method: 'conversation.inspect-entry' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal,
  ) {
    validateConfiguration(request.binding, request.configuration)
    if (!this.ports.prepare) unavailable('Separate native configuration inspection is unavailable.')
    const record = await this.ports.journal.inspectBinding(request.binding)
    if (record?.closing || record?.closed) unavailable('The original chat is not available for inspection.')
    const key = `inspection:${randomUUID()}`
    const opening = this.ports.prepare(request.binding, request.configuration, connection, signal).then(async allocation => {
      try {
        this.current(request.binding, connection, signal)
        this.inspections.add(allocation)
        return { binding: request.binding, configuration: request.configuration, allocation }
      } catch (error) {
        await allocation.close()
        throw error
      }
    })
    this.allocating.set(key, opening)
    let allocation: WorkerConversationAllocation | undefined
    try {
      allocation = (await opening).allocation
      if (!allocation.inspector) unavailable('Native configuration inspection is unavailable.')
      const result = await allocation.inspector.inspect({ ...request.inspection, phase: 'configuration', signal })
      this.current(request.binding, connection, signal)
      return result
    } finally {
      this.allocating.delete(key)
      if (allocation) {
        await allocation.close()
        this.inspections.delete(allocation)
      }
    }
  }

  private recover(record: WorkerConversationReceipt, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal, request: WorkerConversationRpcRequest) {
    if (!this.ports.recover) unavailable('The original worker process needs native recovery before it can be attached.')
    return this.ports.recover(record, configuration, connection, signal, request)
  }

  private async resident(request: WorkerConversationRpcRequest & { session: NativeSessionReference },
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal, options: { purpose?: 'release' } = {}) {
    let record = await this.ports.journal.read(request.binding)
    if (this.allocating.has(request.binding.owner.conversationId)) unavailable('The native conversation is busy.')
    let resident = this.residents.get(request.binding.owner.conversationId)
    if (!record || !isDeepStrictEqual(record.session, request.session) || !resident
      || record.applicationAccessChange?.state === 'reserved'
      || !isDeepStrictEqual(resident.binding, request.binding)) unavailable('The original chat session is not resident.')
    if (resident.allocation.hasExited?.() && options.purpose !== 'release') {
      const id = request.binding.owner.conversationId
      const original = resident
      const recovery = this.recoverResident(original, record, request, connection, signal)
      this.allocating.set(id, recovery)
      try {
        resident = await recovery
        this.residents.set(id, resident)
        this.current(request.binding, connection, signal)
      } catch (error) {
        if (resident === original) this.residents.set(id, original)
        throw error
      } finally {
        if (this.allocating.get(id) === recovery) this.allocating.delete(id)
      }
    }
    const owner = sessionOwner(await resident.allocation.nativeOwner(request.session,
      options.purpose === 'release' ? { allowExited: true } : undefined))
    record = await this.ports.journal.read(request.binding)
    if (!record || !isDeepStrictEqual(record.nativeOwner, owner)) {
      unavailable('The original native chat process changed.')
    }
    return { resident, record }
  }

  private track(task: Promise<void>) {
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }

  private async bind(resident: Resident, session: NativeSessionReference,
    request: WorkerConversationRpcRequest, signal: AbortSignal) {
    await this.ports.journal.bindSession(resident.binding, session,
      sessionOwner(await resident.allocation.nativeOwner(session)))
    if (request.method === 'conversation.initial-turn') {
      await this.notifyMain(resident.binding, () => this.ports.observeSession(resident.binding, session, request, signal))
    } else await this.ports.observeSession(resident.binding, session, request, signal)
  }

  private async notifyMain(binding: WorkerConversationBinding, notify: () => Promise<void>) {
    try {
      await notify()
    } catch (error) {
      // Main can recover journaled observations after its callback connection returns.
      this.log.error({ err: error, conversationId: binding.owner.conversationId }, 'Worker chat observation needs delivery to Main')
    }
  }

  private async open(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.open' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    validateConfiguration(request.binding, request.configuration)
    if (request.mode !== 'create' && !request.source) unavailable('Native attachment or fork requires its source session.')
    if (request.previousConfiguration) {
      if (request.mode === 'attach') {
        if (!request.previousBinding) unavailable('The previous native binding is required.')
        if (validWorkerConfigurationTransition(request.previousBinding, request.binding,
          request.previousConfiguration, request.configuration)) return this.changeConfiguration(request, connection, signal)
        const established = await this.ports.journal.inspectConfigurationTransition(request.previousBinding, request.binding,
          request.previousConfiguration, request.configuration)
        if (!established?.session || !isDeepStrictEqual(established.session, request.source)) {
          unavailable('The replacement native session differs from its persisted creation.')
        }
      } else await this.replaceSession(request, connection, signal)
    }
    if (request.previousBinding && !request.previousConfiguration) return this.changeApplicationAccess(request, connection, signal)
    const record = await this.ports.journal.receive(request.binding, connection)
    const resident = await this.allocate(request, connection, signal)
    if (request.mode === 'fork' && !resident.allocation.manager.forkSession) {
      unavailable('The selected native driver cannot fork a chat session.')
    }
    if (request.mode === 'attach') {
      if (!record.session || !isDeepStrictEqual(record.session, request.source)) unavailable('A different session cannot replace this chat.')
      if (request.binding.harness === 'codex' && request.applicationAccess) {
        if (!resident.allocation.refreshApplicationAccess) unavailable('The retained Codex MCP route cannot refresh its credential.')
        await resident.allocation.refreshApplicationAccess(request.applicationAccess.token, signal)
        await this.authorize(request, connection, signal)
      }
      await this.ports.journal.rebind(request.binding, connection,
        sessionOwner(await resident.allocation.nativeOwner(record.session)))
      return { receipt: await this.ports.journal.read(request.binding) }
    }
    const reserved = await this.ports.journal.reserveCreation(request.binding, request.operationId,
      commandInputHash({ mode: request.mode, source: request.source ?? null, preferences: request.preferences ?? null }))
    if (!reserved.dispatch) return { receipt: reserved.record }
    if (request.preferences) {
      await resident.allocation.manager.configureSessionPreferences?.(request.preferences)
      await this.ports.journal.preferences(request.binding, request.preferences, null)
    }
    await this.authorize(request, connection, signal)
    const start = await resident.allocation.start({ correlationId: request.operationId,
      instructionsDelivered: request.mode === 'fork',
      ...(request.applicationAccess ? { applicationAccess: request.applicationAccess } : {}) })
    const manager = resident.allocation.manager
    let session: NativeSessionReference
    if (request.mode === 'fork') {
      if (!manager.forkSession) unavailable('The selected native driver cannot fork a chat session.')
      session = await manager.forkSession(request.source!, start, signal)
      if (session.nativeSessionId === request.source!.nativeSessionId) unavailable('The native fork returned its source session.')
    } else session = await manager.createSession(start, signal)
    await this.bind(resident, session, request, signal)
    return { receipt: await this.ports.journal.read(request.binding) }
  }

  private hasRunningOperation(conversationId: string) {
    return [...this.running.keys(), ...this.runningCompactions.keys()].some(key => key.startsWith(`${conversationId}:`))
  }

  private async recoverResident(resident: Resident, record: WorkerConversationReceipt,
    request: WorkerConversationRpcRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<Resident> {
    if (!record.session || !isDeepStrictEqual(resident.binding, record.binding)) {
      unavailable('The original native chat owner changed.')
    }
    const id = record.binding.owner.conversationId
    if (this.hasRunningOperation(id)) unavailable('The native conversation is busy.')
    await resident.allocation.close()
    this.residents.delete(id)
    await this.authorize(request, connection, signal)
    const allocation = await this.recover(record, resident.configuration, connection, signal, request)
    return { ...resident, allocation }
  }

  private async settleResident(resident: Resident, record: WorkerConversationReceipt,
    request: WorkerConversationRpcRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    if (!record.session || !isDeepStrictEqual(resident.binding, record.binding)) {
      unavailable('The original native chat owner changed.')
    }
    if (resident.allocation.hasExited?.()) {
      const recovered = await this.recoverResident(resident, record, request, connection, signal)
      this.residents.set(record.binding.owner.conversationId, recovered)
      return
    }
    if (!isDeepStrictEqual(record.nativeOwner, sessionOwner(await resident.allocation.nativeOwner(record.session)))) {
      unavailable('The original native chat owner changed.')
    }
    const manager = resident.allocation.manager
    const { recoveredTurns, recoveredCompactions } = await readWorkerConversationResults(record, manager, signal,
      manager.reconcileCompaction ? state => manager.reconcileCompaction!(record.session!, state, signal) : undefined)
    await this.authorize(request, connection, signal)
    if (!isDeepStrictEqual(record.nativeOwner, sessionOwner(await resident.allocation.nativeOwner(record.session)))) {
      unavailable('The original native chat owner changed.')
    }
    for (const turn of recoveredTurns) await this.ports.journal.finishTurn(record.binding, turn.correlationId, turn.result)
    for (const state of recoveredCompactions) await this.ports.journal.compactProgress(record.binding, state)
  }

  private async changeConfiguration(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.open' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const previous = request.previousBinding
    if (request.mode !== 'attach' || !request.source || !previous || !request.previousConfiguration
      || !validWorkerConfigurationTransition(previous, request.binding, request.previousConfiguration, request.configuration)) {
      unavailable('The configuration change must keep the Agent, Worker, account, folder and native session.')
    }
    const id = request.binding.owner.conversationId
    if (this.allocating.has(id) || this.hasRunningOperation(id)) unavailable('The native conversation is busy.')
    const task = (async () => {
      let record = await this.ports.journal.inspectConfigurationTransition(previous, request.binding,
        request.previousConfiguration!, request.configuration)
      if (!record?.session || !isDeepStrictEqual(record.session, request.source)
        || record.closed || record.closing) unavailable('The original Run chat session is unavailable.')
      const unfinished = record.turns.some(turn => !['completed', 'rejected'].includes(turn.status))
        || record.compactions.some(control => compactionBlocksSend(control.state))
      const existing = this.residents.get(id)
      if (existing && unfinished) {
        await this.settleResident(existing, record, request, connection, signal)
        record = (await this.ports.journal.read(record.binding))!
      }
      if (isDeepStrictEqual(record.binding, request.binding)) {
        const resident = this.residents.get(id)
        if (resident && isDeepStrictEqual(resident.binding, request.binding)) return resident
        const allocation = await this.recover(record, request.configuration, connection, signal, request)
        const recovered = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
        this.residents.set(id, recovered)
        return recovered
      }
      if (!isDeepStrictEqual(record.binding, previous)) unavailable('The original Run chat binding changed.')
      const old = this.residents.get(id)
      if (old) {
        if (!isDeepStrictEqual(old.binding, previous)) unavailable('The native chat owner changed.')
        await old.allocation.close()
        this.residents.delete(id)
      }
      const preparation = this.preparations.get(id)
      if (preparation) {
        await preparation.allocation.close()
        this.preparations.delete(id)
      }
      await this.authorize(request, connection, signal)
      const allocation = await this.recover(record, request.configuration, connection, signal, request)
      const resident = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
      this.residents.set(id, resident)
      return resident
    })()
    this.allocating.set(id, task)
    try {
      await task
      await this.authorize(request, connection, signal)
      return { receipt: await this.ports.journal.read(request.binding) }
    } finally { if (this.allocating.get(id) === task) this.allocating.delete(id) }
  }

  private async changeApplicationAccess(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.open' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const previous = request.previousBinding!
    validateConfiguration(request.binding, request.configuration)
    if (request.mode !== 'attach' || !request.source || !sameConversationForAppAccess(previous, request.binding)) {
      unavailable('App MCP access changes keep the original Operator owner, profile and session.')
    }
    const id = request.binding.owner.conversationId
    if (this.allocating.has(id) || this.hasRunningOperation(id)) unavailable('The native conversation is busy.')
    const task = (async (): Promise<Resident> => {
      const reserved = await this.ports.journal.reserveApplicationAccess(previous, request.binding, request.operationId, request.source!)
      if (reserved.applied) {
        const resident = this.residents.get(id)
        if (resident && isDeepStrictEqual(resident.binding, request.binding)) return resident
        const allocation = await this.recover(reserved.record, request.configuration, connection, signal, request)
        const recovered = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
        this.residents.set(id, recovered)
        return recovered
      }
      const old = this.residents.get(id)
      if (old) {
        if (!isDeepStrictEqual(old.binding, previous)
          || reserved.reserved && !isDeepStrictEqual(reserved.record.nativeOwner,
            sessionOwner(await old.allocation.nativeOwner(request.source!)))) unavailable('The original native process changed.')
        await old.allocation.close()
        this.residents.delete(id)
      }
      const preparation = this.preparations.get(id)
      if (preparation) {
        await preparation.allocation.close()
        this.preparations.delete(id)
      }
      await this.authorize(request, connection, signal)
      const allocation = await this.recover(reserved.record, request.configuration, connection, signal, request)
      const resident = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
      this.residents.set(id, resident)
      return resident
    })()
    this.allocating.set(id, task)
    try {
      await task
      await this.authorize(request, connection, signal)
      return { receipt: await this.ports.journal.read(request.binding) }
    } finally { if (this.allocating.get(id) === task) this.allocating.delete(id) }
  }

  private callbacks(resident: Resident, request: Extract<WorkerConversationRpcRequest,
    { method: 'conversation.initial-turn' | 'conversation.start-turn' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): NativeTurnInput {
    return {
      prompt: request.prompt, clientCorrelationId: request.correlationId,
      onTerminal: async observation => {
        if (observation.submission.clientCorrelationId !== request.correlationId) unavailable('Native terminal input differs from its admission.')
        await this.ports.journal.finishTurn(resident.binding, request.correlationId, observation.result)
        await this.authorize(request, connection, signal)
        await this.ports.observeTerminal?.(request, observation, signal)
      },
      ...(request.sessionMode ? { sessionMode: request.sessionMode } : {}),
      ...(request.preferences ? { sessionPreferences: request.preferences } : {}),
      onSubmitted: async nativeTurnId => {
        await this.ports.journal.submitted(resident.binding, request.correlationId, { nativeTurnId })
        await this.notifyMain(resident.binding, () =>
          this.ports.observeSubmission(resident.binding, request.correlationId, { nativeTurnId }, request, signal))
      },
      onMessageSubmitted: async nativeSubmission => {
        await this.ports.journal.submitted(resident.binding, request.correlationId, { nativeSubmission })
        await this.notifyMain(resident.binding, () =>
          this.ports.observeSubmission(resident.binding, request.correlationId, { nativeSubmission }, request, signal))
      },
      onSettingsApplied: async () => {
        await this.ports.observeSettings?.(request, request.correlationId, signal)
        const record = await this.ports.journal.read(resident.binding)
        if (!record?.session || !record.desiredPreferences) return
        await this.ports.journal.preferences(resident.binding, record.desiredPreferences,
          resident.allocation.manager.appliedSessionPreferences?.(record.session) ?? null)
      },
    }
  }

  /** The accepted envelope addresses this exact journal binding; only its owner derives a future provider SID. */
  private async initialInput(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.initial-turn' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    validateConfiguration(request.binding, request.configuration)
    if (request.previousConfiguration) await this.replaceSession(request, connection, signal)
    await this.ports.journal.receive(request.binding, connection)
    const existing = await this.ports.journal.read(request.binding)
    const original = existing?.turns.find(turn => turn.correlationId === request.correlationId)
    if (original) {
      // Exact replay validates its retained input without acquiring a native writer after restart.
      if (original.creationOperationId) await this.ports.journal.reserveInitialTurn(request.binding,
        request.operationId, commandInputHash({ mode: 'initial-turn', correlationId: request.correlationId }), request.correlationId,
        commandInputHash({ prompt: request.prompt, mode: request.sessionMode ?? 'regular', preferences: request.preferences ?? null }), request.sessionMode ?? 'regular')
      else await this.ports.journal.reserveTurn(request.binding, request.correlationId,
        commandInputHash({ prompt: request.prompt, mode: request.sessionMode ?? 'regular', preferences: request.preferences ?? null }),
        { mode: request.sessionMode ?? 'regular' })
      return { receipt: await this.ports.journal.read(request.binding) }
    }
    if (existing?.session) {
      const { resident } = await this.resident({ ...request, session: existing.session }, connection, signal)
      const reserved = await this.ports.journal.reserveTurn(request.binding, request.correlationId,
        commandInputHash({ prompt: request.prompt, mode: request.sessionMode ?? 'regular', preferences: request.preferences ?? null }),
        { mode: request.sessionMode ?? 'regular' })
      if (reserved.dispatch) this.pump(resident, request, connection, () => this.continuedInput(resident, request, connection, existing.session!))
      return { receipt: await this.ports.journal.read(request.binding) }
    }
    const resident = await this.allocate(request, connection, signal)
    const initial = await this.ports.journal.reserveInitialTurn(request.binding, request.operationId,
      commandInputHash({ mode: 'initial-turn', correlationId: request.correlationId }), request.correlationId,
      commandInputHash({ prompt: request.prompt, mode: request.sessionMode ?? 'regular', preferences: request.preferences ?? null }),
      request.sessionMode ?? 'regular')
    if (initial.dispatch) {
      try {
        const manager = resident.allocation.manager
        if (request.preferences) {
          await manager.configureSessionPreferences?.(request.preferences)
          await this.ports.journal.preferences(request.binding, request.preferences, null)
        }
        const start = await resident.allocation.start({ correlationId: request.correlationId, instructionsDelivered: false,
          ...(request.applicationAccess ? { applicationAccess: request.applicationAccess } : {}) })
        this.pump(resident, request, connection, () => this.initialStream(resident, request, connection, start))
      } catch (error) { await this.reject(resident.binding, request, error) }
    }
    return { receipt: await this.ports.journal.read(request.binding) }
  }

  private async *initialStream(resident: Resident,
    request: Extract<WorkerConversationRpcRequest, { method: 'conversation.initial-turn' }>,
    connection: Readonly<DeviceSessionBinding>, start: NativeSessionStart) {
    const manager = resident.allocation.manager
    const callbacks = this.callbacks(resident, request, connection, this.lifetime.signal)
    if (manager.startInitialTurn) {
      yield* manager.startInitialTurn(start, { ...callbacks,
        onSessionObserved: session => this.bind(resident, session, request, this.lifetime.signal) }, this.lifetime.signal)
      return
    }
    // Codex can create without an input. Creation and the reserved input remain one original journal command.
    const session = await manager.createSession(start, this.lifetime.signal)
    await this.bind(resident, session, request, this.lifetime.signal)
    await this.authorize(request, connection, this.lifetime.signal)
    yield* manager.startTurn(session, callbacks, this.lifetime.signal)
  }

  private async *continuedInput(resident: Resident, request: Extract<WorkerConversationRpcRequest,
    { method: 'conversation.initial-turn' | 'conversation.start-turn' }>, connection: Readonly<DeviceSessionBinding>, session: NativeSessionReference) {
    const manager = resident.allocation.manager
    if (request.preferences) {
      await manager.configureSessionPreferences?.(request.preferences)
      await this.ports.journal.preferences(request.binding, request.preferences, null)
    }
    if (request.method === 'conversation.initial-turn' && request.applicationAccess) {
      const refresh = request.binding.harness === 'claude'
        ? resident.allocation.deliverClaudeCredential : resident.allocation.refreshApplicationAccess
      if (!refresh) unavailable('The original native conversation cannot refresh its scoped credential.')
      await refresh.call(resident.allocation, request.applicationAccess.token, this.lifetime.signal)
    }
    await this.authorize(request, connection, this.lifetime.signal)
    yield* manager.startTurn(session, this.callbacks(resident, request, connection, this.lifetime.signal), this.lifetime.signal)
  }

  private pump(resident: Resident, request: WorkerConversationRpcRequest & { correlationId: string },
    connection: Readonly<DeviceSessionBinding>, stream: () => AsyncIterable<unknown>) {
    const task = (async () => {
      let streamStarted = false
      try {
        await this.authorize(request, connection, this.lifetime.signal)
        streamStarted = true
        for await (const event of stream()) {
          void event
          this.eventWait.publish(resident.binding.owner.conversationId)
        }
        const record = await this.ports.journal.read(resident.binding)
        if (!record?.session) unavailable('The native session was never observed.')
        const history = await resident.allocation.manager.reconcile(record.session, request.correlationId, this.lifetime.signal)
        await this.finish(resident.binding, request.correlationId, history)
      } catch (error) {
        const notDelivered = !streamStarted
          || error instanceof NativeDeliveryError && error.delivery === 'not_sent' && error.cleanup === 'confirmed'
          || error && typeof error === 'object'
          && 'certainty' in error && error.certainty === 'definite'
          && 'deliveryState' in error && error.deliveryState === 'not-delivered'
        if (notDelivered) await this.reject(resident.binding, request, error)
        else await this.ports.journal.finishTurn(resident.binding, request.correlationId)
        this.log.error({ err: error, conversationId: resident.binding.owner.conversationId }, 'Worker chat needs native recovery')
      } finally {
        this.eventWait.publish(resident.binding.owner.conversationId)
      }
    })()
    const key = `${resident.binding.owner.conversationId}:${request.correlationId}`
    this.running.set(key, { connection, task })
    void task.then(() => this.running.delete(key), () => this.running.delete(key))
    void this.track(task)
  }

  private reject(binding: WorkerConversationBinding, request: WorkerConversationRpcRequest & { correlationId: string },
    error: unknown) {
    const message = errorMessage(error, 'Native input was not delivered.')
    return this.ports.journal.rejectTurn(binding, request.correlationId,
      { outcome: 'failed', error: { code: 'NATIVE_INPUT_NOT_DELIVERED', message, retryable: true } },
      request.method === 'conversation.initial-turn' ? request.operationId : undefined)
  }

  private finish(binding: WorkerConversationBinding, correlationId: string, history: NativeHistory) {
    let terminal = history.correlationId === correlationId ? history.terminalResult : undefined
    if (history.terminalTurn?.correlationId === correlationId) terminal = history.terminalTurn.result
    return this.ports.journal.finishTurn(binding, correlationId, terminal)
  }

  private restoreJournaledResult(session: NativeSessionReference, history: NativeHistory,
    turn: WorkerConversationReceipt['turns'][number] | undefined): NativeHistory {
    if (session.harness !== 'claude' || turn?.status !== 'completed' || !turn.result
      || !turn.nativeSubmission || history.correlationId !== turn.correlationId
      || !isDeepStrictEqual(history.nativeSubmission, turn.nativeSubmission) || history.terminalResult) return history
    return { ...history, terminalResult: turn.result,
      terminalTurn: { correlationId: turn.correlationId,
        providerId: turn.nativeSubmission.nativeMessageId, result: turn.result } }
  }

  private async compact(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.compact' }>,
    resident: Resident, connection: Readonly<DeviceSessionBinding>) {
    const manager = resident.allocation.manager
    if (!manager.compactSession) unavailable('The selected native driver cannot compact this session.')
    const reserved = await this.ports.journal.reserveCompact(request.binding, request.requestId,
      commandInputHash({ session: request.session, correlationId: request.correlationId }))
    if (!reserved.dispatch) return {
      compaction: await this.joinCompaction(request, reserved.state, connection, this.lifetime.signal),
    }
    const task = (async () => {
      let offered = false
      let progress = reserved.state
      try {
        const state = await manager.compactSession!(request.session, {
          requestId: request.requestId, clientCorrelationId: request.correlationId,
          onDispatch: async () => {
            await this.authorize(request, connection, this.lifetime.signal)
            progress = await this.ports.journal.compactProgress(request.binding,
              { ...progress, dispatchPhase: 'dispatched' })
            offered = true
          },
          onProgress: async state => { progress = await this.ports.journal.compactProgress(request.binding, state) },
        }, this.lifetime.signal)
        await this.ports.journal.compactProgress(request.binding, state)
      } catch (error) {
        const record = await this.ports.journal.read(request.binding)
        const latest = record?.compactions.find(value => value.state.requestId === request.requestId)?.state ?? reserved.state
        if (['accepted', 'running', 'uncertain'].includes(latest.status)) {
          const definite = !offered || isDefiniteCompactionRejection(error)
          await this.ports.journal.compactProgress(request.binding, { ...latest,
            status: definite ? 'failed' : 'uncertain',
            message: definite ? 'The native provider rejected compaction.' : 'Native compaction needs recovery.',
            observedAt: new Date().toISOString() })
        }
        this.log.error({ err: error, conversationId: request.binding.owner.conversationId }, 'Worker compaction needs recovery')
      }
    })()
    const key = `${request.binding.owner.conversationId}:${request.requestId}`
    this.runningCompactions.set(key, task)
    void task.then(() => this.runningCompactions.delete(key), () => this.runningCompactions.delete(key))
    void this.track(task)
    return { compaction: reserved.state }
  }

  private async joinCompaction(request: WorkerConversationRpcRequest, state: CompactionState,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    if (compactionBlocksSend(state)) return state
    const task = this.runningCompactions.get(`${request.binding.owner.conversationId}:${state.requestId}`)
    if (!task) return state
    // A saved terminal result can precede native cleanup and the final journal write.
    await task
    await this.authorize(request, connection, signal)
    const record = await this.ports.journal.read(request.binding)
    const settled = record?.compactions.find(control => control.state.requestId === state.requestId)
    if (!settled) unavailable('The persisted compaction owner changed.')
    return settled.state
  }

  private async readCompaction(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.compact-read' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    validateConfiguration(request.binding, request.configuration)
    const record = await this.ports.journal.read(request.binding)
    const original = record?.compactions.find(value => value.state.requestId === request.state.requestId)
    if (!record || !original || !isDeepStrictEqual(record.session, request.session)
      || request.state.nativeSessionId !== request.session.nativeSessionId) unavailable('The persisted compaction owner changed.')
    let state = original.state
    if (!compactionBlocksSend(state)) {
      state = await this.joinCompaction(request, state, connection, signal)
      await this.authorize(request, connection, signal)
      return { compaction: state, receipt: await this.ports.journal.read(request.binding) }
    }
    if (this.ports.readCompaction) state = await this.ports.readCompaction({ ...request, state }, record, connection, signal)
    else if (request.configuration.harness.harness === 'claude') {
      const profile = request.configuration.harness.configDirectory
      if (state.claudeSession?.profilePath !== profile
        || state.claudeSession?.cwd !== request.binding.workingDirectory
        || state.claudeSession?.deviceId !== connection.deviceId) unavailable('The persisted Claude profile changed.')
      state = await recoverPersistedClaudeCompaction(state)
    } else unavailable('The selected native driver has no installed compaction reader.')
    await this.authorize(request, connection, signal)
    const compaction = await this.ports.journal.compactProgress(request.binding, state)
    return { compaction: await this.joinCompaction(request, compaction, connection, signal),
      receipt: await this.ports.journal.read(request.binding) }
  }

  async handle(raw: unknown, connection: Readonly<DeviceSessionBinding>, signal = this.lifetime.signal): Promise<unknown> {
    const request = WorkerConversationRpcRequestSchema.parse(raw)
    await this.authorize(request, connection, signal)
    for (const [id, transfer] of this.responseTransfers) {
      if (transfer.expiresAt <= Date.now()) this.removeResponse(id)
    }
    if (request.method === 'conversation.response-continuation') {
      const retained = this.responseTransfers.get(request.transferId)
      if (!retained) unavailable('The conversation response snapshot expired.')
      if (!isDeepStrictEqual(retained.binding, request.binding) || !isDeepStrictEqual(retained.connection, connection)) {
        unavailable('The conversation response owner changed.')
      }
      const metadata = retained.page(request.metadata)
      retained.expiresAt = Date.now() + 120_000
      this.responseTransfers.delete(request.transferId)
      this.responseTransfers.set(request.transferId, retained)
      return WorkerConversationResponsePageSchema.parse({ kind: 'conversation-response-page',
        transferId: request.transferId, metadata })
    }
    const response = await this.readEvents(request, connection, signal)
    if (response === undefined) return response
    const bytes = Buffer.from(JSON.stringify(response))
    if (bytes.byteLength <= DEVICE_APPLICATION_JSON_BYTES) return response
    const page = createJsonContinuationPager(bytes, { maxBytes: WORKER_CONVERSATION_RESPONSE_BYTES })
    const metadata = page()
    while (this.responseBytes + bytes.byteLength > WORKER_CONVERSATION_RESPONSE_BYTES
      || this.responseTransfers.size >= 128) this.removeResponse(this.responseTransfers.keys().next().value!)
    const transferId = randomUUID()
    this.responseTransfers.set(transferId, { binding: structuredClone(request.binding),
      connection: structuredClone(connection), byteSize: bytes.byteLength, page, expiresAt: Date.now() + 120_000 })
    this.responseBytes += bytes.byteLength
    return WorkerConversationResponsePageSchema.parse({ kind: 'conversation-response-page', transferId, metadata })
  }

  private removeResponse(id: string) {
    const transfer = this.responseTransfers.get(id)
    if (!transfer) return
    this.responseBytes -= transfer.byteSize
    this.responseTransfers.delete(id)
  }

  private async readEvents(request: WorkerConversationRpcRequest, connection: Readonly<DeviceSessionBinding>,
    signal: AbortSignal): Promise<unknown> {
    if (request.method !== 'conversation.history' || !request.waitForEvents) {
      return this.dispatch(request, connection, signal)
    }
    if (!request.correlationId || request.afterSequence === undefined) {
      unavailable('An event subscription requires its turn correlation and sequence cursor.')
    }
    const subscription = this.eventWait.subscribe(request.binding.owner.conversationId,
      AbortSignal.any([signal, this.lifetime.signal]))
    try {
      const response = await this.dispatch(request, connection, signal) as {
        history: NativeHistory; receipt: WorkerConversationReceipt
      }
      const turn = response.receipt.turns.find(turn => turn.correlationId === request.correlationId)
      if (response.history.events.length || !turn || ['completed', 'rejected', 'uncertain'].includes(turn.status)) {
        return response
      }
      await subscription.ready
      await this.authorize(request, connection, signal)
      return this.dispatch(request, connection, signal)
    } finally {
      subscription.dispose()
    }
  }

  private async readHistory(request: Extract<WorkerConversationRpcRequest,
    { method: 'conversation.history' | 'conversation.reconcile' }>, resident: Resident, record: WorkerConversationReceipt,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<unknown> {
    const manager = resident.allocation.manager
    const turn = record.turns.find(turn => turn.correlationId === request.correlationId)
    const running = request.correlationId === undefined ? undefined
      : this.running.get(`${request.binding.owner.conversationId}:${request.correlationId}`)
    const submitted = Boolean(turn?.nativeTurnId || turn?.nativeSubmission)
    if (request.method === 'conversation.reconcile' && turn?.nativeSubmission
      && !['completed', 'rejected'].includes(turn.status)) {
      await resident.allocation.recoverClaudeAuthority?.(request, turn.nativeSubmission, signal)
      await this.authorize(request, connection, signal)
    }
    if ((!running || !isDeepStrictEqual(running.connection, connection))
      && request.method === 'conversation.reconcile' && turn?.nativeTurnId
      && !['completed', 'rejected'].includes(turn.status)) {
      if ((request.sessionMode ?? 'regular') !== (turn.sessionMode ?? 'regular')) unavailable('The recovered turn mode changed.')
      await resident.allocation.recoverFiles?.(request, turn.nativeTurnId, signal)
      await this.authorize(request, connection, signal)
    }
    let history: NativeHistory
    if (turn?.status === 'rejected' && turn.result) {
      history = { events: [], pendingInteractions: [], nonSubmission: {
        nativeSessionId: request.session.nativeSessionId, clientCorrelationId: turn.correlationId, result: turn.result,
      } }
    } else if (request.method === 'conversation.history' && request.afterSequence !== undefined && running
      && manager.historyPage) {
      history = await manager.historyPage(request.session, request.afterSequence, signal)
    } else if (request.afterSequence !== undefined && request.correlationId
      && (!running || submitted) && manager.reconcileHistoryPage) {
      history = await manager.reconcileHistoryPage(request.session, request.correlationId, request.afterSequence, signal)
    } else if (turn && request.correlationId && !running) {
      history = await manager.reconcile(request.session, request.correlationId, signal)
    } else {
      // Main can reconcile a message before its Worker reservation exists.
      history = await manager.history(request.session, signal)
    }
    history = this.restoreJournaledResult(request.session, history, turn)
    if (request.correlationId && !running && record.turns.some(turn => turn.correlationId === request.correlationId)) {
      await this.finish(request.binding, request.correlationId, history)
    }
    if (request.afterSequence !== undefined) {
      const after = request.afterSequence
      history = { ...history, events: history.events.filter(event => event.sequence > after) }
    }
    const receipt = await this.ports.journal.read(request.binding)
    const savedTurn = receipt?.turns.find(turn => turn.correlationId === request.correlationId)
    if (running && savedTurn && ['completed', 'rejected'].includes(savedTurn.status)) {
      // Keep Main's callbacks alive until the native stream has drained its terminal result.
      await running.task
      await this.authorize(request, connection, signal)
      const latest = await this.resident(request, connection, signal)
      return this.readHistory(request, latest.resident, latest.record, connection, signal)
    }
    return { history, context: manager.contextSnapshot?.(request.session) ?? null, receipt }
  }

  private async dispatch(request: WorkerConversationRpcRequest, connection: Readonly<DeviceSessionBinding>,
    signal: AbortSignal): Promise<unknown> {
    if (request.method === 'conversation.release-runtime') return this.releaseRuntime(request, connection, signal)
    if (request.method === 'conversation.close') return this.closeConversation(request, connection, signal)
    if (request.method === 'conversation.retire-turn') return this.retireTurn(request, connection, signal)
    if (request.method === 'conversation.status') return { receipt: await this.ports.journal.read(request.binding) }
    if (request.method === 'conversation.release-preparation') {
      const preparation = this.preparations.get(request.binding.owner.conversationId)
      if (preparation) {
        if (!isDeepStrictEqual(preparation.binding, request.binding)) unavailable('The prepared native owner changed.')
        await preparation.allocation.close()
        this.preparations.delete(request.binding.owner.conversationId)
        return { acknowledged: true }
      }
      const record = await this.ports.journal.read(request.binding)
      if (record?.session || record?.turns.length) unavailable('A prepared owner cannot close an admitted model message.')
      const resident = this.residents.get(request.binding.owner.conversationId)
      if (resident) {
        if (!isDeepStrictEqual(resident.binding, request.binding)) unavailable('The prepared native owner changed.')
        await resident.allocation.close()
        this.residents.delete(request.binding.owner.conversationId)
      }
      return { acknowledged: true }
    }
    if (request.method === 'conversation.compact-read') return this.readCompaction(request, connection, signal)
    if (request.method === 'conversation.inspect-entry') {
      if (request.inspection.harness !== request.binding.harness
        || request.inspection.workingDirectory !== request.binding.workingDirectory) {
        unavailable('The native MCP inspector does not address this selected worker profile.')
      }
      if (request.inspection.phase === 'configuration') return this.inspectConfiguration(request, connection, signal)
      const resident = await this.prepare(request, connection, signal)
      if (request.inspection.harness !== request.binding.harness
        || request.inspection.workingDirectory !== request.binding.workingDirectory || !resident.allocation.inspector) {
        unavailable('The native MCP inspector does not address this selected worker profile.')
      }
      return resident.allocation.inspector.inspect({ harness: request.inspection.harness,
        runnerId: request.inspection.runnerId, workingDirectory: request.inspection.workingDirectory,
        serverName: request.inspection.serverName,
        ...(request.inspection.phase ? { phase: request.inspection.phase } : {}), signal })
    }
    if (request.method === 'conversation.open') return this.open(request, connection, signal)
    if (request.method === 'conversation.refresh-mcp') {
      const resident = await this.prepare(request, connection, signal)
      if (!resident.allocation.deliverClaudeCredential || request.binding.harness !== 'claude') {
        unavailable('This native owner has no scoped Claude credential delivery.')
      }
      await resident.allocation.deliverClaudeCredential(request.applicationAccess.token, signal)
      await this.authorize(request, connection, signal)
      return { acknowledged: true }
    }
    if (request.method === 'conversation.capabilities' || request.method === 'conversation.inspect-mcp') {
      const resident = await this.prepare(request, connection, signal)
      return request.method === 'conversation.capabilities' ? resident.allocation.manager.capabilities(signal)
        : resident.allocation.manager.inspectMcp(signal)
    }
    if (request.method === 'conversation.initial-turn') {
      return this.initialInput(request, connection, signal)
    }
    if (!('session' in request)) unavailable('This native operation requires its conversation session.')
    const { resident, record } = await this.resident(request, connection, signal)
    const manager = resident.allocation.manager
    switch (request.method) {
      case 'conversation.start-turn': {
        const reserved = await this.ports.journal.reserveTurn(request.binding, request.correlationId, commandInputHash({
          prompt: request.prompt, mode: request.sessionMode ?? 'regular', preferences: request.preferences ?? null }),
        { mode: request.sessionMode ?? 'regular' })
        if (reserved.dispatch) this.pump(resident, request, connection, () => this.continuedInput(resident, request, connection, request.session))
        return { receipt: await this.ports.journal.read(request.binding) }
      }
      case 'conversation.history':
      case 'conversation.reconcile':
        return this.readHistory(request, resident, record, connection, signal)
      case 'conversation.pending': return manager.pending(request.session, signal)
      case 'conversation.controls-read': return {
        capabilities: await manager.sessionControlCapabilities?.(request.session) ?? null,
        context: manager.contextSnapshot?.(request.session) ?? null,
        preferences: manager.appliedSessionPreferences?.(request.session) ?? null,
        receipt: await this.ports.journal.read(request.binding),
      }
      case 'conversation.preferences':
        if (!manager.applySessionPreferences) unavailable('The native driver cannot apply these preferences.')
        await this.ports.journal.preferences(request.binding, request.preferences, record.appliedPreferences)
        if (record.turns.some(turn => !['completed', 'rejected'].includes(turn.status))
          || record.compactions.some(control => ['accepted', 'running', 'uncertain'].includes(control.state.status))) {
          return { receipt: await this.ports.journal.read(request.binding) }
        }
        await manager.applySessionPreferences(request.session, request.preferences, signal)
        return { receipt: await this.ports.journal.preferences(request.binding, request.preferences,
          manager.appliedSessionPreferences?.(request.session) ?? null) }
      case 'conversation.compact': return this.compact(request, resident, connection)
      case 'conversation.compact-reconcile': {
        const original = record.compactions.find(value => value.state.requestId === request.state.requestId)
        if (!original || request.state.nativeSessionId !== request.session.nativeSessionId) unavailable('The compaction owner changed.')
        let state = original.state
        if (compactionBlocksSend(state)) {
          state = await manager.reconcileCompaction?.(request.session, state, signal) ?? state
          state = await this.ports.journal.compactProgress(request.binding, state)
        }
        return { compaction: await this.joinCompaction(request, state, connection, signal) }
      }
      case 'conversation.cancel': return { canceled: await manager.cancel(request.session, signal, request.nativeTurnId) }
      case 'conversation.respond':
        await manager.respond(request.session, request.nativeRequestId, request.option, signal)
        return { receipt: await this.ports.journal.read(request.binding) }
      case 'conversation.response-reconcile': {
        if (!manager.reconcileResponse) unavailable('The native driver cannot recover response delivery.')
        return { history: await manager.reconcileResponse(request.session, request.response, signal),
          context: manager.contextSnapshot?.(request.session) ?? null, receipt: record }
      }
      case 'conversation.response-availability': {
        const query = { nativeRequestId: request.query.nativeRequestId, nativeRequestType: request.query.nativeRequestType,
          ...(request.query.expectedNativeTurnId ? { expectedNativeTurnId: request.query.expectedNativeTurnId } : {}),
          ...(request.query.expectedNativeMessageId ? { expectedNativeMessageId: request.query.expectedNativeMessageId } : {}),
          ...(request.query.expectedGeneration ? { expectedGeneration: request.query.expectedGeneration } : {}) }
        return manager.inspectResponseAvailability ? manager.inspectResponseAvailability(request.session, query, signal)
          : unavailableNativeResponse(request.session, query, 'unsupported')
      }
      case 'conversation.steer':
        if (!manager.steerTurn) unavailable('This native driver cannot steer a turn.')
        return manager.steerTurn(request.session, { prompt: request.prompt,
          clientCorrelationId: request.correlationId, expectedTurnId: request.expectedTurnId }, signal)
      case 'conversation.reconcile-steers': return manager.reconcileSteers?.(request.session, request.inputs, signal) ?? []
    }
  }

  private async closeConversation(request: WorkerConversationRpcRequest & { session: NativeSessionReference },
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const record = await this.ports.journal.read(request.binding)
    if (!record || !isDeepStrictEqual(record.session, request.session)) unavailable('The saved native session changed.')
    if (record.closed) return { receipt: record }
    if (record.runtimeReleased && !this.residents.has(request.binding.owner.conversationId)) {
      return this.closeReleasedSession(request, record, connection)
    }
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (record.connection[field] !== connection[field]) unavailable('The original paired worker authority changed.')
    }
    const id = request.binding.owner.conversationId
    const owned = this.residents.has(id) ? await this.resident(request, connection, signal, { purpose: 'release' }) : undefined
    const resident = owned?.resident
    const latest = owned?.record ?? record
    if (this.allocating.has(id) || !resident && (this.hasRunningOperation(id)
      || latest.turns.some(turn => !['completed', 'rejected'].includes(turn.status))
      || latest.compactions.some(control => compactionBlocksSend(control.state)))) {
      unavailable('Recover the active operation before closing its previous session.')
    }
    const closeRecoveredSession = this.ports.closeRecoveredSession
    if (!resident && !latest.runtimeReleased && !closeRecoveredSession) {
      unavailable('The previous native process closure is unconfirmed.')
    }
    const closing = (async () => {
      const prepared = this.preparations.get(id)
      if (prepared && !isDeepStrictEqual(prepared.binding, request.binding)) unavailable('The prepared native owner changed.')
      await this.ports.journal.closeRequested(request.binding)
      if (resident) {
        if (!resident.allocation.hasExited?.()) await resident.allocation.manager.close(request.session)
        await resident.allocation.close()
        this.residents.delete(id)
      } else if (!latest.runtimeReleased) {
        await closeRecoveredSession!(latest, signal)
      }
      if (prepared) {
        await prepared.allocation.close()
        this.preparations.delete(id)
      }
      await this.ports.journal.closeConfirmed(request.binding)
    })()
    this.allocating.set(id, closing)
    try { await closing } finally { if (this.allocating.get(id) === closing) this.allocating.delete(id) }
    return { receipt: await this.ports.journal.read(request.binding) }
  }

  private async retireTurn(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.retire-turn' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const saved = await this.ports.journal.read(request.binding)
    if (!saved?.turns.some(turn => turn.correlationId === request.correlationId)) {
      unavailable('The native turn is not owned by this conversation.')
    }
    if (saved.runtimeReleased && isDeepStrictEqual(saved.session, request.session)) return { receipt: saved }
    const { resident } = await this.resident(request, connection, signal, { purpose: 'release' })
    if (resident.allocation.hasExited?.()) return this.releaseRuntime(request, connection, signal)
    await resident.allocation.manager.retireTurn?.(request.session, request.correlationId)
    return { receipt: await this.ports.journal.read(request.binding) }
  }

  private async releaseRuntime(request: WorkerConversationRpcRequest & { session: NativeSessionReference },
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const saved = await this.ports.journal.read(request.binding)
    if (!saved?.nativeOwner || !isDeepStrictEqual(saved.session, request.session)) {
      unavailable('The original chat session is unavailable.')
    }
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (saved.connection[field] !== connection[field]) unavailable('The original paired worker authority changed.')
    }
    if (saved.runtimeReleased) {
      return { receipt: await this.ports.journal.rebind(request.binding, connection, saved.nativeOwner) }
    }
    const id = request.binding.owner.conversationId
    let resident: Resident | undefined
    let record = saved
    if (this.residents.has(id)) {
      const owned = await this.resident(request, connection, signal, { purpose: 'release' })
      resident = owned.resident
      record = owned.record
    }
    if (this.hasRunningOperation(id) || record.turns.some(turn => !['completed', 'rejected'].includes(turn.status))
      || record.compactions.some(control => compactionBlocksSend(control.state))) {
      unavailable('Finish the active operation before releasing its native process. DEBUG ' + JSON.stringify({
        running: [...this.running.keys()], compactions: [...this.runningCompactions.keys()],
        turns: record.turns.map(turn => ({ c: turn.correlationId, s: turn.status })),
        compact: record.compactions.map(control => control.state) }))
    }
    if (this.allocating.has(id)) unavailable('The native conversation is busy.')
    const closing = (async () => {
      if (resident) await resident.allocation.close()
      else {
        if (!this.ports.closePersistedRuntime) unavailable('The persisted native process closure cannot be confirmed.')
        await this.ports.closePersistedRuntime(record, connection, signal)
      }
      await this.ports.journal.runtimeReleased(request.binding, connection)
      this.residents.delete(id)
      return resident
    })()
    this.allocating.set(id, closing)
    try { await closing } finally { if (this.allocating.get(id) === closing) this.allocating.delete(id) }
    return { receipt: await this.ports.journal.read(request.binding) }
  }

  private async closeReleasedSession(request: WorkerConversationRpcRequest & { session: NativeSessionReference },
    record: WorkerConversationReceipt, connection: Readonly<DeviceSessionBinding>) {
    const id = request.binding.owner.conversationId
    const nativeOwner = record.nativeOwner
    if (!nativeOwner || !isDeepStrictEqual(record.session, request.session)
      || this.allocating.has(id) || this.hasRunningOperation(id)
      || record.turns.some(turn => !['completed', 'rejected'].includes(turn.status))
      || record.compactions.some(control => compactionBlocksSend(control.state))) {
      unavailable('The persisted session is unavailable or still busy.')
    }
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (record.connection[field] !== connection[field]) unavailable('The original paired worker authority changed.')
    }
    const closing = (async () => {
      if (!isDeepStrictEqual(record.connection, connection)) {
        await this.ports.journal.rebind(request.binding, connection, nativeOwner)
      }
      await this.ports.journal.closeRequested(request.binding)
      await this.ports.journal.closeConfirmed(request.binding)
    })()
    this.allocating.set(id, closing)
    try { await closing } finally { if (this.allocating.get(id) === closing) this.allocating.delete(id) }
    return { receipt: await this.ports.journal.read(request.binding) }
  }

  private async releaseRecord(record: WorkerConversationReceipt, connection: Readonly<DeviceSessionBinding>,
    signal: AbortSignal) {
    const id = record.binding.owner.conversationId
    if (this.hasRunningOperation(id) || record.turns.some(turn => !['completed', 'rejected'].includes(turn.status))
      || record.compactions.some(control => compactionBlocksSend(control.state))) {
      unavailable('Finish the active operation before releasing its native process.')
    }
    if (record.closed || record.closing || !record.session || !record.nativeOwner) {
      unavailable('The original native conversation is unavailable.')
    }
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (record.connection[field] !== connection[field]) unavailable('The original paired Worker authority changed.')
    }
    const resident = this.residents.get(id)
    if (resident) {
      if (!isDeepStrictEqual(resident.binding, record.binding)) unavailable('The native chat owner changed.')
      if (!isDeepStrictEqual(record.nativeOwner,
        sessionOwner(await resident.allocation.nativeOwner(record.session, { allowExited: true })))) {
        unavailable('The original native process owner changed.')
      }
      await resident.allocation.close()
      this.residents.delete(id)
    } else if (!record.runtimeReleased) {
      if (!this.ports.closeRecoveredSession) unavailable('The persisted native process cannot be closed.')
      await this.ports.closeRecoveredSession(record, signal)
    }
    return this.ports.journal.runtimeReleased(record.binding, connection)
  }

  private async replaceSession(request: Extract<WorkerConversationRpcRequest,
    { method: 'conversation.open' | 'conversation.initial-turn' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    if (!request.previousBinding || !request.previousConfiguration
      || request.method === 'conversation.open' && request.mode !== 'create') {
      unavailable('Native replacement requires its previous Agent configuration and binding.')
    }
    const id = request.binding.owner.conversationId
    if (this.allocating.has(id) || this.hasRunningOperation(id)) unavailable('The native conversation is busy.')
    const input = { ...request }
    delete input.admissionId
    const inputHash = commandInputHash(input)
    const task = (async () => {
      const record = await this.ports.journal.inspectReplacement(request.previousBinding!, request.binding,
        request.previousConfiguration!, request.configuration, request.operationId, inputHash)
      if (isDeepStrictEqual(record.binding, request.binding)) return
      await this.releaseRecord(record, connection, signal)
      const preparation = this.preparations.get(id)
      if (preparation) {
        await preparation.allocation.close()
        this.preparations.delete(id)
      }
      await this.authorize(request, connection, signal)
      await this.ports.journal.replaceSession(request.previousBinding!, request.binding,
        connection, request.operationId, inputHash)
    })()
    const changing = task
    this.allocating.set(id, changing)
    try { await task } finally { if (this.allocating.get(id) === changing) this.allocating.delete(id) }
  }

  async drainForUpdate(): Promise<void> {
    while (this.tasks.size || this.allocating.size) {
      await Promise.allSettled([...this.tasks, ...this.allocating.values()])
    }
  }

  async shutdown() {
    this.closing = true
    this.lifetime.abort(new DomainError('ENGINE_RESTART', 'The worker native owner is shutting down.', 503))
    await Promise.allSettled([...this.tasks, ...this.allocating.values()])
    const results = await Promise.allSettled([...this.residents.values(), ...this.preparations.values()]
      .map(resident => resident.allocation.close()).concat([...this.inspections].map(allocation => allocation.close())))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Worker conversation cleanup is incomplete.')
    this.residents.clear()
    this.preparations.clear()
    this.inspections.clear()
    this.responseTransfers.clear()
    this.responseBytes = 0
  }
}
