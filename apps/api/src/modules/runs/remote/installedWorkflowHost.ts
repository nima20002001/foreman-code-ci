import { workflowPreparationExtension } from './preparationExtension.js'
import type { ProviderAccountResolver, ResolvedProviderAccount } from '../../provider-accounts/service.js'
import { assertWorkerProviderAccountBinding } from '../../provider-accounts/workerOperations.js'
import { managedProviderEnvironment, resolveRuntimeProviderAccount } from '../../harnesses/providerAccountRuntime.js'
import { constants } from 'node:fs'
import { componentLogger } from '../../diagnostics/logger.js'
import { appLauncherPath } from '../../harnesses/appMcpLauncher.js'
import { open, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ExecutionResultSchema, RETIRED_OPENCODE_MESSAGE,
  type HarnessExecutionRequest, type NativeSessionReference } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import {
  DeviceConnectionIdentitySchema,
  WorkerPairingConfigurationSchema,
  type WorkerPairingConfiguration,
} from '@foreman-code/contracts/device-identity'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import type { DispatchIntent, AcceptedNodePlacement, NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import { RemoteNativeIdentitySchema, RemoteTerminalEvidenceSchema, RemoteOperationReceiptSchema, type RemoteReviewerRequest,
  type RemoteNativeIdentity, type RemoteTerminalEvidence, type RemoteApplicationAccess,
  type RemoteOwnerReconciliation } from '@foreman-code/contracts/remote-execution'
import { RemoteWorkflowPhysicalReadoutSchema, remoteWorkflowPhysicalOutput } from '@foreman-code/contracts/remote-workflow-physical'
import { ApprovedRootAllowlistSchema, type ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { SourceMaterializationRecordSchema, type SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { SourceOperationResponseSchema, type SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { DomainError } from '../../errors.js'
import { captureOriginalCodexSession } from '../../harnesses/originalCodexSession.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../../harnesses/port.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../../harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry } from '../../harnesses/installationRegistry.js'
import { CodexAppServerSessionManager, safeEnvironment } from '../../harnesses/codexAppServer.js'
import { inspectInstalledCodex } from '../../harnesses/installedCodexInspection.js'
import { PayloadFingerprintCache } from '../../harnesses/payloadFingerprintCache.js'
import { createInstalledCodexQualificationReader } from '../../harnesses/installedCodexQualification.js'
import { createInstalledCodexDependencies } from '../../harnesses/installedCodexDependencies.js'
import { normalizeHarnessVersion } from '../../harnesses/qualification/profiles.js'
import { NativeProcessRegistry, type NativeLaunchObservation, type NativeProcessRecovery } from '../../harnesses/recovery/processRegistry.js'
import { bootIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { ExecutionScopedNativeSessionManagerResolver, type NativeManagerResolutionContext } from '../../interactions/runtimePorts.js'
import { workerExecutionAuthorizer, workerExecutionFactsReader, workerReviewerAuthorizer } from '../../placement/executionAuthorityClient.js'
import { sourceMaterializationDigest } from '../../sources/bindingHash.js'
import { readNativeExecutionBinding } from '../../placement/executionBinding.js'
import { readPlacement } from '../../placement/binding.js'
import { anchored, identity, openPrivateRoot, openChildDirectory } from '../../sources/privateFilesystem.js'
import type { SourceOperationWorkerService, SourceOperationWorkerContext } from '../../sources/operationWorker.js'
import type { SourceInstalledNativeOwner } from '../../sources/executionHosts.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteExecutionHost } from './executionHost.js'
import { createRemoteExecutionHandler } from './executionRouter.js'
import { RemoteJobExecutionRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { RemoteExecutionRpcRequestSchema, type RemoteExecutionRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceExtensionRegistration, DeviceExtensionContext } from '../../devices/deviceApplicationChannel.js'
import { prepareWorkerApplicationAccess } from './workerApplicationAccess.js'
import { createWorkerMcpEndpoint, isLeaseRefusal, WORKER_MCP_LEASE_RENEWAL_WINDOW_MS } from './workerMcpEndpoint.js'
import { readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation } from './installedWorkflowConfiguration.js'
import { RuntimeLeafAttestationSchema, assertRuntimeLeafPath, type RuntimeLeafAttestation } from './runtimeLeaf.js'
import { InstalledWorkflowPhysicalReadouts, matchingOriginalRegistryLaunch,assertOriginalPhysicalDirectories, remoteWorkflowSourceDigest, remoteWorkflowNativeHistory } from './workflowPhysicalReadout.js'
import { createInstalledNativeOutputs, type InstalledNativeOutputProviders } from './installedNativeOutput.js'
import type { WorkflowOriginalNativeSource } from '../../interactions/workflowNativeCapture.js'
import { createInstalledWorkflowNativeOutputProviders, type CapturedWorkflowMainRequest, type InstalledWorkflowNativeOutputContext } from './installedWorkflowNativeOutputs.js'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema,
  type AgentFilePublishResult } from '@foreman-code/contracts/files'
import { workflowArtifactDigestsByOutputKey, type WorkflowArtifactOutputsV1 } from '@foreman-code/contracts/workflow-artifact-result'
import { projectNativeHistory, nativeHistoryPageSource } from './nativeHistoryPage.js'
import { pagePhysicalReadout } from './workflowPhysicalReadout.js'
import { InstalledWorkflowRecovery } from './installedWorkflowRecovery.js'
import { recoverInstalledWorkflowReply } from './installedWorkflowRecoveryHandler.js'
import { InstalledWorkflowResponsePages } from './installedWorkflowResponsePages.js'
import { hasPositiveRemoteEntryClosure, remoteNonEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { deviceRequestTimeoutMs, retryDeviceRequest } from '../../devices/deviceRequestRetry.js'
import { deviceReconnectTimeoutMs, isDeviceLinkDrop, sameDeviceInstallation, waitForDeviceReconnect } from '../../devices/deviceReconnect.js'

function unavailableError(reason:string) {return new DomainError('WORKER_WORKFLOW_UNAVAILABLE','The original installed workflow authority is unavailable.',409,{reason})}
function unavailable(reason:string):never {throw unavailableError(reason)}
const digest=(value:unknown)=>commandInputHash(value).slice('sha256:'.length)
function connectionIdentity(binding: Readonly<DeviceSessionBinding>): DeviceConnectionIdentity {
  const { mainId, deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration } = binding
  return DeviceConnectionIdentitySchema.parse({
    mainId, deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration,
  })
}
export interface InstalledWorkflowNativeOwner {
  readonly native:RemoteNativeIdentity
  readonly launch:NativeLaunchObservation
  readonly owner:string
}
/** The manager's exact execution owner supplies this single actual guardian/provider pair. Names, PID absence and another launch are never used. */
export function captureInstalledWorkflowNativeOwner(registry:NativeProcessRegistry,connection:DeviceConnectionIdentity,
  intent:DispatchIntent,session:NativeSessionReference):InstalledWorkflowNativeOwner {
  if (session.harness === 'opencode') {
    throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
  }
  if(session.harness !== 'codex'||intent.mainId!==connection.mainId)unavailable('native_binding_conflict')
  const owner=`execution:${intent.executionId}`
  const launches=registry.snapshot().launches.filter(row=>row.owner===owner&&row.lifecycle==='active')
  if(launches.length!==1)unavailable('native_owner_missing_or_ambiguous')
  const launch=launches[0]!
  if(launch.bootId!==connection.bootId||!launch.guardian||!launch.provider||!launch.boundary)unavailable('native_provider_evidence_missing')
  return Object.freeze({owner,launch,native:RemoteNativeIdentitySchema.parse({sessionId:session.nativeSessionId,
    processIdentityDigest:digest({connection,intent,owner,launchId:launch.launchId,bootId:launch.bootId,
      guardian:launch.guardian,provider:launch.provider,boundary:launch.boundary})})})
}

/** Only matched provider history plus positive original registry closure can settle. Manager/process cleanup errors retain the original uncertainty. */
export async function settleInstalledWorkflowNativeOwner(input:{journal:RemoteOperationJournal;registry:NativeProcessRegistry;
  intent:DispatchIntent;history:NativeHistory;captured:InstalledWorkflowNativeOwner;
  manager:NativeHarnessSessionManager;session:NativeSessionReference;artifactOutputs?:WorkflowArtifactOutputsV1;
  publications?:ReadonlyMap<string,AgentFilePublishResult['value']>;
  retainReviewer?: { agentId: string; expiresAt: string }}):Promise<RemoteTerminalEvidence|null> {
  const status=await input.journal.status(input.intent.operationId)
  if(status.status!=='known'||!isDeepStrictEqual(status.receipt.intent,input.intent)||!status.receipt.native
    ||status.receipt.native.sessionId!==input.session.nativeSessionId||input.captured.native.sessionId!==input.session.nativeSessionId
    ||status.receipt.native.processIdentityDigest!==input.captured.native.processIdentityDigest
    ||input.captured.owner!==`execution:${input.intent.executionId}`)unavailable('native_closure_binding_conflict')
  if(status.receipt.terminal)return status.receipt.terminal
  const terminal=status.receipt.retainedReviewer && status.receipt.stopFence ? undefined : input.history.terminalTurn
  if(terminal&&(terminal.correlationId!==status.receipt.turnInput?.correlationId
    ||terminal.providerId!==status.receipt.native.turnId
    ||input.history.nativeTurnId!==undefined&&input.history.nativeTurnId!==status.receipt.native.turnId))unavailable('native_result_correlation_conflict')
  if(!terminal&&!status.receipt.stopFence)return null
  const result=terminal?ExecutionResultSchema.parse(terminal.result):undefined
  if (input.retainReviewer && result?.outcome === 'succeeded' && !status.receipt.stopFence) {
    if (matchingOriginalRegistryLaunch(input.registry, input.captured.launch).lifecycle !== 'active')
      unavailable('original_reviewer_process_closed')
    await input.journal.retainReviewer(input.intent.operationId, input.retainReviewer, input.history)
    return null
  }
  await input.manager.close(input.session)
  await input.registry.closeRegistration(input.registry.scope(input.captured.owner),input.captured.launch.launchId)
  if(!await input.registry.closeOwner(input.captured.owner))return null
  const artifacts = result ? installedWorkflowArtifactSettlement(result, input.artifactOutputs, input.publications) : {}
  return RemoteTerminalEvidenceSchema.parse({kind:result?result.outcome==='succeeded'?'completed':result.outcome==='failed'?'failed':'cancelled':'cancelled',
    closureEvidenceDigest:digest({intent:input.intent,native:status.receipt.native,launch:input.captured.launch,physicalOwnerClosed:true}),
    ...(result?{result,resultDigest:digest(result)}:{}),
    ...artifacts})
}

function installedWorkflowArtifactSettlement(result: NonNullable<RemoteTerminalEvidence['result']>,
  declaration?: WorkflowArtifactOutputsV1, publications?: ReadonlyMap<string, AgentFilePublishResult['value']>
): Pick<RemoteTerminalEvidence, 'artifactDigests' | 'artifactValidationError'> {
  const output = remoteWorkflowPhysicalOutput(result, declaration)
  if (output.kind === 'invalid-artifacts') return { artifactValidationError: output.failure, artifactDigests: [] }
  if (output.kind !== 'published-artifacts') return { artifactDigests: [] }
  const digests: { outputKey: string; sha256: string }[] = []
  for (const mapping of output.artifactOutputs.outputs) {
    const publication = publications?.get(mapping.commandId)
    if (!publication) {
      return { artifactValidationError: { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT' as const,
        reason: 'missing_publication' as const }, artifactDigests: [] }
    }
    digests.push({ outputKey: mapping.outputKey, sha256: publication.revision.sha256 })
  }
  return { artifactDigests: workflowArtifactDigestsByOutputKey(digests) }
}

/** Source verification uses W09's actual Main-authorized worker service. The runtime leaf is a separate anchored directory with an immutable operation receipt. */
export async function attestInstalledWorkflowRuntimeLeaf(input:{sources:SourceOperationWorkerService;context:SourceOperationWorkerContext;
  approvedRoots:ApprovedRootAllowlist;nativePlacement:NativeExecutionPlacement;intent:DispatchIntent;placement:AcceptedNodePlacement;
  request:HarnessExecutionRequest}):Promise<RuntimeLeafAttestation> {
  const {intent,placement,request}=input,executionPlacement=readNativeExecutionBinding(placement,intent,input.nativePlacement)
  const record=SourceMaterializationRecordSchema.parse(executionPlacement.materialization),roots=ApprovedRootAllowlistSchema.parse(input.approvedRoots)
  const binding=record.receipt.binding
  if(placement.payload.kind!=='agent'||placement.hostRef.kind!=='device'||roots.hostRef.kind!=='device'
    ||!isDeepStrictEqual(roots.hostRef,placement.hostRef)||roots.applicationInstallationId!==placement.registration?.workerInstallationId
    ||roots.managedRuntimeRoot!==placement.destination.managedRuntimeRoot||record.operationId!==intent.operationId
    ||record.receipt.executionId!==intent.executionId||record.receipt.attemptId!==intent.attemptId
    ||record.receipt.materializationId!==executionPlacement.workingTree.materializationId
    ||record.finalDispatchBindingHash!==executionPlacement.bindingHash||placement.bindingHash!==intent.bindingHash
    ||binding.mainId!==input.context.binding.mainId||binding.deviceId!==input.context.binding.deviceId
    ||binding.workerInstallationId!==input.context.binding.workerInstallationId
    ||request.executionId!==intent.executionId||request.runId!==intent.runId||request.workflowNodeId!==intent.nodeId
    ||request.configuration.id!==placement.payload.agentConfigurationVersionId||request.configuration.agentId!==placement.payload.agentId
    ||request.workingDirectory!==executionPlacement.workingTree.canonicalCwd)unavailable('runtime_source_binding_conflict')
  assertRuntimeLeafPath(request.runtimeDirectory,placement)
  input.context.signal.throwIfAborted()
  const verified=SourceOperationResponseSchema.parse(await input.sources.handle({version:1,operation:'sources.verify',record,
    relativeCwd:executionPlacement.workingTree.cwdAttestation?.relativeCwd??''},input.context))
  if(verified.operation!=='sources.verify'||verified.workTree!==executionPlacement.workingTree.canonicalProjectRoot
    ||verified.canonicalCwd!==request.workingDirectory||verified.directoryIdentityHash!==executionPlacement.workingTree.directoryIdentityHash)unavailable('runtime_source_path_conflict')
  const base=await openPrivateRoot(roots.managedRuntimeRoot)
  let directory=base
  try {
    if(!isDeepStrictEqual(await identity(base),roots.runtimeFilesystem))unavailable('runtime_root_changed')
    const parts=relative(roots.managedRuntimeRoot,request.runtimeDirectory).split('/').filter(Boolean)
    for(const part of parts) {
      input.context.signal.throwIfAborted()
      const child=await openChildDirectory(directory,part,true)
      if(directory!==base)await directory.close()
      directory=child
    }
    const filesystem=await identity(directory)
    const proof=RuntimeLeafAttestationSchema.parse({executionId:intent.executionId,attemptId:intent.attemptId,
      operationId:intent.operationId,bindingHash:executionPlacement.bindingHash,canonicalRuntimeDirectory:request.runtimeDirectory,
      directoryIdentityHash:digest(filesystem),materializationId:record.receipt.materializationId,materializationDigest:executionPlacement.workingTree.materializationDigest})
    const marker=anchored(directory,'.graphql-workflow-runtime.json')
    let created:Awaited<ReturnType<typeof open>>|undefined
    try {created=await open(marker,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)}
    catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='EEXIST'))throw error}
    if(created) {
      try {await created.writeFile(JSON.stringify(proof));await created.sync()} finally {await created.close()}
      await directory.sync()
    } else {
      const file=await open(marker,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
      try {
        const stat=await file.stat()
        if(!stat.isFile()||stat.nlink!==1||stat.size>4096||stat.mode&0o077||stat.uid!==process.getuid?.())unavailable('runtime_leaf_receipt_invalid')
        if(!isDeepStrictEqual(RuntimeLeafAttestationSchema.parse(JSON.parse((await file.readFile()).toString('utf8'))),proof))unavailable('runtime_leaf_owner_conflict')
      } finally {await file.close()}
    }
    if(await realpath(request.runtimeDirectory)!==request.runtimeDirectory)unavailable('runtime_leaf_retargeted')
    const current=await openPrivateRoot(request.runtimeDirectory)
    try {if(!isDeepStrictEqual(await identity(current),filesystem))unavailable('runtime_leaf_changed')}
    finally {await current.close()}
    input.context.signal.throwIfAborted()
    return proof
  } finally {if(directory!==base)await directory.close();await base.close()}
}

type QualificationReader=ReturnType<typeof createInstalledCodexQualificationReader>
type QualificationCapture=Awaited<ReturnType<QualificationReader['capture']>>
export type { CapturedWorkflowMainRequest, InstalledWorkflowNativeOutputContext }
export interface InstalledWorkflowHostOptions {
  stateDirectory:string
  mainNow(): number
  pairing:WorkerPairingConfiguration
  bootId:string
  configuration:InstalledWorkflowConfigurationLocation|null
  /** Current authenticated channel only; a capture belongs permanently to its original generation. */
  currentBinding():Readonly<DeviceSessionBinding>|undefined
  /** When the last ready Main session was lost while the Worker keeps reconnecting; undefined while connected or stopped. */
  linkLostAt?():number|undefined
  captureRequest(namespace:string):CapturedWorkflowMainRequest|undefined
  sources:SourceOperationWorkerService
  approvedRoots():Promise<ApprovedRootAllowlist>
  codexSuiteRevision:string
  accounts?:ProviderAccountResolver
  nativeOutputs?(context: InstalledWorkflowNativeOutputContext): InstalledNativeOutputProviders
  signal:AbortSignal
  /** Explicit installation initialization; absence of an established journal is otherwise recovery-required. */
  initializeNewInstallation?:true
  /** Common worker composition owns these shared original journal/registry instances. */
  journal?():Promise<RemoteOperationJournal>
  registry?:NativeProcessRegistry
}
interface InstalledOperation {
  intent:DispatchIntent
  placement:AcceptedNodePlacement
  context:DeviceExtensionContext
  /** Qualification follows the live link; the admission connection remains a saved fact. */
  readonly connection:DeviceConnectionIdentity
  reader:QualificationReader
  capture:QualificationCapture
  scope:NativeProcessRecovery
  launchReservation?: Promise<void>
  account:ResolvedProviderAccount|null
  host?:RemoteExecutionHost
  manager?:CodexAppServerSessionManager
  launchDisabled?:true
  native?:InstalledWorkflowNativeOwner
  session?:NativeSessionReference
  nativeSignal?:AbortSignal
  nativeStart?:NativeSessionStart
  applicationAccess?:RemoteApplicationAccess
  publications: Map<string, AgentFilePublishResult['value']>
  mcp?:Awaited<ReturnType<typeof createWorkerMcpEndpoint>>
  relay?:Awaited<ReturnType<typeof prepareWorkerApplicationAccess>>
  leaseExpiresAt?:string
  runtimeLeaf?:RuntimeLeafAttestation
  runtimeRoots?:ApprovedRootAllowlist
  retainedHistory?:NativeHistory
  physicalClosure?:NativeLaunchObservation
  reviewTimer?:ReturnType<typeof setTimeout>
  reviewAssignment?:RemoteReviewerRequest
  reviewFailure?:unknown
  preparationRecovery?: true
}
/** A configured extension is code support, not qualified readiness. Every new operation consumes genuine Main facts before opening a journal or allocating a manager. */
export async function createInstalledWorkflowHost(input:InstalledWorkflowHostOptions) {
  input.signal.throwIfAborted()
  const configuration=await readInstalledWorkflowConfiguration(input.configuration)
  if(!configuration)return {kind:'unavailable' as const,reason:'missing_configuration' as const}
  const pairing=WorkerPairingConfigurationSchema.parse(input.pairing)
  if(input.bootId!==bootIdentity()||Date.parse(pairing.expiresAt)<=Date.now())unavailable('installed_identity_unavailable')
  const state=await openPrivateRoot(input.stateDirectory);await state.close()
  return new InstalledWorkflowHostRuntime(input, pairing).configured()
}

class InstalledWorkflowHostRuntime {
  private readonly registry: NativeProcessRegistry
  private readonly lifetime: AbortController
  private readonly signal: AbortSignal
  private readonly payloadFingerprints: PayloadFingerprintCache
  private readonly operations: Map<string, InstalledOperation>
  private readonly hosts: Map<string, RemoteExecutionHost>
  private readonly physical: InstalledWorkflowPhysicalReadouts
  private readonly responsePages: InstalledWorkflowResponsePages
  private readonly recovery: InstalledWorkflowRecovery
  private readonly active: Set<Promise<unknown>>
  private journalOpening: Promise<RemoteOperationJournal> | undefined
  private closing = false
  private shutdown: Promise<void> | undefined
  private readonly operationLocks = new Map<string, Promise<void>>()
  private readonly construction = new Map<string, {
    binding: Readonly<DeviceSessionBinding>
    intent: DispatchIntent
    placement: AcceptedNodePlacement
    task: Promise<RemoteExecutionHost>
    controller: AbortController
  }>()

  constructor(private readonly input: InstalledWorkflowHostOptions,
    private readonly pairing: WorkerPairingConfiguration) {
    this.registry = input.registry ?? new NativeProcessRegistry(join(input.stateDirectory, 'workflow-native-processes'))
    this.lifetime = new AbortController()
    this.signal = AbortSignal.any([input.signal, this.lifetime.signal])
    this.payloadFingerprints = new PayloadFingerprintCache()
    this.operations = new Map<string, InstalledOperation>()
    this.hosts = new Map<string, RemoteExecutionHost>()
    this.physical = new InstalledWorkflowPhysicalReadouts(input.mainNow)
    this.responsePages = new InstalledWorkflowResponsePages()
    this.recovery = new InstalledWorkflowRecovery(join(input.stateDirectory, 'workflow-recovery'), this.registry)
    this.active = new Set<Promise<unknown>>()
  }

  configured() {
    const extensions = this.createExtensions()
    extensions.push(workflowPreparationExtension(extensions[0]!))
    return { kind: 'configured' as const, extensions, nativeOwnerFor: this.nativeOwnerFor,
      preparationClosed: this.preparationClosed, reservationClosed: this.reservationClosed,
      close: this.close, drainForUpdate: this.drainForUpdate }
  }

  private readonly journal = ()=>this.journalOpening??=this.input.journal?this.input.journal():RemoteOperationJournal.open(join(this.input.stateDirectory,'workflow-operations.json'),
    this.input.initializeNewInstallation?{initializeNewInstallation:true}:{})

  private readonly hasRetainedJournal = async () => {
    try {
      const file = await open(join(this.input.stateDirectory, 'workflow-operations.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { return (await file.stat()).isFile() }
      finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /** The original binding stays current over a reconnected session of the same Worker boot and through a bounded
   * link outage; a changed installation, key, authorization or boot is unavailable. */
  private readonly current = (binding:Readonly<DeviceSessionBinding>)=>{
    this.signal.throwIfAborted()
    const live=this.input.currentBinding()
    if(this.closing||!(live?sameDeviceInstallation(live,binding):this.reconnecting())||binding.mainId!==this.pairing.mainId||binding.deviceId!==this.pairing.deviceId
      ||binding.workerInstallationId!==this.pairing.workerInstallationId||binding.keyRevision!==this.pairing.keyRevision
      ||binding.authorizationRevision!==this.pairing.authorizationRevision||binding.bootId!==this.input.bootId)unavailable('authenticated_generation_unavailable')
  }

  /** Main's requests arrive on the live session only; work admitted on an earlier session keeps `current`. */
  private readonly currentIncoming = (binding:Readonly<DeviceSessionBinding>)=>{
    this.current(binding)
    if(!isDeepStrictEqual(this.input.currentBinding(),binding))unavailable('authenticated_generation_unavailable')
  }

  private readonly reconnecting = () => {
    const lostAt = this.input.linkLostAt?.()
    return lostAt !== undefined && Date.now() - lostAt < deviceReconnectTimeoutMs
  }

  /** Requests follow the live Main session of the original Worker boot; a dropped link is awaited (bounded),
   * and only read-only authority checks are sent again after a link drop. */
  private readonly forBinding = (binding:Readonly<DeviceSessionBinding>)=>{
    const captures=new Map<string,CapturedWorkflowMainRequest>()
    const capture = async (namespace: string, signal: AbortSignal) => {
      const live = await waitForDeviceReconnect({ original: binding, signal,
        failure: unavailableError('authenticated_generation_unavailable'),
        live: () => { this.current(binding); return this.input.currentBinding() } })
      let captured=captures.get(namespace)
      if(!captured||!isDeepStrictEqual(captured.binding,live)) {
        captured=this.input.captureRequest(namespace)
        if(!captured||!sameDeviceInstallation(captured.binding,binding))unavailable('main_channel_unavailable')
        captures.set(namespace,captured!)
      }
      return captured!
    }
    return async(namespace:string,payload:unknown,options?:{signal?:AbortSignal;timeoutMs?:number})=>{
      const requestSignal = options?.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal
      const authority = namespace === EXECUTION_AUTHORITY_EXTENSION.namespace
      for (let attempt = 0; ; attempt++) {
        const captured = await capture(namespace, requestSignal)
        const request = () => captured.request(payload, {
          signal: requestSignal, timeoutMs: options?.timeoutMs ?? deviceRequestTimeoutMs,
        })
        try {
          const response = authority ? await retryDeviceRequest(request, { retry: 'idempotent', signal: requestSignal }) : await request()
          this.current(binding)
          return response
        } catch (error) {
          if (!authority || attempt >= 3 || requestSignal.aborted || !isDeviceLinkDrop(error)) throw error
        }
      }
    }
  }

  private readonly operation = (intent:DispatchIntent)=>{
    const owned=this.operations.get(intent.executionId)
    if(!owned||!isDeepStrictEqual(owned.intent,intent))unavailable('original_operation_unavailable')
    return owned!
  }

  private readonly rememberEntry = (resident: InstalledOperation) => {
    if (!resident.scope.launchId) return
    this.recovery.rememberEntry({ version: 1,
      ...(resident.placement.payload.kind === 'agent' && resident.placement.payload.accountBinding
        ? { accountBinding: resident.placement.payload.accountBinding } : {}), intent: resident.intent, connection: resident.connection,
      owner: resident.scope.owner, initialLaunchId: resident.scope.launchId })
  }

  private readonly refreshReviewer = (resident: InstalledOperation): void => {
    if (resident.reviewTimer || this.closing) return
    resident.reviewTimer = setTimeout(() => {
      delete resident.reviewTimer
      const check = (async () => {
        const log = await this.journal()
        const status = await log.status(resident.intent.operationId)
        if (status.status !== 'known' || !status.receipt.retainedReviewer || status.receipt.terminal) return
        try {
          const policy = await workerReviewerAuthorizer(this.forBinding(resident.context.binding))(resident.intent, resident.placement)
          if (!policy) {
            await resident.host!.closeRetainedReviewer(resident.intent.operationId)
            return
          }
          await log.renewReviewer(resident.intent.operationId, policy)
        } catch (error) {
          resident.reviewFailure = error
          if (log.reviewerExpired(status.receipt.retainedReviewer.expiresAt)
            && await resident.host!.closeRetainedReviewer(resident.intent.operationId, { sequence: status.receipt.sequence })) {
            delete resident.reviewFailure
            return
          }
        }
        this.refreshReviewer(resident)
      })()
      this.active.add(check)
      void check.finally(() => this.active.delete(check)).catch(error => {
        resident.reviewFailure = error
        this.refreshReviewer(resident)
      })
    }, 10_000)
    resident.reviewTimer.unref()
  }

  private readonly constructOwned = async(context:DeviceExtensionContext,intent:DispatchIntent,placement:AcceptedNodePlacement,
    action: 'read' | 'stop', signal: AbortSignal, renewal?: RemoteOwnerReconciliation)=>{
    signal.throwIfAborted()
    this.current(context.binding)
    const request=this.forBinding(context.binding),authorize=workerExecutionAuthorizer(request)
    let owned=this.operations.get(intent.executionId)
    if(owned) {
      const renewing = renewal && renewal.operationId === intent.operationId
        && isDeepStrictEqual(renewal.nextOwner, intent.owner)
        && isDeepStrictEqual({ ...owned.intent, owner: renewal.nextOwner }, intent)
      if ((!isDeepStrictEqual(owned.intent, intent) && !renewing) || !isDeepStrictEqual(owned.placement, placement)) {
        unavailable('original_operation_binding_changed')
      }
      if (!owned.native && !owned.preparationRecovery && !isDeepStrictEqual(owned.context.binding, context.binding)
        && sameDeviceInstallation(owned.context.binding, context.binding)) {
        await this.rebindPreparation(owned, context, () => authorize(intent, placement, action))
      }
      if (!isDeepStrictEqual(owned.context.binding, context.binding)) {
        const original = owned.context.binding
        if (original.bootId !== context.binding.bootId || !owned.host || !owned.native || !owned.session) {
          unavailable('original_native_reconnection_unavailable')
        }
        await authorize(intent, placement, action)
        const log = await this.journal()
        let status = await log.status(intent.operationId)
        let observed = matchingOriginalRegistryLaunch(this.registry, owned.native.launch)
        if (observed.lifecycle !== 'active') {
          // Native closure precedes the terminal journal commit. Join the original settlement before rebinding.
          await owned.host.waitForSettlement(intent.operationId, context.signal)
          status = await log.status(intent.operationId)
          observed = matchingOriginalRegistryLaunch(this.registry, owned.native.launch)
        }
        if (status.status !== 'known' || !isDeepStrictEqual(status.receipt.intent, owned.intent)
          || status.receipt.native?.sessionId !== owned.session.nativeSessionId
          || status.receipt.native?.processIdentityDigest !== owned.native.native.processIdentityDigest
          || !isDeepStrictEqual(status.receipt.connection, owned.connection)) {
          unavailable('original_native_reconnection_conflict')
        }
        if (status.receipt.terminal ? !isDeepStrictEqual(observed, owned.physicalClosure) : observed.lifecycle !== 'active') {
          unavailable('original_native_reconnection_process_changed')
        }
        this.current(context.binding)
        if (!isDeepStrictEqual(owned.context.binding, original)) unavailable('original_operation_generation_changed')
        this.physical.purge(intent.operationId)
        owned.context = context
      }
      if (owned.host) return owned.host
    } else {
      if(this.operations.size>=1000)unavailable('operation_retention_full')
      const harness = placement.payload.kind === 'agent' ? placement.payload.driverId : undefined
      if (harness !== 'codex') unavailable('installed_harness_selection_missing')
      const binding = placement.payload.kind === 'agent' ? placement.payload.accountBinding : undefined
      assertWorkerProviderAccountBinding(binding, context.binding)
      const account = await resolveRuntimeProviderAccount(this.input.accounts, 'codex', undefined,
        this.registry.scope(`execution:${intent.executionId}`), undefined, binding)
      const environment = account ? managedProviderEnvironment(process.env, account, 'codex') : process.env
      const suiteRevision = this.input.codexSuiteRevision
      const readerInput: Parameters<typeof createInstalledCodexQualificationReader>[0] = {intent,placement,signal: this.signal,
        trustedCurrentBinding:()=>this.input.currentBinding()??null,
        trustedCurrentIntent: () => this.operations.get(intent.executionId)?.intent ?? intent,
        inspect: (binding, effectSignal) => {
          const inspectionInput = { binding, configuration: this.input.configuration,
            environment, cwd: this.input.stateDirectory, signal: effectSignal,
            fingerprintCache: this.payloadFingerprints }
          return inspectInstalledCodex(inspectionInput)
        },
        readFacts: signal => {
          const resident = this.operations.get(intent.executionId)
          return workerExecutionFactsReader(this.forBinding(resident?.context.binding ?? context.binding))(
            resident?.intent ?? intent, placement, signal)
        },
        assertResident: async (original, binding, signal) => {
          const selected = this.operations.get(intent.executionId)
          if (!selected) unavailable('original_resident_requalification_missing')
          const resident = selected!
          if (!resident.manager || !resident.native || !resident.session || !resident.host
            || !isDeepStrictEqual(resident.context.binding, binding)) unavailable('original_resident_requalification_missing')
          const assertOriginal = async () => {
            this.current(binding)
            const state = await(await this.journal()).status(intent.operationId)
            if (state.status !== 'known' || state.receipt.terminal
              || state.receipt.native?.sessionId !== resident.session?.nativeSessionId
              || state.receipt.native?.processIdentityDigest !== resident.native?.native.processIdentityDigest
              || !isDeepStrictEqual(state.receipt.connection, connectionIdentity(original))
              || matchingOriginalRegistryLaunch(this.registry, resident.native!.launch).lifecycle !== 'active') {
              unavailable('original_resident_requalification_changed')
            }
          }
          await assertOriginal()
          await workerExecutionAuthorizer(this.forBinding(binding))(resident.intent, placement, 'read', signal)
          await assertOriginal()
        }, suiteRevision }
      const reader = createInstalledCodexQualificationReader(readerInput)
      const capture=await reader.capture(signal)
      signal.throwIfAborted()
      const savedHarness = capture.facts.configuration.harness
      if (savedHarness.harness === 'codex' && savedHarness.accountId
        && savedHarness.accountId !== account?.accountId) unavailable('accepted_account_binding_missing')
      this.current(context.binding)
      if(this.operations.size>=1000)unavailable('operation_retention_full')
      owned={intent:structuredClone(intent),placement:structuredClone(placement),context,
        connection:connectionIdentity(context.binding),reader,capture,
        scope:this.registry.scope(`execution:${intent.executionId}`),account,publications:new Map()}
      this.operations.set(intent.executionId,owned)
    }
    const generation=commandInputHash(context.binding)
    let host=this.hosts.get(generation)
    if(!host) {
      const log=await this.journal();this.current(context.binding)
      // Other executions may publish this generation's host while the journal opens.
      host = this.hosts.get(generation)
      if (host) {
        owned.host = host
        return host
      }
      host = this.createExecutionHost(context, log)
      this.hosts.set(generation,host)
    }
    owned.host = host
    return host
  }

  private async reserveResidentLaunch(resident: InstalledOperation): Promise<void> {
    if (resident.launchDisabled || this.closing) unavailable('original_native_owner_closed')
    if (!resident.scope.launchId) {
      resident.launchReservation ??= this.registry.reserveLaunch(resident.scope.owner).then(scope => {
        Object.assign(resident.scope, scope)
        this.rememberEntry(resident)
      })
      await resident.launchReservation
    }
    if (resident.launchDisabled || this.closing) unavailable('original_native_owner_closed')
  }

  private createManager(configurationContext: NativeManagerResolutionContext, log: RemoteOperationJournal) {
    const resident=this.operations.get(configurationContext.executionId)
    if(!resident||configurationContext.harness !== 'codex'||!isDeepStrictEqual(configurationContext.configuration,resident.capture.facts.configuration)
      ||configurationContext.workingDirectory!==resident.capture.facts.executionPlacement.workingTree.canonicalCwd)unavailable('accepted_configuration_conflict')
    const actual=resident!,binary=actual.capture.inspection.currentTarget?.installation.launcher.resolvedLauncher
    if(!binary)unavailable('installed_launcher_unavailable')
    const instances=new HarnessInstanceRegistry(localHarnessDrivers.filter(driver=>driver.driverId===configurationContext.harness))
    const override=actual.capture.facts.harness.override,installation=actual.capture.facts.harness.installation
    instances.reload([{instanceId:override.instanceId,instanceRevision:override.instanceRevision,driverId:override.driverId,enabled:override.enabled,configuration:override.configuration}])
    const payloadFingerprints=installation.launcher.payloadFingerprints
    if(!payloadFingerprints?.length)unavailable('launcher_payload_evidence_missing')
    const installations=new HarnessInstallationRegistry(instances);installations.refresh([{...installation,launcher:{...installation.launcher,payloadFingerprints}}])
    const selection=installations.pin({instanceId:override.instanceId,hostRef:override.target.hostRef,
      harnessInstallationId:override.target.harnessInstallationId,connectionGeneration:installation.connectionGeneration,environmentGeneration:installation.environmentGeneration})
    const before=async()=>{if(actual.launchDisabled||this.closing)unavailable('original_native_owner_closed');
      if (actual.reviewAssignment) {
        await workerReviewerAuthorizer(this.forBinding(actual.context.binding))(actual.intent, actual.placement, actual.reviewAssignment)
      } else await workerExecutionAuthorizer(this.forBinding(actual.context.binding))(actual.intent,actual.placement,'start')
      await this.reserveResidentLaunch(actual)
      installations.assertCurrent(selection)}
    const outputContext: InstalledWorkflowNativeOutputContext = {
      get intent() { return structuredClone(actual.intent) },
      placement: structuredClone(actual.placement),
      get binding() { return Object.freeze(structuredClone(actual.context.binding)) },
      materialization: structuredClone(actual.capture.facts.executionPlacement.materialization),
      applicationAccess: () => {
        if (!actual.applicationAccess || actual.launchDisabled || this.closing) unavailable('original_main_lease_required')
        return structuredClone(actual.applicationAccess!)
      },
      publicationCompleted: (raw, reply) => {
        const publication = AgentFilePublishInputSchema.parse(raw)
        const result = AgentFilePublishResultSchema.parse(reply)
        const chat = publication.scope.chat
        if (actual.launchDisabled || this.closing || chat.kind !== 'agent' || chat.runId !== actual.intent.runId
          || chat.executionId !== actual.intent.executionId
          || !isDeepStrictEqual(result.value.file.scope, publication.scope)) unavailable('original_artifact_publication_conflict')
        const previous = actual.publications.get(publication.commandId)
        if (previous && !isDeepStrictEqual(previous, result.value)) unavailable('original_artifact_publication_conflict')
        actual.publications.set(publication.commandId, structuredClone(result.value))
      },
      assertCurrent: async (pin, effectSignal) => {
        effectSignal?.throwIfAborted(); this.current(actual.context.binding)
        if (actual.native) {
          await workerExecutionAuthorizer(this.forBinding(actual.context.binding))(actual.intent,actual.placement,'read')
          installations.assertCurrent(selection)
        } else {
          await before()
        }
        effectSignal?.throwIfAborted(); this.current(actual.context.binding)
        if (this.operations.get(actual.intent.executionId) !== actual) unavailable('original_native_owner_closed')
        if (pin) {
          pin.assertCurrent()
          const native = actual.native
          if (!native || !actual.session || !isDeepStrictEqual(actual.session, pin.session)) unavailable('original_native_owner_missing')
          const observed = matchingOriginalRegistryLaunch(this.registry, native!.launch)
          if (observed.lifecycle !== 'active' || !isDeepStrictEqual(observed.guardian, native!.launch.guardian)
            || !isDeepStrictEqual(observed.provider, native!.launch.provider)
            || !isDeepStrictEqual(observed.boundary, native!.launch.boundary)) unavailable('original_native_process_changed')
          const status = await log.status(actual.intent.operationId)
          if (status.status !== 'known' || status.receipt.stopFence || status.receipt.terminal
            || status.receipt.native?.sessionId !== pin.session.nativeSessionId
            || status.receipt.native?.turnId !== pin.nativeTurnId
            || status.receipt.native?.processIdentityDigest !== native!.native.processIdentityDigest) unavailable('original_native_ack_missing')
          pin.assertCurrent(); effectSignal?.throwIfAborted(); this.current(actual.context.binding)
        }
      },
    }
    const dependencies=createInstalledCodexDependencies({reader:actual.reader,codexSuiteRevision:this.input.codexSuiteRevision})
    const declared = actual.placement.payload.kind === 'agent' && actual.placement.payload.artifactOutputs
    const outputPorts = declared ? (this.input.nativeOutputs
      ? this.input.nativeOutputs(outputContext)
      : createInstalledWorkflowNativeOutputProviders({ stateDirectory: this.input.stateDirectory,
        context: outputContext, registry: this.registry, captureRequest: this.input.captureRequest,
        qualification: { qualify: dependencies.qualify, command: dependencies.runCommand } })) : undefined
    if (outputPorts && (!isDeepStrictEqual(outputPorts.artifacts.binding.intent, actual.intent)
      || !isDeepStrictEqual(outputPorts.artifacts.binding.placement, actual.placement)
      || outputPorts.artifacts.binding.root.rootId !== outputContext.materialization.receipt.binding.rootId
      || outputPorts.artifacts.binding.root.rootBindingRevision !== outputContext.materialization.receipt.binding.bindingRevision)) unavailable('original_native_output_binding_conflict')
    const nativeOutputs = outputPorts && createInstalledNativeOutputs({ ...outputPorts,
      assertCurrent: async effectSignal => { await outputContext.assertCurrent(undefined, effectSignal); await outputPorts.assertCurrent(effectSignal) },
      storage: (prepared, pin) => {
        const storage = outputPorts.storage(prepared, pin)
        if (!('binding' in storage.owner)
          || !isDeepStrictEqual(storage.owner.binding, actual.context.binding)) unavailable('original_native_output_connection_conflict')
        return storage
      },
      authorize: async (pin, operation, effectSignal) => {
        await outputContext.assertCurrent(pin, effectSignal)
        const scope = await outputPorts.authorize(pin, operation, effectSignal)
        await outputContext.assertCurrent(pin, effectSignal)
        return scope
      },
    })
    const manager=new CodexAppServerSessionManager(binary,undefined,undefined,actual.scope,'scoped',undefined,{...dependencies,
      environment: (variables, scopedNames) => {
        const source = safeEnvironment(variables, scopedNames)
        return actual.account ? managedProviderEnvironment(source, actual.account, 'codex') : source
      },
      qualify:async(binary,cwd,environment,authenticated,effectSignal)=>{
        await before()
        const result=await dependencies.qualify(binary,cwd,environment,authenticated,effectSignal,actual.scope)
        if(normalizeHarnessVersion(result.providerVersion)!==actual.capture.qualification.version)unavailable('native_version_changed')
        return result
      },
      assertUnchanged:async value=>{await before();await dependencies.assertUnchanged(value)},
      runCommand:async(binary,args,cwd,effectSignal,environment,options)=>{await before();return dependencies.runCommand(binary,args,cwd,effectSignal,environment,{...options,recovery:actual.scope})},
      qualifyModel: async (configuration, binary, cwd, environment, effectSignal, _recovery, inspection) => {
        await before()
        return dependencies.qualifyModel(configuration, binary, cwd, environment,
          effectSignal, actual.scope, inspection)
      },
    },{workingDirectory:configurationContext.workingDirectory},nativeOutputs)
    actual.manager=manager
    return manager
  }

  private createExecutionHost(context: DeviceExtensionContext, log: RemoteOperationJournal) {
    const managers = new ExecutionScopedNativeSessionManagerResolver(configurationContext =>
      this.createManager(configurationContext, log))
    return new RemoteExecutionHost({journal:log,connection:DeviceConnectionIdentitySchema.parse({mainId:context.binding.mainId,deviceId:context.binding.deviceId,
      workerInstallationId:context.binding.workerInstallationId,keyRevision:context.binding.keyRevision,authorizationRevision:context.binding.authorizationRevision,
      bootId:context.binding.bootId,connectionGeneration:context.binding.connectionGeneration}),incarnationId:randomUUID(),managers,
      authorize:async(intent,placement,action,signal)=>{const resident=this.operations.get(intent.executionId)
        if (!resident || !isDeepStrictEqual({ ...resident.intent, owner: intent.owner }, intent)) {
          unavailable('original_operation_binding_changed')
        }
        await workerExecutionAuthorizer(this.forBinding(resident.context.binding))(intent,placement,action,signal)
        if(action==='start')this.operation(intent).capture=await this.operation(intent).reader.capture(signal)},
      verifyOwnerRenewal: async (transition, receipt) => {
        const resident = this.operation(receipt.intent)
        if (!resident.native || !resident.session || !isDeepStrictEqual(transition.native, receipt.native)
          || transition.operationId !== receipt.intent.operationId
          || matchingOriginalRegistryLaunch(this.registry, resident.native.launch).lifecycle !== 'active') {
          unavailable('original_native_owner_renewal_changed')
        }
        const next = { ...receipt.intent, owner: transition.nextOwner }
        await workerExecutionAuthorizer(this.forBinding(resident.context.binding))(next, resident.placement, 'control')
        this.current(resident.context.binding)
        const currentState = await log.status(receipt.intent.operationId)
        if (currentState.status !== 'known' || !isDeepStrictEqual(currentState.receipt, receipt)) {
          unavailable('original_native_owner_renewal_changed')
        }
        resident.intent = structuredClone(next)
      },
      authorizeReview: async (intent, placement, review) => {
        const resident = this.operation(intent)
        this.current(resident.context.binding)
        const policy = await workerReviewerAuthorizer(this.forBinding(resident.context.binding))(intent, placement, review)
        if (!policy || policy.agentId !== review.reviewerAgentId) unavailable('original_review_assignment_denied')
        await log.renewReviewer(intent.operationId, policy!)
        resident.reviewAssignment = structuredClone(review)
      },
      attestRuntimeLeaf:async(intent,placement,request,executionPlacement,signal)=>{
        const resident=this.operation(intent),capture=await resident.reader.capture(signal)
        if(!executionPlacement||executionPlacement.bindingHash!==capture.facts.executionPlacement.bindingHash
          ||!isDeepStrictEqual(request.configuration,capture.facts.configuration))unavailable('actual_native_placement_required')
        resident.capture=capture
        const approvedRoots = ApprovedRootAllowlistSchema.parse(await this.input.approvedRoots())
        const runtimeLeaf=await attestInstalledWorkflowRuntimeLeaf({sources:this.input.sources,context:{...context,signal: signal ?? this.signal},approvedRoots,
          nativePlacement:capture.facts.executionPlacement,intent,placement,request})
        resident.runtimeLeaf=runtimeLeaf
        resident.runtimeRoots=structuredClone(approvedRoots)
        await this.reserveResidentLaunch(resident)
        return runtimeLeaf
      },
      preflight: async (nativeRequest, access, signal) => {
        const log = componentLogger('harness')
        let launcher: string | undefined
        try {
          launcher = appLauncherPath()
          log.info({ executionId: nativeRequest.executionId, launcher }, 'Preparing worker workflow MCP route')
          const resident = this.operations.get(nativeRequest.executionId)
          if (!resident || !access) unavailable('original_main_lease_required')
          const actual = resident!
          await workerExecutionAuthorizer(this.forBinding(actual.context.binding))(actual.intent, actual.placement, 'start', signal)
          actual.capture = await actual.reader.capture(signal)
          if (!isDeepStrictEqual(nativeRequest.configuration, actual.capture.facts.configuration)) {
            unavailable('accepted_configuration_conflict')
          }
          const relay = await prepareWorkerApplicationAccess({ request: async (namespace, payload, options) =>
            this.forBinding(actual.context.binding)(namespace, payload, options) }, actual.intent, actual.placement,
          access, signal, { currentIntent: () => actual.intent })
          const nativeStart: NativeSessionStart = { request: structuredClone(nativeRequest),
            correlationId: `execution:${actual.intent.executionId}`, environment: relay.environment }
          if (actual.nativeStart && !isDeepStrictEqual(actual.nativeStart, nativeStart)) {
            unavailable('original_native_start_changed')
          }
          // Native MCP inspection accepts the managed launcher, which reads routes beside itself.
          if (!actual.mcp) actual.mcp = await createWorkerMcpEndpoint({ relay, launcher, signal, now: this.input.mainNow })
          else await actual.mcp.bindRelay(relay)
          actual.applicationAccess = structuredClone(access)
          actual.relay = relay
          actual.leaseExpiresAt = relay.expiresAt
          actual.nativeStart ??= nativeStart
          this.rememberEntry(actual)
          return relay.environment
        } catch (error) {
          log.error({ executionId: nativeRequest.executionId, launcher,
            code: error instanceof Error && 'code' in error ? error.code : undefined,
            errorType: error instanceof Error ? error.name : typeof error }, 'Worker workflow MCP preparation failed')
          throw error
        }
      },
      nativeEvidence:async(intent,session,nativeContext)=>{const resident=this.operation(intent)
        if(!resident.manager||!nativeContext||nativeContext.manager!==resident.manager
          ||nativeContext.request.executionId!==intent.executionId)unavailable('native_manager_not_allocated')
        resident.session=structuredClone(session);resident.nativeSignal=nativeContext.signal
        const state = await log.status(intent.operationId)
        const originalCapture = state.status === 'known' && state.receipt.native ? this.recovery.read(state.receipt) : undefined
        const captured = captureInstalledWorkflowNativeOwner(this.registry,
          originalCapture?.connection ?? resident.connection,
          originalCapture?.intent ?? intent, session)
        if (resident.native && !isDeepStrictEqual(resident.native, captured)) unavailable('original_native_process_changed')
        resident.native ??= captured
        if(!resident.nativeStart)unavailable('original_native_start_missing')
        const assertOwnerCurrent = () => {
          nativeContext.signal.throwIfAborted();this.current(resident.context.binding)
          if(this.operations.get(intent.executionId)!==resident||resident.launchDisabled)unavailable('original_native_owner_closed')
          const observed=matchingOriginalRegistryLaunch(this.registry,captured.launch)
          if(observed.lifecycle!=='active'||!isDeepStrictEqual(observed.guardian,captured.launch.guardian)
            ||!isDeepStrictEqual(observed.provider,captured.launch.provider)||!isDeepStrictEqual(observed.boundary,captured.launch.boundary))unavailable('original_native_process_changed')
        }
        const lifetime = captureOriginalCodexSession(resident.manager, session, resident.nativeStart!, assertOwnerCurrent)
        assertOwnerCurrent()
        if(!lifetime)unavailable('original_native_residency_unavailable')
        lifetime!.assertCurrent()
        if (!resident.runtimeLeaf) unavailable('original_runtime_leaf_missing')
        this.recovery.remember({ version: 1,
          ...(resident.placement.payload.kind === 'agent' && resident.placement.payload.accountBinding
            ? { accountBinding: resident.placement.payload.accountBinding } : {}),
          intent: originalCapture?.intent ?? resident.intent,
          connection: originalCapture?.connection ?? resident.connection, native: resident.native.native,
          session: resident.session, launch: RemoteWorkflowPhysicalReadoutSchema.shape.launch.parse(resident.native.launch),
          runtimeLeaf: resident.runtimeLeaf!, approvedRoots: ApprovedRootAllowlistSchema.parse(resident.runtimeRoots),
          source: RemoteWorkflowPhysicalReadoutSchema.shape.source.parse({
            record: resident.capture.facts.executionPlacement.materialization,
            workingTree: resident.capture.facts.executionPlacement.workingTree }) })
        return resident.native.native
      },
      settle:async(intent,history,owner)=>{
        const resident=this.operation(intent)
        if(!resident.native||resident.manager!==owner.manager)unavailable('original_native_owner_required')
        resident.retainedHistory=structuredClone(history)
        const state=await log.status(intent.operationId)
        const declaration = resident.placement.payload.kind === 'agent' ? resident.placement.payload.artifactOutputs : undefined
        const reviewer = state.status === 'known' && !state.receipt.stopFence
          && (resident.capture.facts.configuration.productRole === 'master' || resident.capture.facts.configuration.productRole === 'orchestrator')
          && history.terminalTurn?.result.outcome === 'succeeded'
          ? await workerReviewerAuthorizer(this.forBinding(resident.context.binding))(intent, resident.placement) : undefined
        if(!reviewer&&state.status==='known'&&(state.receipt.stopFence||history.terminalTurn!==undefined&&history.terminalTurn.correlationId===state.receipt.turnInput?.correlationId
          &&history.terminalTurn.providerId===state.receipt.native?.turnId))resident.launchDisabled=true
        const terminal=await settleInstalledWorkflowNativeOwner({journal:log,registry: this.registry,intent,history,captured:resident.native,
          manager:owner.manager,session:owner.session,publications:resident.publications,
          ...(declaration ? { artifactOutputs: declaration } : {}),
          ...(reviewer ? { retainReviewer: reviewer } : {})})
        if(terminal) {
          if (resident.reviewTimer) clearTimeout(resident.reviewTimer)
          const observation=matchingOriginalRegistryLaunch(this.registry,resident.native.launch)
          if(observation.lifecycle!=='closed'||observation.closureEvidence!=='cgroup_v2_empty')unavailable('original_physical_closure_missing')
          if (terminal.result) {
            await this.recovery.rememberOutput(intent.operationId, remoteWorkflowPhysicalOutput(
              terminal.result, declaration, terminal.artifactValidationError,
            ))
          }
          resident.physicalClosure=observation
          componentLogger('engine').info({ executionId: intent.executionId }, 'Original workflow owner settled')
          await resident.mcp?.close()
        }
        if (reviewer) this.refreshReviewer(resident)
        return terminal
      },
    })
  }

  private readonly construct = async (context:DeviceExtensionContext,intent:DispatchIntent,placement:AcceptedNodePlacement,
    action:'read'|'stop', renewal?: RemoteOwnerReconciliation): Promise<RemoteExecutionHost> => {
    context.signal.throwIfAborted()
    this.current(context.binding)
    const pending = this.construction.get(intent.executionId)
    if (pending) {
      if (!isDeepStrictEqual(pending.intent,intent) || !isDeepStrictEqual(pending.placement,placement)) {
        unavailable('original_operation_generation_changed')
      }
      if (isDeepStrictEqual(pending.binding,context.binding)) return pending.task
      if (pending.binding.bootId !== context.binding.bootId
        || pending.binding.connectionGeneration === context.binding.connectionGeneration)
        unavailable('original_operation_generation_changed')
      await Promise.allSettled([pending.task])
      this.current(context.binding)
      return this.construct(context,intent,placement,action,renewal)
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([this.signal, context.signal, controller.signal])
    const task = this.withOperationLock(intent.executionId,
      () => this.constructOwned(context,intent,placement,action,signal,renewal))
    this.construction.set(intent.executionId, {
      binding: structuredClone(context.binding),
      intent: structuredClone(intent),
      placement: structuredClone(placement),
      task, controller,
    })
    void task.then(() => this.construction.delete(intent.executionId), () => this.construction.delete(intent.executionId))
    return task
  }

  private async stopInitialConstruction(frame: RemoteExecutionRpcRequest, context: DeviceExtensionContext) {
    if (frame.method !== 'control' || frame.command.action.kind !== 'stop'
      || this.operations.has(frame.intent.executionId)) return undefined
    const pending = this.construction.get(frame.intent.executionId)
    if (!pending) return undefined
    if (!isDeepStrictEqual(pending.intent, frame.intent) || !isDeepStrictEqual(pending.placement, frame.placement)
      || !isDeepStrictEqual(pending.binding, context.binding)) unavailable('original_operation_generation_changed')
    const authorize = workerExecutionAuthorizer(this.forBinding(context.binding))
    await authorize(frame.intent, frame.placement, 'stop', context.signal)
    this.current(context.binding)
    const log = await this.journal()
    await log.accept(frame.intent, connectionIdentity(context.binding), randomUUID())
    await log.control(frame.command)
    pending.controller.abort(new Error('Original workflow construction stopped.'))
    await Promise.allSettled([pending.task])
    // Construction may have finished while Stop was admitted; its resident uses the ordinary cleanup path.
    if (this.operations.has(frame.intent.executionId)) return undefined
    return this.withOperationLock(frame.intent.executionId, async () => {
      if (this.operations.has(frame.intent.executionId) || this.construction.has(frame.intent.executionId)) return undefined
      return recoverInstalledWorkflowReply({ frame, binding: context.binding, journal: log,
        recovery: this.recovery, registry: this.registry, physical: this.physical,
        signal: context.signal, lifetimeSignal: this.signal, assertCurrent: () => this.current(context.binding),
        authorize: async action => { await authorize(frame.intent, frame.placement, action, context.signal) } })
    })
  }

  private async withOperationLock<T>(executionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.operationLocks.get(executionId)
    let release!: () => void
    const lock = new Promise<void>(resolve => { release = resolve })
    this.operationLocks.set(executionId, lock)
    try {
      await previous
      return await work()
    } finally {
      release()
      if (this.operationLocks.get(executionId) === lock) this.operationLocks.delete(executionId)
    }
  }

  private recoverUnowned(frame: RemoteExecutionRpcRequest, context: DeviceExtensionContext) {
    return this.withOperationLock(frame.intent.executionId, async () => {
      // Journal reads can outlive construction; only an unowned operation needs cold recovery.
      const resident = this.operations.get(frame.intent.executionId)
      if (this.construction.has(frame.intent.executionId) || resident && !resident.preparationRecovery) return undefined
      return recoverInstalledWorkflowReply({ frame, binding: context.binding,
        journal: await this.journal(), recovery: this.recovery, registry: this.registry, physical: this.physical,
        signal: context.signal, lifetimeSignal: this.signal, assertCurrent: () => this.current(context.binding),
        authorize: async action => {
          await workerExecutionAuthorizer(this.forBinding(context.binding))(frame.intent, frame.placement, action)
        } })
    })
  }

  /** A preparation keeps its original host and journal entry when only the transport session changed. */
  private readonly rebindPreparation = async (owned: InstalledOperation, context: DeviceExtensionContext,
    authorize: () => Promise<unknown>) => {
    const original = owned.context.binding
    await authorize()
    this.current(context.binding)
    if (!isDeepStrictEqual(owned.context.binding, original)) unavailable('original_operation_generation_changed')
    owned.context = context
  }

  private readonly closeResidentPreparation = async (resident: InstalledOperation, reason: string) => {
    componentLogger('engine').warn({ executionId: resident.intent.executionId, reason,
      native: Boolean(resident.native), session: Boolean(resident.session) }, 'Closing original workflow preparation')
    resident.launchDisabled = true
    resident.preparationRecovery = true
    await resident.host?.abortPreparation(resident.intent.operationId)
    await resident.manager?.dispose?.()
    if (resident.scope.launchId) await this.registry.abandonReservedLaunch(resident.scope)
    const log = await this.journal()
    const state = await log.status(resident.intent.operationId)
    const receipt = state.status === 'known' ? state.receipt
      : await log.accept(resident.intent, resident.connection, randomUUID())
    if (receipt.native) {
      await this.recovery.reconcile(receipt, log, this.signal)
    } else if (receipt.entryAttempted) {
      await this.recovery.closePendingEntry(receipt, log, this.signal)
    } else {
      if (resident.scope.launchId && !await this.registry.closeOwner(resident.scope.owner, this.signal)) {
        unavailable('native_owner_closure_unconfirmed')
      }
      await log.revokeFence(receipt.intent.operationId)
      if (!receipt.terminal) await log.terminal(receipt.intent.operationId, { kind: 'not_started',
        closureEvidenceDigest: remoteNonEntryClosureDigest(receipt.intent) })
    }
    await resident.mcp?.close()
  }

  private readonly releaseSettled = async (intent: DispatchIntent) => {
    for (const host of this.hosts.values()) await host.retireSettled(intent.operationId)
    this.operations.delete(intent.executionId)
    this.physical.purge(intent.operationId)
  }

  private readonly retiredReply = async (frame: RemoteExecutionRpcRequest,
    context: DeviceExtensionContext, log: RemoteOperationJournal) => {
    this.current(context.binding)
    const placement = readPlacement(frame.placement)
    const status = await log.status(frame.intent.operationId)
    if (status.status !== 'known' || !isDeepStrictEqual(status.receipt.intent, frame.intent)
      || placement.bindingHash !== frame.intent.bindingHash || placement.hostRef.kind !== 'device'
      || placement.hostRef.deviceId !== context.binding.deviceId || placement.mainId !== context.binding.mainId
      || status.receipt.connection.workerInstallationId !== context.binding.workerInstallationId) {
      unavailable('retired_operation_ownership_changed')
    }
    if (frame.method === 'control' && (frame.command.operationId !== frame.intent.operationId
      || frame.command.attemptId !== frame.intent.attemptId || frame.command.executionId !== frame.intent.executionId
      || frame.command.bindingHash !== frame.intent.bindingHash || !isDeepStrictEqual(frame.command.owner, frame.intent.owner))) {
      unavailable('retired_control_ownership_changed')
    }
    let action: 'start' | 'read' | 'control' = 'read'
    if (frame.method === 'control') action = 'control'
    else if (frame.method === 'prepare' || frame.method === 'start-turn') action = 'start'
    await workerExecutionAuthorizer(this.forBinding(context.binding))(frame.intent, placement, action)
    this.current(context.binding)
    if (frame.method === 'status' || frame.method === 'physical-readout') {
      const recovered = await recoverInstalledWorkflowReply({ frame, binding: context.binding,
        journal: log, recovery: this.recovery, registry: this.registry, physical: this.physical, signal: context.signal, lifetimeSignal: this.signal,
        assertCurrent: () => this.current(context.binding),
        authorize: async action => {
          await workerExecutionAuthorizer(this.forBinding(context.binding))(frame.intent, placement, action)
        } })
      if (recovered) return recovered
    }
    await this.releaseSettled(frame.intent)
    if (frame.method === 'status') return { payload: status }
    if (frame.method === 'control-delivery') {
      if (frame.command.operationId !== frame.intent.operationId || frame.command.executionId !== frame.intent.executionId
        || frame.command.attemptId !== frame.intent.attemptId || frame.command.bindingHash !== frame.intent.bindingHash
        || !isDeepStrictEqual(frame.command.owner, frame.intent.owner)
          && !status.receipt.controls.some(command => isDeepStrictEqual(command, frame.command))) {
        unavailable('retired_control_ownership_changed')
      }
      return { payload: { phase: await log.controlDelivery(frame.command) ?? 'unknown', status } }
    }
    if (frame.method === 'control') {
      await log.control(frame.command)
      return { payload: status }
    }
    if (frame.method === 'physical-ack') return { payload: { version: 1, operationId: frame.intent.operationId,
      receiptSequence: frame.receiptSequence, sourceDigest: frame.sourceDigest, status: 'not_retained' } }
    unavailable('original_operation_retired')
  }

  private readonly nativeOwnerFor = async(record:SourceMaterializationRecord):Promise<SourceInstalledNativeOwner|null>=>{
    const owned=this.operations.get(record.receipt.executionId)
    if(!owned?.native||!owned.session||!owned.nativeSignal||!owned.applicationAccess||owned.launchDisabled||owned.nativeSignal.aborted
      ||record.receipt.attemptId!==owned.intent.attemptId||record.operationId!==owned.intent.operationId
      ||record.receipt.materializationId!==owned.capture.facts.executionPlacement.materialization.receipt.materializationId
      ||record.finalDispatchBindingHash!==owned.capture.facts.executionPlacement.bindingHash
      ||sourceMaterializationDigest(record)!==sourceMaterializationDigest(owned.capture.facts.executionPlacement.materialization))return null
    const native=owned.native,session=owned.session,nativeSignal=AbortSignal.any([this.signal,owned.nativeSignal])
    const request: ReturnType<InstalledWorkflowHostRuntime['forBinding']> = (namespace,payload,options)=>
      this.forBinding(owned.context.binding)(namespace,payload,options)
    const authorize=workerExecutionAuthorizer(request)
    const assertCurrent=async()=>{
      nativeSignal.throwIfAborted();this.current(owned.context.binding)
      if(this.operations.get(owned.intent.executionId)!==owned||owned.launchDisabled)unavailable('original_source_native_owner_closed')
      const observed=matchingOriginalRegistryLaunch(this.registry,native.launch)
      if(observed.lifecycle!=='active')unavailable('original_source_native_owner_changed')
      await authorize(owned.intent,owned.placement,'read')
      await prepareWorkerApplicationAccess({request},owned.intent,owned.placement,owned.applicationAccess!,nativeSignal)
      const logged=await(await this.journal()).status(owned.intent.operationId)
      if(logged.status!=='known'||logged.receipt.terminal||logged.receipt.native?.sessionId!==session.nativeSessionId
        ||logged.receipt.native.processIdentityDigest!==native.native.processIdentityDigest)unavailable('original_source_native_owner_changed')
      nativeSignal.throwIfAborted();this.current(owned.context.binding)
    }
    await assertCurrent()
    return {executionId:owned.intent.executionId,runId:owned.intent.runId,technicalAttempt:owned.intent.technicalAttempt,
      attemptId:owned.intent.attemptId,operationId:owned.intent.operationId,
      materializationId:record.receipt.materializationId,sourceBindingHash:record.sourceBindingHash,finalDispatchBindingHash:owned.capture.facts.executionPlacement.bindingHash,
      session:structuredClone(session),owner:structuredClone(owned.intent.owner),signal:nativeSignal,assertCurrent}
  }

  private readonly close = ()=>this.shutdown??=(async()=>{
    this.closing=true;this.lifetime.abort(new Error('Installed workflow host is closing.'))
    for (const resident of this.operations.values()) if (resident.reviewTimer) clearTimeout(resident.reviewTimer)
    this.physical.clear()
    this.responsePages.clear()
    const results=await Promise.allSettled([...this.hosts.values()].map(host=>host.shutdown()))
    await Promise.allSettled([...this.active])
    const failures:unknown[]=results.flatMap(result=>result.status==='rejected'?[result.reason]:[])
    for(const owned of this.operations.values()) {
      try {
        await owned.launchReservation
        if(owned.scope.launchId) {
          await this.registry.abandonReservedLaunch(owned.scope)
          if(!await this.registry.closeOwner(owned.scope.owner))unavailable('native_owner_closure_unconfirmed')
        }
        await owned.mcp?.close()
      } catch(error){failures.push(error)}
    }
    if(failures.length)throw new AggregateError(failures,'Original installed workflow cleanup remains unconfirmed; the journal owner is retained.')
    if(this.journalOpening&&!this.input.journal)await(await this.journalOpening).close()
  })()

  private readonly preparationClosed = async (owner: SourceOperationOwner): Promise<boolean> => {
    if (owner.preparationKind !== 'workflow' || owner.preparationClosed !== true) return false
    // A failed fact lookup may still leave an owner that needs cleanup.
    const pending = this.construction.get(owner.attempt.executionId)
    if (pending) await Promise.allSettled([pending.task])
    const owned = this.operations.get(owner.attempt.executionId)
    const log = await this.journal()
    const status = await log.status(owner.identity.operationId)
    const processOwner = `execution:${owner.attempt.executionId}`
    const launches = () => this.registry.snapshot().launches.filter(launch => launch.owner === processOwner)
    if (status.status === 'unknown') {
      const entry = this.recovery.readEntry(owner.identity.operationId)
      if (!entry) return !owned && launches().length === 0
      if (entry.intent.executionId !== owner.attempt.executionId || entry.intent.attemptId !== owner.attempt.attemptId
        || owner.preparationNativeSession) return false
      if (owned) {
        owned.launchDisabled = true
        await owned.manager?.dispose?.()
        await this.registry.abandonReservedLaunch(owned.scope)
      }
      if (!await this.registry.closeOwner(entry.owner)) return false
      componentLogger('engine').warn({ executionId: owner.attempt.executionId }, 'Source preparation closed an unentered workflow owner')
      await owned?.mcp?.close()
      return true
    }
    let receipt = status.receipt
    if (receipt.intent.executionId === owner.attempt.executionId && receipt.intent.attemptId === owner.attempt.attemptId
      && receipt.entryAttempted && !receipt.native && !hasPositiveRemoteEntryClosure(receipt)) {
      if (owned) await this.closeResidentPreparation(owned, 'source_preparation_closed_before_entry')
      else await this.recovery.closePendingEntry(receipt, log, this.signal)
      const closed = await log.status(receipt.intent.operationId)
      if (closed.status !== 'known') return false
      receipt = closed.receipt
    }
    if (receipt.intent.executionId !== owner.attempt.executionId || receipt.intent.attemptId !== owner.attempt.attemptId
      || owner.preparationNativeSession && (!['codex', 'opencode'].includes(owner.preparationNativeSession.harness)
        || owner.preparationNativeSession.nativeSessionId !== receipt.native?.sessionId)
      || receipt.entryAttempted && !receipt.native && !hasPositiveRemoteEntryClosure(receipt)
      // The journal adds the started turn to the native identity; the captured process identity never has it.
      || owned?.native && !hasPositiveRemoteEntryClosure(receipt)
        && (owned.native.native.sessionId !== receipt.native?.sessionId
          || owned.native.native.processIdentityDigest !== receipt.native?.processIdentityDigest)
      || owned?.session && !hasPositiveRemoteEntryClosure(receipt)
        && owned.session.nativeSessionId !== receipt.native?.sessionId) return false
    if (await log.isRetired(receipt.intent.operationId)) {
      await this.releaseSettled(receipt.intent)
      return true
    }
    if (receipt.terminal?.kind === 'not_started') {
      await log.retireSettled(receipt.intent, receipt.sequence)
      await this.releaseSettled(receipt.intent)
      return true
    }
    if (owned) {
      owned.launchDisabled = true
      await owned.host?.abortPreparation(owned.intent.operationId)
    }
    await log.revokeFence(owner.identity.operationId)
    if (owned?.manager) {
      if (!owned.manager.dispose) return false
      await owned.manager.dispose()
    }
    // A Run stopped before entry keeps this live process as the reservation's parent,
    // so only its explicit abandonment can prove that no native process started.
    await owned?.launchReservation
    if (owned?.scope.launchId) await this.registry.abandonReservedLaunch(owned.scope)
    if ((receipt.native || launches().length) && !await this.registry.closeOwner(processOwner)) return false
    componentLogger('engine').warn({ executionId: owner.attempt.executionId, terminal: Boolean(receipt.terminal) },
      'Source preparation closed a workflow owner')
    await owned?.mcp?.close()
    const terminal = receipt.terminal ? receipt : await log.terminal(owner.identity.operationId, {
      kind: receipt.native ? 'cancelled' : 'not_started',
      closureEvidenceDigest: receipt.native ? digest({ intent: receipt.intent, preparationClosed: true, launches: launches() })
        : remoteNonEntryClosureDigest(receipt.intent),
    })
    await log.retireSettled(terminal.intent, terminal.sequence)
    await this.releaseSettled(terminal.intent)
    return true
  }

  private readonly reservationClosed = async (operationId: string): Promise<boolean> => {
    if ([...this.operations.values()].some(owned => owned.intent.operationId === operationId)) return false
    if ([...this.construction.values()].some(pending => pending.intent.operationId === operationId)) return false
    const status = await (await this.journal()).status(operationId)
    if (status.status === 'unknown') return !this.recovery.readEntry(operationId)
    const receipt = status.receipt
    return Boolean(receipt.terminal && (receipt.terminal.kind === 'not_started' || hasPositiveRemoteEntryClosure(receipt))
      && !this.registry.snapshot().launches.some(launch => launch.owner === `execution:${receipt.intent.executionId}`
        && launch.lifecycle !== 'closed'))
  }

  private readonly drainForUpdate = async () => {
    await Promise.allSettled([...this.active])
    for (const owned of this.operations.values()) {
      const status = await (await this.journal()).status(owned.intent.operationId)
      if (status.status === 'known' && status.receipt.stopFence && !status.receipt.native) {
        await this.closeResidentPreparation(owned, 'worker_update_stopped_preparation')
      }
    }
    await Promise.all([...this.hosts.values()].map(host => host.drain()))
  }

  private createExtensions(): DeviceExtensionRegistration[] {
    return [{namespace:'execution-v1',version:1,role:'duplex',maxJsonBytes:DEVICE_APPLICATION_JSON_BYTES,maxBinaryBytes:0,
    handle: async (payload,context) => {
      if(context.bytes!==undefined)unavailable('workflow_binary_payload_refused')
      if(RemoteJobExecutionRpcRequestRecordSchema.safeParse(payload).success)throw new DomainError('JOB_RUNTIME_UNAVAILABLE','The installed workflow host has no Job runtime.',409)
      const frame=RemoteExecutionRpcRequestSchema.parse(payload)
      const task=(async()=>{
        this.currentIncoming(context.binding)
        if (frame.method === 'receipt-continuation') {
          const status = await(await this.journal()).status(frame.intent.operationId)
          if (status.status !== 'known' || !isDeepStrictEqual(status.receipt.intent, frame.intent)) {
            unavailable('original_receipt_transfer_owner_changed')
          }
          await workerExecutionAuthorizer(this.forBinding(context.binding))(frame.intent, frame.placement,
            status.receipt.stopFence ? 'stop' : 'read')
          this.current(context.binding)
          return { payload: this.responsePages.read(frame, context.binding) }
        }
        const stopped = await this.stopInitialConstruction(frame, context)
        if (stopped) return stopped
        const resident = this.operations.get(frame.intent.executionId)
        const stopping = frame.method === 'control' && frame.command.action.kind === 'stop'
        // Only the transport session changed: the original work continues on it, unless Main stops it.
        const reconnected = resident !== undefined && !resident.preparationRecovery && !stopping
          && sameDeviceInstallation(resident.context.binding, context.binding)
        if (resident && !reconnected) {
          const log = await this.journal()
          const status = await log.status(frame.intent.operationId)
          const acknowledged = status.status === 'known' && status.receipt.native && resident.native && resident.session
          const bindingChanged = !isDeepStrictEqual(resident.context.binding, context.binding)
          const stoppingEntry = stopping && status.status === 'known' && status.receipt.entryAttempted
          if (resident.preparationRecovery || !acknowledged && (bindingChanged || stoppingEntry)) {
            if (!isDeepStrictEqual(resident.intent, frame.intent) || !isDeepStrictEqual(resident.placement, frame.placement)
              || resident.context.binding.bootId !== context.binding.bootId) unavailable('original_operation_binding_changed')
            const action = frame.method === 'control' && frame.command.action.kind === 'stop' ? 'stop' : 'read'
            await workerExecutionAuthorizer(this.forBinding(context.binding))(frame.intent, frame.placement, action)
            this.current(context.binding)
            if (stopping) {
              if (frame.command.operationId !== frame.intent.operationId) unavailable('original_control_operation_changed')
              await log.control(frame.command)
            }
            resident.context = context
            await this.closeResidentPreparation(resident, resident.preparationRecovery ? 'preparation_recovery'
              : 'unacknowledged_preparation')
            this.current(context.binding)
          }
        }
        if ((!resident || resident.preparationRecovery) && (this.journalOpening
          || this.recovery.hasCapture(frame.intent.operationId) || await this.hasRetainedJournal())) {
          const recovered = await this.recoverUnowned(frame, context)
          if (recovered) return recovered
        }
        if (this.journalOpening && await(await this.journalOpening).isRetired(frame.intent.operationId)) {
          return this.retiredReply(frame, context, await this.journalOpening)
        }
        const action = frame.method === 'control' && frame.command.action.kind === 'stop' ? 'stop' : 'read'
        const host=await this.construct(context,frame.intent,frame.placement,action,
          frame.method === 'renew-owner' ? frame.transition : undefined)
        context.signal.throwIfAborted()
        const log = await this.journal()
        if (await log.isRetired(frame.intent.operationId)) return this.retiredReply(frame, context, log)
        if (frame.method === 'get-application-access') {
          const resident = this.operation(frame.intent)
          await workerExecutionAuthorizer(this.forBinding(resident.context.binding))(frame.intent, resident.placement, 'read')
          if (!resident.applicationAccess || !isDeepStrictEqual(resident.session, frame.session)
            || !resident.native || matchingOriginalRegistryLaunch(this.registry, resident.native.launch).lifecycle !== 'active')
            unavailable('original_application_lease_owner_missing')
          return { payload: { status: await log.status(frame.intent.operationId),
            applicationAccess: structuredClone(resident.applicationAccess!) } }
        }
        if(frame.method==='physical-readout')return {payload:pagePhysicalReadout(await this.physical.read(frame, context.signal), frame.metadata)}
        if(frame.method==='physical-ack') {
          const resident = this.operation(frame.intent)
          const status = await log.status(frame.intent.operationId)
          if (frame.retire && resident.physicalClosure
            && status.status === 'known' && status.receipt.terminal && status.receipt.sequence === frame.receiptSequence) {
            const readout = await this.physical.read(frame, context.signal)
            const terminalSource = frame.sourceDigest === remoteWorkflowSourceDigest({ type: 'boundary' })
              || readout.history && frame.sourceDigest === remoteWorkflowSourceDigest({
                type: 'history', history: remoteWorkflowNativeHistory(readout.history),
              })
            if (terminalSource) {
              await log.retireSettled(frame.intent, frame.receiptSequence)
              const ack = await this.physical.ack(frame)
              await this.releaseSettled(frame.intent)
              return {payload:ack}
            }
          }
          return {payload:await this.physical.ack(frame)}
        }
        // A retained process must be observable before its App binding can be restored.
        let reviewerObservationExpiresAt: string | undefined
        if (frame.method === 'status' || frame.method === 'reattach') {
          const original = await log.status(frame.intent.operationId)
          if (original.status === 'known' && original.receipt.retainedReviewer
            && !original.receipt.terminal && !original.receipt.stopFence) {
            const resident = this.operation(frame.intent)
            if (!resident.native || resident.session?.nativeSessionId !== original.receipt.native?.sessionId
              || matchingOriginalRegistryLaunch(this.registry, resident.native.launch).lifecycle !== 'active') {
              unavailable('original_reviewer_observation_owner_missing')
            }
            const request = this.forBinding(context.binding)
            const authorize = workerExecutionAuthorizer(request)
            const authority = await authorize(frame.intent, frame.placement, 'read')
            if (!authority?.cleanupOnly) {
              const policy = await workerReviewerAuthorizer(request)(frame.intent, frame.placement)
              if (policy) {
                const renewed = await log.renewReviewer(frame.intent.operationId, policy)
                reviewerObservationExpiresAt = renewed.retainedReviewer!.expiresAt
              } else {
                const latest = await authorize(frame.intent, frame.placement, 'read')
                if (!latest?.cleanupOnly) unavailable('original_reviewer_observation_denied')
              }
            }
          }
        }
        const response=await createRemoteExecutionHandler(host)(frame)
        const value=response&&typeof response==='object'?response as {session?:NativeSessionReference;history?:NativeHistory;status?:unknown}:undefined
        const status=value?.status&&typeof value.status==='object'?value.status as {status?:string;receipt?:unknown}:response as {status?:string;receipt?:unknown}
        if(status?.status==='known') {
          const receipt=RemoteOperationReceiptSchema.parse(status.receipt),resident=this.operation(frame.intent)
          if(receipt.native&&resident.native&&resident.session&&resident.runtimeLeaf&&resident.leaseExpiresAt) {
            const authority = await workerExecutionAuthorizer(this.forBinding(context.binding))(frame.intent, frame.placement,
              receipt.stopFence ? 'stop' : 'read')
            const cleanupOnly = authority?.cleanupOnly === true
            // Main may refuse the MCP lease for good, e.g. after it abandoned this attempt and revoked its
            // credential. Its readback of the attempt must still succeed so it can settle it.
            let leaseRefused = false
            const renewLease = async (renew: () => Promise<string>) => {
              try { resident.leaseExpiresAt = await renew() } catch (error) {
                if (!isLeaseRefusal(error)) throw error
                leaseRefused = true
              }
            }
            if (!reviewerObservationExpiresAt && !cleanupOnly && !receipt.stopFence && !resident.physicalClosure
              && Date.parse(resident.leaseExpiresAt) - this.input.mainNow() <= WORKER_MCP_LEASE_RENEWAL_WINDOW_MS) {
              if (!resident.mcp) unavailable('original_main_lease_required')
              await renewLease(() => resident.mcp!.refreshLease())
            } else if (!reviewerObservationExpiresAt && !cleanupOnly && !receipt.stopFence
              && Date.parse(resident.leaseExpiresAt) <= this.input.mainNow()) {
              if (!resident.relay) unavailable('original_main_lease_required')
              await renewLease(() => resident.relay!.refresh(this.signal))
            }
            // Cancellation readback uses cleanup authority; it does not extend the MCP credential.
            const observationExpiresAt = cleanupOnly || receipt.stopFence || leaseRefused
              ? new Date(this.input.mainNow() + 60_000).toISOString() : reviewerObservationExpiresAt ?? resident.leaseExpiresAt
            const originalHistory = nativeHistoryPageSource(response) ?? value?.history
            const source:WorkflowOriginalNativeSource=value?.session?{type:'session_created',session:value.session}
              :originalHistory?{type:'history',history:originalHistory}:{type:'boundary'}
            const history = originalHistory ?? (resident.retainedHistory
              ? projectNativeHistory(resident.retainedHistory) : undefined)
            const readout=RemoteWorkflowPhysicalReadoutSchema.parse({version:1,expiresAt:new Date(Math.min(Date.parse(observationExpiresAt),this.input.mainNow()+60_000)).toISOString(),
              launchIntent: this.recovery.read(receipt)?.intent ?? resident.intent,
              receipt,session:resident.session,launch:resident.native.launch,
              observation:matchingOriginalRegistryLaunch(this.registry,resident.native.launch),runtimeLeaf:resident.runtimeLeaf,
              source:{record:resident.capture.facts.executionPlacement.materialization,workingTree:resident.capture.facts.executionPlacement.workingTree},
              ...(history?{history}:{}),...(resident.physicalClosure?{closure:{ownerClosed:true,launch:resident.physicalClosure}}:{}),
              ...(receipt.terminal?.result ? { output: remoteWorkflowPhysicalOutput(receipt.terminal.result,
                resident.placement.payload.kind === 'agent' ? resident.placement.payload.artifactOutputs : undefined,
                receipt.terminal.artifactValidationError) } : {})})
            const assertOwnerCurrent = async () => {
              this.current(context.binding)
              await workerExecutionAuthorizer(this.forBinding(context.binding))(resident.intent,resident.placement,receipt.stopFence?'stop':'read')
              const logged = await(await this.journal()).status(resident.intent.operationId)
              if(logged.status!=='known'||!isDeepStrictEqual(logged.receipt.intent,resident.intent)
                ||logged.receipt.native?.sessionId!==resident.session?.nativeSessionId
                ||logged.receipt.native?.processIdentityDigest!==resident.native?.native.processIdentityDigest)unavailable('original_physical_owner_changed')
              this.current(context.binding)
            }
            this.physical.remember({readout,placement:frame.placement,source,leaseExpiresAt:observationExpiresAt,cleanup:cleanupOnly||receipt.stopFence||receipt.terminal!==undefined,assertOwnerCurrent,
              assertCurrent:async()=>{
                const approvedRoots=ApprovedRootAllowlistSchema.parse(cleanupOnly || receipt.stopFence
                  ? resident.runtimeRoots : await this.input.approvedRoots())
                await assertOriginalPhysicalDirectories({source:readout.source,runtimeLeaf:readout.runtimeLeaf,placement:resident.placement,approvedRoots,signal: this.signal,
                  assertCurrent:()=>this.current(context.binding),authorize:assertOwnerCurrent})
                if(!cleanupOnly&&!receipt.stopFence&&!isDeepStrictEqual(approvedRoots,ApprovedRootAllowlistSchema.parse(await this.input.approvedRoots())))unavailable('original_physical_root_policy_changed')
                this.current(context.binding)},
              observe:()=>matchingOriginalRegistryLaunch(this.registry,resident.native!.launch),
              closure:()=>resident.physicalClosure??null,
              waitForSettlement: signal => host.waitForSettlement(frame.intent.operationId, signal) })
          }
        }
        return {payload:response}
      })().then(reply => {
        this.current(context.binding)
        const paged = this.responsePages.page(reply.payload, frame, context.binding)
        if (paged !== undefined && Buffer.byteLength(JSON.stringify(paged)) > DEVICE_APPLICATION_JSON_BYTES) {
          unavailable('workflow_response_too_large')
        }
        return { ...reply, payload: paged }
      })
      this.active.add(task);void task.then(()=>this.active.delete(task),()=>this.active.delete(task))
      return task
    }},
    { ...EXECUTION_AUTHORITY_EXTENSION, role: 'client' },
    { ...WORKER_MCP_EXTENSION, role: 'client' },
  ]
  }
}
