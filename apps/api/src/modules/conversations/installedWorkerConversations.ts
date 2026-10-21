import type { ProviderAccountResolver } from '../provider-accounts/service.js'
import { assertWorkerProviderAccountBinding } from '../provider-accounts/workerOperations.js'
import { managedProviderEnvironment, resolveRuntimeProviderAccount } from '../harnesses/providerAccountRuntime.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { WorkerConversationRpcRequestSchema, type WorkerConversationBinding,
  type WorkerConversationConfiguration, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { createWorkerMcpEndpoint } from '../runs/remote/workerMcpEndpoint.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { NativeProcessRegistry, type NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { CodexAppServerSessionManager, safeEnvironment, type CodexSessionDependencies } from '../harnesses/codexAppServer.js'
import { CodexDiagnostics } from '../harnesses/codexDiagnostics.js'
import { codexMcpInspectorAdapter } from '../harnesses/codexMcpInspectorAdapter.js'
import { inspectInstalledCodex } from '../harnesses/installedCodexInspection.js'
import { PayloadFingerprintCache } from '../harnesses/payloadFingerprintCache.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import { createInstalledCodexDependencies } from '../harnesses/installedCodexDependencies.js'
import { DomainError } from '../errors.js'
import { createInstalledConversationNativeReader } from './installedNativeProfile.js'
import { installedConversationDirectory } from './installedConversationDirectory.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { prepareWorkerConversationMcp } from './workerMcpAccess.js'
import { appLauncherPath } from '../harnesses/appMcpLauncher.js'
import { WorkerConversationHost, type WorkerConversationAllocation } from './workerHost.js'
import type { WorkerConversationChannel } from './workerBridge.js'
import { allocateInstalledWorkerClaude } from './installedWorkerClaude.js'
import { WorkerConversationFiles } from './workerFiles.js'
import { localCodexChatHost } from '../harnesses/codexFiles/localHost.js'
import { assertCodexChatHost } from '../harnesses/codexFiles/localHost.js'
import { closeRecoveredWorkerSession, workerConversationProcessDigest } from './workerNativeOwner.js'
import { recoverWorkerConversation } from './recoverWorkerConversation.js'
import { join } from 'node:path'
import { workerConversationAccountOwner } from './workerAccountSession.js'

function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', message, 409)
}

interface InstalledWorkerConversationsInput {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation | null
  registry: NativeProcessRegistry
  journal(): Promise<RemoteOperationJournal>
  current(): Readonly<DeviceSessionBinding>
  capture(): WorkerConversationChannel | undefined
  request(namespace: string, payload: unknown, options: { signal: AbortSignal }): Promise<DeviceApplicationResult>
  approvedRoots(): Promise<ApprovedRootAllowlist>
  codexSuiteRevision: string
  accounts?: ProviderAccountResolver
  signal: AbortSignal
}

function createInstalledConversationAllocator(input: InstalledWorkerConversationsInput,
  conversationJournal: RemoteOperationJournal['conversations'], source: () => WorkerConversationRpcRequest,
  callbacks: ReturnType<typeof workerConversationCallbacks>, files: WorkerConversationFiles) {
  const payloadFingerprints = new PayloadFingerprintCache()
  return async function allocate(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, purpose: 'chat' | 'compaction-read' | 'preparation'): Promise<WorkerConversationAllocation> {
    const harness = binding.harness
    if (harness === 'claude') return allocateInstalledWorkerClaude({ binding, configuration, connection, purpose,
      stateDirectory: input.stateDirectory, selection: input.configuration, launcher: appLauncherPath(),
      journal: conversationJournal,
      current: input.current, source, callbacks, approvedRoots: input.approvedRoots, registry: input.registry,
      request: input.request, signal: input.signal, ...(input.accounts ? { accounts: input.accounts } : {}) })
    if (harness !== 'codex') unavailable('The installed native selection does not support this driver.')
    if (configuration.harness.harness !== 'codex') unavailable('The selected Codex configuration changed.')
    assertWorkerProviderAccountBinding(binding.accountBinding, connection)
    const accountOwner = await workerConversationAccountOwner(binding, conversationJournal, source())
    const account = await resolveRuntimeProviderAccount(input.accounts, 'codex', configuration.harness.accountId,
      input.registry.scope(accountOwner), undefined, binding.accountBinding)
    const environment = account ? managedProviderEnvironment(process.env, account, 'codex') : process.env
    const directory = await installedConversationDirectory({ binding, configuration, approvedRoots: input.approvedRoots })
    const reader = createInstalledConversationNativeReader({ binding, configuration, connection,
      current: input.current, signal: () => input.signal, suiteRevision: input.codexSuiteRevision,
      inspect: signal => inspectInstalledCodex({ binding: input.current(), configuration: input.configuration,
        environment, cwd: input.stateDirectory, signal, fingerprintCache: payloadFingerprints }),
      readFacts: signal => callbacks.profile(source(), signal),
    })
    const original = await reader.capture()
    const binary = original.inspection.installation.launcher.resolvedLauncher
    if (!binary) unavailable('The selected native launcher is unavailable.')
    let scopeOwner = `conversation:${binding.owner.conversationId}`
    let appMcpAccess = binding.appMcpAccess
    if (purpose === 'compaction-read') {
      scopeOwner = `conversation-read:${binding.owner.conversationId}:${randomUUID()}`
      appMcpAccess = 'none'
    }
    if (purpose === 'preparation') scopeOwner = `conversation-prepare:${binding.owner.conversationId}:${randomUUID()}`
    const scope = input.registry.scope(scopeOwner)
    let launchReservation: Promise<void> | undefined
    const before = async (signal?: AbortSignal) => {
      await directory.assertCurrent(signal)
      await reader.capture()
      signal?.throwIfAborted()
    }
    if (configuration.harness.harness !== 'codex') unavailable('The selected Codex configuration changed.')
    const fileStorageRoot = join(input.stateDirectory, 'conversation-file-storage')
    const assertFileHost = async (signal: AbortSignal) => {
      await before(signal)
      if (configuration.harness.harness !== 'codex' || configuration.harness.sandbox === 'danger-full-access') {
        unavailable('This Codex configuration cannot safely receive attachment paths.')
      }
      await assertCodexChatHost(fileStorageRoot, binding.workingDirectory,
        configuration.harness.advanced?.additionalWritableDirectories ?? [],
        configuration.harness.sandbox === 'workspace-write')
    }
    const fileAdapter = purpose === 'chat'
      ? files.adapter({ source, signal: input.signal, assertCurrent: assertFileHost,
        host: () => localCodexChatHost(fileStorageRoot) }) : undefined
    const chatFiles = fileAdapter ? { prepare: (turn: Parameters<typeof fileAdapter.prepare>[0]) => {
      const request = source()
      const hasFiles = appMcpAccess === 'none' || request.method === 'conversation.start-turn' && request.fileInputs
      return hasFiles ? fileAdapter.prepare(turn) : Promise.resolve(undefined)
    } } : undefined
    const dependencies = createInstalledCodexDependencies({ reader, codexSuiteRevision: input.codexSuiteRevision })
    const operations: Extract<CodexSessionDependencies, { mode: 'native' }> = { ...dependencies,
      environment: (variables, scopedNames) => {
        const source = safeEnvironment(variables, scopedNames)
        return account ? managedProviderEnvironment(source, account, 'codex') : source
      },
      qualify: async (executable, cwd, environment, authenticated, signal, recovery = scope) => {
        await before(signal)
        return dependencies.qualify(executable, cwd, environment, authenticated, signal, recovery)
      },
      assertUnchanged: async qualified => { await before(); await dependencies.assertUnchanged(qualified) },
      runCommand: async (executable, args, cwd, signal, environment, options) => {
        await before(signal)
        return dependencies.runCommand(executable, args, cwd, signal, environment,
          { ...options, recovery: options?.recovery ?? scope })
      },
      qualifyModel: async (configuration, executable, cwd, environment, signal, recovery = scope, inspection) => {
        await before(signal)
        return dependencies.qualifyModel(configuration, executable, cwd, environment, signal, recovery, inspection)
      },
    }
    const diagnostics = new CodexDiagnostics({ native: operations,
      createRecovery: () => input.registry.scope(`conversation-diagnostics:${binding.owner.conversationId}:${randomUUID()}`),
      admitRecovery: async recovery => { Object.assign(recovery, await input.registry.reserveLaunch(recovery.owner)) },
      abandonRecovery: async recovery => { await input.registry.abandonReservedLaunch(recovery) },
      closeRecovery: async recovery => {
        if (!await input.registry.closeOwner(recovery.owner)) unavailable('Native diagnostic closure is unconfirmed.')
      },
    })
    const native = new CodexAppServerSessionManager(binary, original.qualification.version, undefined, scope, appMcpAccess,
      chatFiles, { ...operations, withDiagnostics: (pin, run) => diagnostics.run(pin, run, scope) })
    const manager: NativeHarnessSessionManager = native
    const inspector: NativeMcpInspector = codexMcpInspectorAdapter(native)
    let mcp: Awaited<ReturnType<typeof createWorkerMcpEndpoint>> | undefined
    let mcpEnvironment: Awaited<ReturnType<typeof prepareWorkerConversationMcp>>['environment'] | undefined
    let launch: NativeLaunchObservation | undefined
    const nativeOwner: WorkerConversationAllocation['nativeOwner'] = async (session, options) => {
      const rows = input.registry.snapshot().launches.filter(value => value.owner === scope.owner
        && (value.lifecycle === 'active' || options?.allowExited
          && (value.lifecycle === 'ended' || value.lifecycle === 'closed' && value.closureEvidence)))
      let current = rows.length === 1 ? rows[0] : undefined
      if (launch) current = rows.find(value => value.launchId === launch!.launchId)
      if (!current && launch && options?.allowExited) current = input.registry.closedRegistration(scope.owner, launch.launchId)
      if (!current?.guardian || !current.provider || !current.boundary || launch
        && workerConversationProcessDigest(binding, launch) !== workerConversationProcessDigest(binding, current)
        || current.lifecycle !== 'active' && rows.some(row => row.lifecycle === 'active' && row.launchId !== current.launchId)) {
        unavailable('The original native chat process is unavailable or changed.')
      }
      launch ??= current
      return { sessionId: session.nativeSessionId, processIdentityDigest: workerConversationProcessDigest(binding, launch) }
    }
    const start: WorkerConversationAllocation['start'] = async options => {
      await before(input.signal)
      if (purpose === 'chat') {
        launchReservation ??= input.registry.reserveLaunch(scope.owner).then(reserved => { Object.assign(scope, reserved) })
        await launchReservation
        input.signal.throwIfAborted()
      }
      let environment: Awaited<ReturnType<typeof prepareWorkerConversationMcp>>['environment'] | undefined
      if (options.applicationAccess) {
        if (mcp) unavailable('The native chat already has a scoped MCP route.')
        const relay = await prepareWorkerConversationMcp({ source: source(), token: options.applicationAccess.token,
          request: input.request, signal: input.signal })
        mcp = await createWorkerMcpEndpoint({ relay, launcher: appLauncherPath(), signal: input.signal })
        environment = relay.environment
        mcpEnvironment = relay.environment
      }
      const owner = binding.owner
      if (owner.kind === 'operator' && 'operatorId' in configuration) {
        return { kind: 'operator', configuration, correlationId: options.correlationId,
          workingDirectory: binding.workingDirectory, ...(environment ? { environment } : {}) }
      }
      if (owner.kind !== 'agent' || !('agentId' in configuration) || environment) unavailable('The native chat role changed.')
      return { kind: 'agent-chat', configuration, conversationId: owner.conversationId, workflowId: owner.workflowId,
        workflowNodeId: owner.workflowNodeId, correlationId: options.correlationId,
        ...(binding.systemPrompt ? { systemPrompt: binding.systemPrompt } : {}),
        workingDirectory: binding.workingDirectory, instructionsDelivered: options.instructionsDelivered }
    }
    return { manager, inspector, nativeOwner, start,
      hasExited() {
        const original = launch
        return original !== undefined && input.registry.snapshot().launches.some(current =>
          current.owner === scope.owner && current.launchId === original.launchId
          && (current.lifecycle === 'ended' || current.lifecycle === 'closed')
          && workerConversationProcessDigest(binding, current) === workerConversationProcessDigest(binding, original))
      },
      async refreshApplicationAccess(token, signal) {
        if (!mcp || !mcpEnvironment || appMcpAccess !== 'scoped') unavailable('The retained Codex MCP route is unavailable.')
        await before(signal)
        const relay = await prepareWorkerConversationMcp({ source: source(), token,
          request: input.request, signal: input.signal })
        // The running process keeps its local launcher token; Main receives the fresh turn credential.
        await mcp.bindRelay({ ...relay, environment: mcpEnvironment })
        signal.throwIfAborted()
      },
      ...(harness === 'codex' ? {
        recoverFiles: (request, nativeTurnId, signal) => files.recover(request, nativeTurnId, signal),
      } satisfies Pick<WorkerConversationAllocation, 'recoverFiles'> : {}),
      async close() {
        const errors: unknown[] = []
        diagnostics.stop()
        try { await manager.dispose?.() } catch (error) { errors.push(error) }
        try { await diagnostics.dispose() } catch (error) { errors.push(error) }
        await launchReservation
        if (scope.launchId) await input.registry.abandonReservedLaunch(scope)
        if (!await input.registry.closeOwner(scope.owner)) unavailable('Native chat closure is unconfirmed.')
        if (purpose === 'chat') {
          try {
            await files.closeConversation(binding.owner.conversationId)
          } catch (error) { errors.push(error) }
        }
        try { await mcp?.close() } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'Native chat resources need cleanup retry.')
      } }
  }
}

/** Shipped conversation owner on the existing installed worker, journal and paired channel. */
export async function createInstalledWorkerConversations(input: InstalledWorkerConversationsInput) {
  const selected = await readInstalledWorkflowConfiguration(input.configuration)
  if (!selected) return null
  const conversationJournal = (await input.journal()).conversations
  const operations = new AsyncLocalStorage<WorkerConversationRpcRequest>()
  const source = () => {
    input.signal.throwIfAborted()
    const request = operations.getStore()
    if (!request) unavailable('The native operation has no admitted conversation request.')
    return request
  }
  const callbacks = workerConversationCallbacks({ currentBinding: input.current, capture: input.capture })
  const files = new WorkerConversationFiles(callbacks)
  const allocate = createInstalledConversationAllocator(input, conversationJournal, source, callbacks, files)
  const host = new WorkerConversationHost({ ...callbacks, currentBinding: input.current,
    journal: conversationJournal,
    allocate: (binding, configuration, connection) => allocate(binding, configuration, connection, 'chat'),
    prepare: (binding, configuration, connection) => allocate(binding, configuration, connection, 'preparation'),
    closePersistedRuntime: async (record, connection, signal) => {
      if (!isDeepStrictEqual(input.current(), connection)) unavailable('The selected Worker connection changed.')
      await closeRecoveredWorkerSession(record, input.registry, signal)
    },
    closeRecoveredSession: (record, signal) => closeRecoveredWorkerSession(record, input.registry, signal),
    recover: (record, configuration, connection, signal, request) => recoverWorkerConversation({
      record, configuration, connection, signal, request, registry: input.registry, journal: conversationJournal,
      allocate: () => {
        const originalSkills = request.method === 'conversation.open' && request.previousConfiguration
          && isDeepStrictEqual(configuration, request.previousConfiguration)
        const binding = request.method === 'conversation.open' && request.previousBinding && !originalSkills
          ? request.binding : record.binding
        return allocate(binding, configuration, connection, 'chat')
      },
      assertCurrent: () => callbacks.authorize(request, connection, signal),
    }),
    readCompaction: async (request, _record, connection, signal) => {
      const observer = await allocate(request.binding, request.configuration, connection, 'compaction-read')
      try {
        const start = await observer.start({ correlationId: request.correlationId, instructionsDelivered: true })
        return await observer.manager.readCompaction!(request.session, start, request.state, signal)
      } finally { await observer.close() }
    },
  })
  return {
    handle(raw: unknown, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
      const request = WorkerConversationRpcRequestSchema.parse(raw)
      if (request.method === 'conversation.file-copy') {
        if (!isDeepStrictEqual(input.current(), connection)) unavailable('The attachment copy channel changed.')
        return operations.run(request, () => files.copy(request, signal))
      }
      return operations.run(request, () => host.handle(request, connection, signal))
    },
    drainForUpdate: () => host.drainForUpdate(),
    close: async () => { await host.shutdown(); await files.close() },
  }
}
