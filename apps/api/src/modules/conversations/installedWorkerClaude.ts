import type { ProviderAccountResolver } from '../provider-accounts/service.js'
import { assertWorkerProviderAccountBinding } from '../provider-accounts/workerOperations.js'
import { managedProviderEnvironment, resolveRuntimeProviderAccount } from '../harnesses/providerAccountRuntime.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkerConversationBinding, WorkerConversationConfiguration,
  WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { DomainError } from '../errors.js'
import { inspectInstalledClaude } from '../harnesses/installedClaudeInspection.js'
import { compileClaudeConfiguration } from '../harnesses/claudeSdk/configuration.js'
import { createClaudeSdkCallbacks } from '../harnesses/claudeSdk/sdkCallbacks.js'
import { createClaudeSdkRunner } from '../harnesses/claudeSdk/runner.js'
import { loadInstalledClaudeSdk, loadOfficialClaudeSdk } from '../harnesses/claudeSdk/official.js'
import { allocateClaudeNativeHarness } from '../harnesses/claudeSdk/composition.js'
import { claudeProductionMcpInspector } from '../harnesses/claudeSdk/productionMcpInspector.js'
import { appMcpServerName, isSupportedAppMcpServerName } from '../harnesses/appMcpLauncher.js'
import type { NativeProcessRegistry, NativeProcessRecovery } from '../harnesses/recovery/processRegistry.js'
import type { InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { createUnboundWorkerMcpEndpoint } from '../runs/remote/workerMcpEndpoint.js'
import { installedConversationDirectory } from './installedConversationDirectory.js'
import { createInstalledClaudeConversationProfile } from './installedClaudeConversationProfile.js'
import { createWorkerClaudeAuthority } from './workerClaudeAuthority.js'
import { prepareWorkerConversationMcp } from './workerMcpAccess.js'
import { createWorkerClaudeOwner } from './workerClaudeOwner.js'
import type { workerConversationCallbacks } from './workerCallbacks.js'
import type { WorkerConversationAllocation } from './workerHost.js'
import { createWorkerClaudeFiles } from './workerClaudeFiles.js'
import type { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationAccountOwner } from './workerAccountSession.js'
import { acceptedClaudeAppTools } from '../harnesses/claudeSdk/mcpPolicy.js'
import { workerConversationSessionStart } from './workerConversationStart.js'

export async function allocateInstalledWorkerClaude(input: {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  connection: Readonly<DeviceSessionBinding>
  purpose: 'chat' | 'compaction-read' | 'preparation'
  stateDirectory: string
  selection: InstalledWorkflowConfigurationLocation | null
  launcher: string
  current(): Readonly<DeviceSessionBinding>
  source(): WorkerConversationRpcRequest
  callbacks: ReturnType<typeof workerConversationCallbacks>
  approvedRoots(): Promise<ApprovedRootAllowlist>
  registry: NativeProcessRegistry
  journal: WorkerConversationJournal
  request(namespace: string, payload: unknown, options: { signal: AbortSignal }): Promise<DeviceApplicationResult>
  signal: AbortSignal
  accounts?: ProviderAccountResolver
}): Promise<WorkerConversationAllocation> {
  const binding = structuredClone(input.binding)
  const configuration = structuredClone(input.configuration)
  if (configuration.harness.harness !== 'claude' || binding.harness !== 'claude') throw new DomainError(
    'HARNESS_CONFIGURATION_MISMATCH', 'Claude allocation requires the saved Claude profile.', 409)
  assertWorkerProviderAccountBinding(binding.accountBinding, input.connection)
  const accountOwner = await workerConversationAccountOwner(binding, input.journal, input.source())
  const account = await resolveRuntimeProviderAccount(input.accounts, 'claude', configuration.harness.accountId,
    input.registry.scope(accountOwner), undefined, binding.accountBinding)
  if (account && (account.homePath !== configuration.harness.configDirectory
    || account.authMode !== configuration.harness.authMode)) throw new DomainError(
      'PROVIDER_ACCOUNT_CONFIGURATION_CONFLICT', 'The accepted Worker Claude profile differs from its account.', 409)
  const nativeEnvironment = account ? managedProviderEnvironment(process.env, account, 'claude') : { ...process.env }
  const directory = await installedConversationDirectory({ binding, configuration, approvedRoots: input.approvedRoots })
  const profiles = createInstalledClaudeConversationProfile({ binding, configuration, connection: input.connection,
    current: input.current, signal: input.signal, readFacts: signal => input.callbacks.profile(input.source(), signal),
    inspect: signal => inspectInstalledClaude({ binding: input.current(), configuration: input.selection,
      environment: nativeEnvironment, cwd: input.stateDirectory, signal }) })
  const original = await profiles.capture()
  const binary = original.installation.launcher.resolvedLauncher
  if (!binary) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'The installed Claude executable is unavailable.', 409)
  const compiled = compileClaudeConfiguration(configuration.harness, binding.workingDirectory,
    original.accepted, nativeEnvironment, account?.apiKey)
  const reader = input.purpose === 'compaction-read'
  let owner = `conversation:${binding.owner.conversationId}`
  if (reader) owner = `conversation-read:${binding.owner.conversationId}:${randomUUID()}`
  if (input.purpose === 'preparation') owner = `conversation-prepare:${binding.owner.conversationId}:${randomUUID()}`
  const recovery = input.registry.scope(owner)
  const reservation = workerClaudeReservation(input.registry, recovery)
  const before = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    await directory.assertCurrent(signal)
    const current = await profiles.capture()
    const policy = compileClaudeConfiguration(configuration.harness, binding.workingDirectory,
      current.accepted, nativeEnvironment, account?.apiKey)
    const changedFields = (Object.keys(policy) as Array<keyof typeof policy>)
      .filter(field => !isDeepStrictEqual(policy[field], compiled[field]))
    const nativePinChanged = !isDeepStrictEqual(current.accepted.currentBinding.pin, original.accepted.currentBinding.pin)
    if (changedFields.length || nativePinChanged) throw new DomainError(
      'HARNESS_PROFILE_UNAVAILABLE', 'The accepted Claude native policy changed.', 409,
      { changedFields, nativePinChanged })
  }

  const appAccess = reader ? 'none' : binding.appMcpAccess
  let mcp: Awaited<ReturnType<typeof createUnboundWorkerMcpEndpoint>> | undefined
  let token: string | undefined
  let environment: Awaited<ReturnType<typeof prepareWorkerConversationMcp>>['environment'] | undefined
  const buildStart = (options: Parameters<WorkerConversationAllocation['start']>[0]) =>
    workerConversationSessionStart(binding, configuration, environment, options)
  const start: WorkerConversationAllocation['start'] = async options => {
    await before(input.signal)
    await reservation.reserve()
    if (options.applicationAccess && options.applicationAccess.token !== token) {
      await deliverScopedCredential(options.applicationAccess.token, input.signal, options)
    }
    return buildStart(options)
  }
  const inspectionStart = () => start({ correlationId: `inspection:${binding.owner.conversationId}`, instructionsDelivered: true })
  const serverName = appMcpServerName(compiled.mcpServers)
  const configured = compiled.mcpServers[serverName]
  const fileSdk = !reader && input.purpose === 'chat' ? await loadInstalledClaudeSdk(original.sdk.entrypoint) : undefined
  if (appAccess === 'scoped' && configured?.type === 'http') {
    mcp = await createUnboundWorkerMcpEndpoint({ launcher: input.launcher, signal: input.signal })
  }
  const callbackConfiguration = { ...compiled.configuration, mcpServers: { ...compiled.configuration.mcpServers,
    ...(mcp && configured?.type === 'http' ? { [serverName]: { ...configured, url: mcp.endpoint } } : {}) } }
  const nativeOwner = createWorkerClaudeOwner({ binding, owner, registry: input.registry, journal: input.journal,
    current: input.current })
  const authority = createWorkerClaudeAuthority({ configuration: callbackConfiguration,
    version: original.accepted.currentBinding.pin.cliVersion, signal: input.signal, source: input.source,
    beginOwnerChange: nativeOwner.beginOwnerChange, refreshOwner: nativeOwner.refreshOwner,
    callbackJournal: input.journal.claudeCallbackJournal(binding, input.source()), request: input.callbacks.claudeAuthority })
  const runner = createClaudeSdkRunner({ loadClient: async () => {
    await before(input.signal)
    await reservation.reserve()
    return loadOfficialClaudeSdk(compiled.configuration.configDirectory, recovery, binary, original.sdk.entrypoint)
  } })
  const callbacks = createClaudeSdkCallbacks({ manager: () => manager, bridge: authority.bridge })
  const fileServer = fileSdk ? createWorkerClaudeFiles({
    sdk: fileSdk, manager: () => manager,
    authority, allowMutation: compiled.configuration.sandbox !== 'read-only', signal: input.signal,
  }) : undefined
  authority.bridge.bindMcpTools(fileServer ? [fileServer.manifest] : [])
  const nativeServers = { ...(appAccess === 'none' ? Object.fromEntries(Object.entries(compiled.mcpServers)
    .filter(([name]) => !isSupportedAppMcpServerName(name))) : compiled.mcpServers),
  ...(mcp && configured?.type === 'http' ? { [serverName]: { ...configured, url: mcp.endpoint } } : {}),
  ...(fileServer ? { 'graphql-files': fileServer.server } : {}) }
  const sdkOptions: Record<string, unknown> = { ...compiled,
    mcpServers: nativeServers,
    includePartialMessages: true, ...callbacks }
  delete sdkOptions.configuration
  delete sdkOptions.qualification
  const allocation = allocateClaudeNativeHarness({ harness: 'claude', role: binding.owner.kind === 'operator' ? 'operator' : 'agent-chat',
    workingDirectory: binding.workingDirectory,
    ownerAgentId: binding.owner.kind === 'operator' ? binding.owner.operatorId : binding.owner.agentId,
    processRecovery: recovery, appMcpAccess: appAccess,
    scope: { deviceId: input.connection.deviceId, profilePath: compiled.configuration.configDirectory,
      configRevision: original.accepted.currentBinding.pin.configRevision, cwd: binding.workingDirectory },
    runner, sdkOptions,
    qualification: { sdkVersion: original.accepted.currentBinding.pin.sdkVersion,
      cliVersion: original.accepted.currentBinding.pin.cliVersion, basicTurns: compiled.qualification.basicTurns,
      resume: compiled.qualification.resume, fork: compiled.qualification.fork, history: compiled.qualification.history,
      interactions: compiled.qualification.policy.alwaysAppliedToolHook },
    inspectionStart, expectedMcp: { serverName }, interactionPort: authority.interactionPort,
    liveCallbacks: authority.bridge, cancelPendingRequests: () => authority.bridge.cancelPendingRequests(),
    pendingInteractions: session => authority.bridge.pendingInteractions(session),
    responseDeliveries: session => authority.bridge.deliveryEvidence(session),
    messageSubmitted: async correlationId => Boolean((await input.journal.read(binding))?.turns
      .find(turn => turn.correlationId === correlationId)?.nativeSubmission),
    ownerForStart: source => ({ ownerId: binding.owner.conversationId, attemptId: source.correlationId ?? owner,
      generation: recovery.launchId ?? owner }),
  })
  const manager = allocation.manager
  authority.bind(manager)
  async function deliverScopedCredential(nextToken: string, signal: AbortSignal,
    startup: Parameters<WorkerConversationAllocation['start']>[0]) {
    authority.bridge.bindMcpTools(fileServer ? [fileServer.manifest] : [])
    if (appAccess !== 'scoped' || configured?.type !== 'http' || !mcp) {
      throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'This native owner has no scoped HTTP MCP connection.', 403)
    }
    await before(signal)
    const saved = await input.journal.read(binding)
    const residentSession = saved?.session && manager.hasResidentSession(saved.session) ? saved.session : undefined
    if (!residentSession) await manager.prepareInspection(buildStart(startup), signal)
    if (token !== nextToken) {
      const relay = await prepareWorkerConversationMcp({ source: input.source(), token: nextToken,
        request: input.request, signal: input.signal })
      await mcp.bindRelay(relay)
      environment = relay.environment
      token = nextToken
    }
    const servers = { ...nativeServers,
      [serverName]: { ...configured, url: mcp.endpoint, headers: { Authorization: `Bearer ${nextToken}` } } }
    const snapshot = residentSession
      ? await manager.refreshSessionCredentials(residentSession, buildStart(startup), servers, signal)
      : await manager.refreshInspectionCredentials(buildStart(startup), servers, signal)
    if (snapshot.httpCredentialAcknowledgement?.endpoint !== mcp.endpoint) throw new DomainError(
      'CLAUDE_MCP_CREDENTIAL_DELIVERY_UNCONFIRMED', 'The SDK has not acknowledged the scoped worker credential.', 409)
    const manifests = await acceptedClaudeAppTools({ configuration: callbackConfiguration,
      servers: { [serverName]: { ...configured, url: mcp.endpoint, headers: { Authorization: `Bearer ${nextToken}` } } },
      token: nextToken, signal })
    authority.bridge.bindMcpTools([...manifests, ...(fileServer ? [fileServer.manifest] : [])])
  }
  const inspect = claudeProductionMcpInspector({ manager: () => manager, start: inspectionStart,
    workingDirectory: binding.workingDirectory, cliVersion: original.accepted.currentBinding.pin.cliVersion })
  return { manager, start,
    recoverClaudeAuthority: authority.recover,
    inspector: { async inspect(request) {
      await before(request.signal)
      const result = await inspect.inspect(request)
      if (mcp && configured?.type === 'http' && result.entry?.endpoint === mcp.endpoint) {
        result.entry.pairedEndpoint = { mainId: input.connection.mainId, deviceId: input.connection.deviceId,
          configuredEndpoint: configured.url, nativeEndpoint: mcp.endpoint }
      }
      return result
    } },
    async deliverClaudeCredential(nextToken, signal) {
      await deliverScopedCredential(nextToken, signal, {
        correlationId: `inspection:${binding.owner.conversationId}`, instructionsDelivered: true,
      })
    },
    nativeOwner: nativeOwner.nativeOwner,
    hasExited: nativeOwner.hasExited,
    async close() {
      await manager.dispose?.()
      authority.bridge.close()
      await reservation.close()
      await mcp?.close()
      await fileServer?.close()
    },
  }
}

function workerClaudeReservation(registry: NativeProcessRegistry, recovery: NativeProcessRecovery) {
  let pending: Promise<void> | undefined
  return {
    reserve() {
      pending ??= registry.reserveLaunch(recovery.owner).then(scope => { Object.assign(recovery, scope) })
      return pending
    },
    async close() {
      if (!pending) return
      await pending
      await registry.abandonReservedLaunch(recovery)
      if (!await registry.closeOwner(recovery.owner)) throw new DomainError('CLAUDE_PROCESS_CLOSURE_PENDING',
        'The native Claude chat has not stopped.', 409)
    },
  }
}
