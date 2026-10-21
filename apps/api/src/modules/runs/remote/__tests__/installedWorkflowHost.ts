import { persistentFixtureRoot } from '../../../../../test/helpers/fixtureStorage.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import {
  DEFAULT_HARNESS_DEFAULTS,
  CODEX_APPROVAL_OPTIONS_FIXTURE,
  withAdvancedDefaults,
  type AgentConfigurationVersion,
  type NativeSessionReference,
  type ResultProtocol,
} from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { NativeHistory, NativeSessionStart } from '../../../harnesses/port.js'
import type { ExecutionResult } from '@foreman-code/contracts'
import * as installedQualification from '../../../harnesses/installedCodexQualification.js'
import * as workerMcpEndpoint from '../workerMcpEndpoint.js'
import * as installedNativeOutput from '../installedNativeOutput.js'
import * as codexOutputProtection from '../../../harnesses/codexOutputProtection.js'
import { createInstalledWorkflowNativeOutputProviders } from '../installedWorkflowNativeOutputs.js'
import type { CodexNativeOutputs } from '../../../harnesses/codexNativeOutput.js'
import { runCommand } from '../../../harnesses/process.js'
import { workflowNativeOutputMain } from '../../../../../test/support/workflowNativeOutputs.js'
import {
  ExecutionFactsRequestSchema,
  ExecutionFactsResultSchema,
  ExecutionAuthorityRequestSchema,
} from '@foreman-code/contracts/execution-authority'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { CodexAppServerSessionManager } from '../../../harnesses/codexAppServer.js'
import * as installedInspection from '../../../harnesses/installedCodexInspection.js'
import { harnessConnectionGeneration } from '../../../harnesses/hostConnectionGeneration.js'
import { NativeProcessRegistry, type NativeLaunchObservation } from '../../../harnesses/recovery/processRegistry.js'
import { bootIdentity, processIdentity } from '../../../harnesses/recovery/linuxIdentity.js'
import { writeRecord } from '../../../harnesses/recovery/storage.js'
import { InstalledWorkflowRecovery } from '../installedWorkflowRecovery.js'
import { remoteWorkflowProcessDigest } from '../workflowPhysicalReadout.js'
import { RemoteOperationJournal } from '../operationJournal.js'
import { RemoteNativeSessionManager } from '../nativeManagerProxy.js'
import {
  captureInstalledWorkflowNativeOwner,
  createInstalledWorkflowHost,
  attestInstalledWorkflowRuntimeLeaf,
  type InstalledWorkflowHostOptions,
} from '../installedWorkflowHost.js'
import { SourceOperationWorkerService } from '../../../sources/operationWorker.js'
import { PrivateSourceMaterializer } from '../../../sources/materialization.js'
import { createSourceManifest, sourceSha256 } from '../../../sources/manifest.js'
import { sourceBindingHash } from '../../../sources/bindingHash.js'
import { identity, openPrivateRoot } from '../../../sources/privateFilesystem.js'
import { verifyMaterializedWorkingDirectory } from '../../../sources/workingDirectory.js'
import { freezePlacement, deriveDispatch } from '../../../placement/binding.js'
import { bindNativeExecution } from '../../../placement/executionBinding.js'
import type { SourceRootRecord, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import { WORKER_MCP_EXTENSION, WorkerMcpRelayRequestSchema } from '@foreman-code/contracts/worker-mcp-relay'
import type { WorkerMcpRelay } from '../workerMcpEndpoint.js'
import type { HarnessExecution } from '@foreman-code/contracts'
import type pg from 'pg'
import {
  createRemoteWorkflowPhysicalVerification,
  type RemoteWorkflowMainLifetime,
} from '../workflowPhysicalVerification.js'
import { RemoteWorkflowPhysicalReadoutSchema } from '@foreman-code/contracts/remote-workflow-physical'
import { createRemoteNativeSourceChannel } from '../../../placement/remoteNativeSource.js'
import { VerifiedRemoteEvidence } from '../resultBridge.js'
import { ExclusiveGraphConnection } from '../../../run-graph/connection.js'
import { repeatExecutionIdentity } from '../../repeatResolution.js'
import { DeviceApplicationChannel, type CapturedDeviceApplicationRequest } from '../../../devices/deviceApplicationChannel.js'
import { DeviceApplicationError } from '../../../devices/deviceApplicationError.js'
import { deferred } from '../../../../../test/helpers/deferred.js'

export const roots:string[]=[],journals:RemoteOperationJournal[]=[]

afterEach(async()=>{vi.restoreAllMocks();await Promise.all(journals.splice(0).map(journal=>journal.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})

export async function directory() {const root=await mkdtemp(join(persistentFixtureRoot, 'installed-workflow-'));roots.push(root);return root}

export function nativeFixture() {
  const connection=DeviceConnectionIdentitySchema.parse({mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),
    bootId:bootIdentity(),keyRevision:1,authorizationRevision:1,connectionGeneration:4})
  const intent=DispatchIntentSchema.parse({schemaVersion:1,protocolVersion:1,mainId:connection.mainId,runId:'run',nodeId:'node',executionId:'execution',
    occurrenceId:null,occurrenceIndex:0,technicalAttempt:1,attemptId:'attempt',operationId:'operation',bindingHash:'a'.repeat(64),inputDigest:`sha256:${'b'.repeat(64)}`,owner:{grantId:'grant',epoch:'1'}})
  const session:NativeSessionReference={harness:'codex',providerVersion:'codex-cli 0.154.0',nativeSessionId:'native-session'}
  // Provider/closure doubles test the exact consumer contract; no process or physical closure is produced here.
  const launch:NativeLaunchObservation={owner:'execution:execution',launchId:randomUUID(),bootId:connection.bootId,
    guardian:{pid:200,startTicks:'2000'},provider:{pid:201,startTicks:'2001'},boundary:{kind:'cgroup-v2',path:'/unit/boundary',device:'1',inode:'2'},lifecycle:'active'}
  const registry=new NativeProcessRegistry('/unit/registry'),snapshot=vi.spyOn(registry,'snapshot').mockReturnValue({revision:'snapshot:1',launches:[launch]})
  return {connection,intent,session,launch,registry,snapshot}
}

export async function closureFixture() {
  const f=nativeFixture(),root=await directory(),journal=await RemoteOperationJournal.open(join(root,'journal'),{initializeNewInstallation:true})
  journals.push(journal)
  const captured=captureInstalledWorkflowNativeOwner(f.registry,f.connection,f.intent,f.session)
  await journal.accept(f.intent,f.connection,randomUUID());await journal.reserveEntry(f.intent.operationId)
  await journal.acknowledgeStart(f.intent.operationId,captured.native)
  await journal.reserveTurn(f.intent.operationId,{correlationId:'execution:execution',promptDigest:'c'.repeat(64)})
  await journal.acknowledgeTurn(f.intent.operationId,'original-turn');await journal.markRunning(f.intent.operationId)
  const manager=new CodexAppServerSessionManager('/unused/unit/codex'),close=vi.spyOn(manager,'close').mockResolvedValue(undefined)
  const closeRegistration=vi.spyOn(f.registry,'closeRegistration').mockResolvedValue(undefined)
  const closeOwner=vi.spyOn(f.registry,'closeOwner').mockResolvedValue(false)
  const history={events:[],pendingInteractions:[],nativeTurnId:'original-turn',terminalTurn:{correlationId:'execution:execution',providerId:'original-turn',result:{outcome:'succeeded' as const}}}
  return {...f,root,journal,captured,manager,close,closeOwner,closeRegistration,history}
}

export async function sourceFixture(relativeCwd='', options: {
  artifactOutputKeys?: string[]; attemptId?: string; operationId?: string
} = {}) {
  const harness = 'codex'
  const root=await directory(),runtime=join(root,'runtime'),project=join(root,'project'),namespace=join(runtime,'source-materializations',randomUUID())
  await mkdir(runtime,{mode:0o700});await mkdir(project,{mode:0o700});await mkdir(namespace,{recursive:true,mode:0o700})
  if(relativeCwd)await mkdir(join(project,relativeCwd),{recursive:true,mode:0o700})
  const fsIdentity=async(path:string)=>{const handle=await openPrivateRoot(path);try{return await identity(handle)}finally{await handle.close()}}
  const binding:DeviceSessionBinding={mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),bootId:bootIdentity(),
    keyRevision:1,authorizationRevision:1,connectionEpoch:randomUUID(),connectionGeneration:3}
  const approvedRoots:ApprovedRootAllowlist={schemaVersion:1,hostRef:{kind:'device',mainId:binding.mainId,deviceId:binding.deviceId},
    applicationInstallationId:binding.workerInstallationId,configurationRevision:'1',bases:[{baseId:randomUUID(),canonicalPath:project,filesystem:await fsIdentity(project),accessModes:['read-only']}],
    managedRuntimeRoot:runtime,runtimeFilesystem:await fsIdentity(runtime)}
  const bytes=Buffer.from('export const fixture = true\n'),manifest=createSourceManifest({version:1,snapshotId:randomUUID(),approvedSourceId:randomUUID(),
    capturePolicy:'exclusive-explicit-bytes-v1',executablePolicy:'strip',deletions:[],entries:[{path:relativeCwd?`${relativeCwd}/source.ts`:'source.ts',kind:'file',byteSize:bytes.length,sha256:sourceSha256(bytes),executable:false}]})
  const source={approvedSourceId:manifest.approvedSourceId,snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},rootPolicyId=namespace.split('/').at(-1)!
  const sourceRoot:SourceRootRecord={version:1,source,selection:{hostRef:approvedRoots.hostRef,rootPolicyId,rootPolicyRevision:'1',locationRevision:'1'},
    binding:{version:1,mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,workspaceId:'workspace',rootId:randomUUID(),bindingRevision:1,
      locationRevision:1,canonicalPath:namespace,filesystem:await fsIdentity(namespace),accessMode:'exclusive-write',snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},
    ownerPrincipalId:'owner',authorizedByPrincipalId:'owner',registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1},
    attestationId:'attestation',attestationDigest:'a'.repeat(64),boundAt:new Date().toISOString()}
  const placement=freezePlacement({schemaVersion:1,mainId:binding.mainId,mainInstallationId:binding.mainId,runId:'run',nodeId:'node',hostRef:approvedRoots.hostRef,registration:sourceRoot.registration,
    destination:{canonicalProjectRoot:project,canonicalCwd:join(project,relativeCwd),managedRuntimeRoot:runtime,directoryIdentityHash:'a'.repeat(64),rootPolicyId,rootPolicyRevision:'1',locationRevision:'1',attestationId:'attestation',attestationHash:'a'.repeat(64)},
    source:{kind:'pending',...source,revisionId:'revision',rootId:sourceRoot.binding.rootId,bindingRevision:1,materializationId:null,materializationDigest:null},
    payload:{kind:'agent',agentId:'agent',agentConfigurationVersionId:'configuration',driverId:harness,driverRevision:'1',instanceId:randomUUID(),instanceRevision:'1',harnessInstallationId:`installed-${harness}`,installationFingerprint:'a'.repeat(64),runtimeContractVersion:1,protocolRevision:`${harness}-native-adapter-v1`,credentialScopeRefs:[],
      ...(options.artifactOutputKeys ? { artifactOutputs: { version: 1 as const, outputKeys: options.artifactOutputKeys } } : {})}})
  const input = {}
  const intent=deriveDispatch(placement,{
    executionId:'execution', attemptId:options.attemptId??'attempt', operationId:options.operationId??'operation',
    technicalAttempt:1, occurrenceId:null, occurrenceIndex:0, inputDigest:commandInputHash(input),
    owner:{grantId:'grant',epoch:'1'},
  })
  const attempt={executionId:intent.executionId,attemptId:intent.attemptId,keyRevision:1,authorizationRevision:1,placementHash:''}
  attempt.placementHash=sourceBindingHash(sourceRoot,attempt,intent.operationId)
  const receipt=await new PrivateSourceMaterializer({read:async()=>bytes},async()=>undefined).prepare({manifest,binding:sourceRoot.binding,attempt,signal:new AbortController().signal})
  const record:SourceMaterializationRecord={receipt,rootPolicyId,rootPolicyRevision:'1',operationId:intent.operationId,reservationId:randomUUID(),sourceBindingHash:attempt.placementHash,finalDispatchBindingHash:null,state:'prepared'}
  const workingTree=await verifyMaterializedWorkingDirectory(record,relativeCwd,async()=>undefined)
  const nativePlacement=bindNativeExecution(placement,intent,record,workingTree)
  nativePlacement.materialization.finalDispatchBindingHash=nativePlacement.bindingHash
  const owner:SourceOperationOwner={identity:{operationId:intent.operationId,ownerPrincipalId:'owner',expiresAt:'2099-01-01T00:00:00.000Z'},root:sourceRoot,attempt,source,record:nativePlacement.materialization,physicalClosureConfirmed:false}
  const sources=new SourceOperationWorkerService({mainNow:()=>Date.now(),authenticate:async()=>undefined,approvedRoots:async()=>approvedRoots,currentOwner:async()=>owner})
  const configuration:AgentConfigurationVersion={id:'configuration',agentId:'agent',workspaceId:'workspace',version:1,prompt:{system:'Unit workflow instructions.'},assignedSkills:[],harness:DEFAULT_HARNESS_DEFAULTS[harness],contentHash:'fixture',createdAt:new Date().toISOString()}
  const request={executionId:intent.executionId,runId:intent.runId,workspaceId:'workspace',workflowNodeId:intent.nodeId,workingDirectory:workingTree.canonicalCwd,
    runtimeDirectory:join(runtime,'workflow-runs',intent.executionId,intent.attemptId),configuration,input}
  return {root,approvedRoots,sources,owner,nativePlacement,intent,placement,request,context:{binding,signal:new AbortController().signal}}
}

export async function runningInstalledFixture(phase: 'generation' | 'approval wait' = 'generation',
  fixtureOptions: { retainReviewer?: boolean; deferTurn?: boolean; artifactOutputKeys?: string[];
    resultProtocol?: ResultProtocol;
    mainNow?: () => number; realMcp?: true;
    authorizeReviewer?: () => Promise<void>;
    mcp?: { request: WorkerMcpRelay['request']; onSessionStart(input: NativeSessionStart): Promise<void> } } = {}) {
  const { artifactOutputKeys } = fixtureOptions
  const f = await sourceFixture('', artifactOutputKeys
    ? { artifactOutputKeys, attemptId: randomUUID(), operationId: randomUUID() } : {})
  if (fixtureOptions.resultProtocol) Object.assign(f.request, { resultProtocol: fixtureOptions.resultProtocol })
  if (fixtureOptions.retainReviewer) f.request.configuration.productRole = 'orchestrator'
  if (artifactOutputKeys) {
    f.request.configuration.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write' }
  }
  f.intent = { ...f.intent, inputDigest: commandInputHash(f.request.input) }
  const file = join(f.root, 'workflow.json')
  const binary = join(f.root, 'codex')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, codexBinary: binary,
    appMcpLauncher: join(f.root, 'launcher.mjs'), expectedVersion: '0.132.0', payloadPaths: [] }), { mode: 0o600 })
  const target = { hostRef: f.placement.hostRef, applicationInstallationId: f.context.binding.workerInstallationId,
    harnessInstallationId: 'installed-codex', installationFingerprint: 'a'.repeat(64) }
  const installation = { hostRef: f.placement.hostRef, harnessInstallationId: target.harnessInstallationId,
    installationFingerprint: target.installationFingerprint, driverId: 'codex', driverRevision: '1',
    protocolRevision: 'codex-native-adapter-v1', environmentGeneration: 'environment', connectionGeneration: 'generation',
    installed: true, launcher: { status: 'installed', resolvedLauncher: binary, fingerprint: target.installationFingerprint,
      payloadFingerprints: [{ path: binary, fingerprint: 'a'.repeat(64) }] } }
  // Qualification and native provider doubles isolate installed-host transport/ownership behavior.
  const capture = { binding: f.context.binding, qualification: { version: '0.132.0' },
    inspection: { currentTarget: { installation } }, facts: { intent: f.intent, placement: f.placement,
      executionPlacement: f.nativePlacement, configuration: f.request.configuration,
      harness: { installation, override: { target, instanceId: f.placement.payload.kind === 'agent'
        ? f.placement.payload.instanceId : '', instanceRevision: '1', driverId: 'codex', enabled: true,
        configuration: f.request.configuration.harness } } },
  } as unknown as Awaited<ReturnType<ReturnType<typeof installedQualification.createInstalledCodexQualificationReader>['capture']>>
  vi.spyOn(installedQualification, 'createInstalledCodexQualificationReader').mockReturnValue({
    capture: vi.fn(async () => capture), repository: { find: async () => null, list: async () => [] },
  })
  if (!fixtureOptions.mcp && !fixtureOptions.realMcp) vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockImplementation(async ({ relay }) => {
    let closed = false
    return { endpoint: 'http://unit.invalid/mcp', close: vi.fn(async () => { closed = true }), bindRelay: async () => {},
      refreshLease: () => {
        if (closed) throw new Error('MCP endpoint already closed')
        return relay.refresh!()
      } }
  })
  const session: NativeSessionReference = { harness: 'codex', providerVersion: '0.132.0', nativeSessionId: 'original-session' }
  const registry = new NativeProcessRegistry(join(f.root, 'native-processes'))
  const log = await RemoteOperationJournal.open(join(f.root, 'workflow-journal'), {
    initializeNewInstallation: true, ...(fixtureOptions.mainNow ? { now: fixtureOptions.mainNow } : {}),
  })
  journals.push(log)
  let terminalRecorded!: () => void
  const settled = new Promise<void>(resolve => { terminalRecorded = resolve })
  const recordTerminal = log.terminal.bind(log)
  vi.spyOn(log, 'terminal').mockImplementation(async (operationId, evidence) => {
    const result = await recordTerminal(operationId, evidence)
    terminalRecorded()
    return result
  })
  let reviewerRetained!: () => void
  const retained = new Promise<void>(resolve => { reviewerRetained = resolve })
  const retainReviewer = log.retainReviewer.bind(log)
  vi.spyOn(log, 'retainReviewer').mockImplementation(async (...args) => {
    const result = await retainReviewer(...args)
    reviewerRetained()
    return result
  })
  const launch: NativeLaunchObservation = { owner: 'execution:execution', launchId: randomUUID(), bootId: f.context.binding.bootId,
    guardian: { pid: 200, startTicks: '2000' }, provider: { pid: 201, startTicks: '2001' },
    boundary: { kind: 'cgroup-v2', path: '/unit/boundary', device: '1', inode: '2' }, lifecycle: 'active' }
  let observed = launch
  vi.spyOn(registry, 'snapshot').mockImplementation(() => ({ revision: 'snapshot', launches: [observed] }))
  vi.spyOn(registry, 'closedRegistration').mockImplementation((owner, launchId) =>
    observed.owner === owner && observed.launchId === launchId && observed.lifecycle === 'closed'
      ? observed : undefined)
  vi.spyOn(registry, 'reserveLaunch').mockImplementation(async owner => ({ ...registry.scope(owner), launchId: launch.launchId }))
  vi.spyOn(registry, 'abandonReservedLaunch').mockResolvedValue(false)
  vi.spyOn(registry, 'closeRegistration').mockResolvedValue(undefined)
  const closeOwner = vi.spyOn(registry, 'closeOwner').mockImplementation(async () => {
    observed = { ...launch, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }
    return true
  })
  const history: NativeHistory = { events: [{ sequence: 1, type: 'native.notification',
    occurredAt: new Date().toISOString(), payload: { text: 'original output' } }],
    correlationId: 'execution:execution', nativeTurnId: 'original-turn', pendingInteractions: [],
    firstRetainedSequence: 1, nextSequence: 2 }
  if (phase === 'approval wait') history.pendingInteractions = [{ session, turn: { nativeTurnId: 'original-turn', nativeRequestId: 'question' },
    nativeRequestType: 'question', request: {}, responseOptions: [CODEX_APPROVAL_OPTIONS_FIXTURE[0]!] }]
  let release!: () => void
  let entered!: () => void
  const turnEnded = new Promise<void>(resolve => { release = resolve })
  const turnEntered = new Promise<void>(resolve => { entered = resolve })
  const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockResolvedValue(session)
  if (fixtureOptions.mcp) create.mockImplementation(async start => {
    await fixtureOptions.mcp!.onSessionStart(start)
    return session
  })
  const attach = vi.spyOn(CodexAppServerSessionManager.prototype, 'attachSession')
  const turns = vi.spyOn(CodexAppServerSessionManager.prototype, 'startTurn').mockImplementation(async function* (_session, turn) {
    await turn.onSubmitted?.('original-turn')
    entered()
    await turnEnded
    yield history.events[0]!
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'originalSessionLifetime').mockReturnValue({
    residency: { session, connectionId: 'native-connection', runtimeGeneration: 1, nativeTurnId: undefined },
    assertCurrent: () => {},
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockImplementation(async () => structuredClone(history))
  vi.spyOn(CodexAppServerSessionManager.prototype, 'pending').mockImplementation(async () => history.pendingInteractions[0])
  vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockResolvedValue(undefined)
  vi.spyOn(CodexAppServerSessionManager.prototype, 'dispose').mockResolvedValue(undefined)
  const finish = (outcome: 'succeeded' | 'canceled', output?: ExecutionResult['output']) => {
    history.pendingInteractions = []
    history.terminalTurn = { correlationId: 'execution:execution', providerId: 'original-turn',
      result: { outcome, ...(output === undefined ? {} : { output }) } }
    release()
  }
  const cancel = vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel').mockImplementation(async () => {
    finish('canceled')
    return true
  })
  let live: DeviceSessionBinding | undefined = f.context.binding
  let outputs: CodexNativeOutputs | undefined
  let outputMain: Awaited<ReturnType<typeof workflowNativeOutputMain>> | undefined
  let outputDirectory: string | undefined
  if (artifactOutputKeys) {
    outputDirectory = await mkdtemp(join(persistentFixtureRoot, 'installed-workflow-output-'))
    roots.push(outputDirectory)
    outputMain = await workflowNativeOutputMain({ directory: outputDirectory,
      currentIntent: () => f.intent, currentBinding: () => live,
      rootId: f.nativePlacement.materialization.receipt.binding.rootId,
      rootBindingRevision: f.nativePlacement.materialization.receipt.binding.bindingRevision })
    // Native qualification is a boundary double; the installed output store and publication path remain real.
    vi.spyOn(codexOutputProtection, 'qualifyCodexOutputProtection').mockResolvedValue()
    const createOutputs = installedNativeOutput.createInstalledNativeOutputs
    vi.spyOn(installedNativeOutput, 'createInstalledNativeOutputs').mockImplementation(ports => {
      outputs = createOutputs(ports)
      return outputs
    })
  }
  let expiresAt = new Date((fixtureOptions.mainNow?.() ?? Date.now()) + 15 * 60_000).toISOString()
  let launchDenied = false
  let cleanupOnly = false
  const retain = fixtureOptions.retainReviewer ?? false
  let retentionDenied = false
  let mcpDenied = false
  let mcpLeaseRevoked = false
  const requests: Array<{ namespace: string; payload: unknown; binding: DeviceSessionBinding }> = []
  const options: InstalledWorkflowHostOptions = { stateDirectory: f.root, registry,
    mainNow: fixtureOptions.mainNow ?? (() => Date.now()),
    pairing: { formatVersion: 1, mainId: f.context.binding.mainId, deviceId: f.context.binding.deviceId,
      workerInstallationId: f.context.binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      endpoint: 'wss://unit.invalid/device', mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z' }, bootId: f.context.binding.bootId,
    configuration: { path: file, ownerUid: process.getuid!() }, currentBinding: () => live,
    captureRequest: namespace => {
      if (!live) return undefined
      const binding = structuredClone(live)
      return { binding, request: async (payload, requestOptions) => {
        requests.push({ namespace, payload, binding })
        if (namespace === 'execution-authority-v1') {
          const request = payload as { action: string; intent: typeof f.intent }
          if (request.action === 'retain-reviewer') await fixtureOptions.authorizeReviewer?.()
          if (retentionDenied && request.action === 'retain-reviewer') throw new Error('Reviewer retention revoked')
          if (launchDenied && request.action !== 'stop' && request.action !== 'read') throw new Error('Launch authority revoked')
          return { payload: { version: 1, action: request.action, operationId: f.intent.operationId,
            attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, owner: request.intent.owner,
            ...(retain && request.action === 'retain-reviewer'
              ? { reviewer: { agentId: 'agent',
                expiresAt: new Date((fixtureOptions.mainNow?.() ?? Date.now()) + 60_000).toISOString() } } : {}),
            ...(cleanupOnly ? { cleanupOnly: true } : {}) } }
        }
        if (mcpDenied) throw new Error('App binding requires recovery')
        // Main's answer once it abandoned the attempt and revoked the Agent credential.
        if (mcpLeaseRevoked && namespace === WORKER_MCP_EXTENSION.namespace) throw new DeviceApplicationError('AUTH_REVOKED')
        if (launchDenied) throw new Error('Original MCP lease revoked')
        if (fixtureOptions.mcp && namespace === WORKER_MCP_EXTENSION.namespace) {
          const request = WorkerMcpRelayRequestSchema.parse(payload)
          if (request.operation === 'worker-mcp.request') {
            return { payload: await fixtureOptions.mcp.request(request.body, request.protocolVersion, requestOptions?.signal) }
          }
        }
        if (outputMain && namespace === 'byte-transfer-v1') {
          return outputMain.handleBytes(payload, binding, requestOptions?.bytes)
        }
        if (outputMain && namespace === WORKER_MCP_EXTENSION.namespace
          && (payload as { operation?: string }).operation !== 'worker-mcp.authorize') {
          return outputMain.handleMcp(payload, binding)
        }
        return { payload: { version: 1, mainId: f.intent.mainId, audience: 'worker', principalId: 'original-principal',
          executionId: f.intent.executionId, agentId: 'agent', operationId: f.intent.operationId,
          attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, expiresAt } }
      } }
    }, sources: f.sources, approvedRoots: async () => f.approvedRoots, codexSuiteRevision: 'codex-live-4',
    signal: new AbortController().signal, journal: async () => log }
  if (outputDirectory) {
    options.nativeOutputs = context => createInstalledWorkflowNativeOutputProviders({
      stateDirectory: outputDirectory!, context, registry, captureRequest: options.captureRequest,
      qualification: { qualify: async () => { throw new Error('Native qualification boundary double') }, command: runCommand },
    })
  }
  const host = await createInstalledWorkflowHost(options)
  if (host.kind !== 'configured') throw new Error('Expected installed test host')
  const handler = host.extensions[0]!.handle!
  const call = async (method: string, fields: Record<string, unknown> = {}, binding = live) => {
    if (!binding) throw new Error('Disconnected')
    return handler({ method, intent: f.intent, placement: f.placement, ...fields },
      { binding, signal: new AbortController().signal })
  }
  const applicationAccess = { kind: 'scoped-worker-mcp', token: 'original-token', executionId: f.intent.executionId,
    agentId: 'agent', operationId: f.intent.operationId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash }
  let prepared: DeviceApplicationResult
  try {
    if (fixtureOptions.mcp) {
      const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement,
        harness: 'codex', configuration: f.request.configuration,
        observeReceipt: async () => {}, controlFor: async () => { throw new Error('No native controls in startup') },
        transport: { request: async (method, raw) => {
          const result = await call(method, {
            ...(raw as Record<string, unknown>), executionPlacement: f.nativePlacement,
          })
          return result.payload
        } } })
      const session = await proxy.createSession({ request: f.request, correlationId: `execution:${f.intent.executionId}`,
        environment: { agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: applicationAccess.token } } })
      prepared = { payload: { session, status: await log.status(f.intent.operationId) } }
    } else {
      prepared = await call('prepare', { request: f.request, executionPlacement: f.nativePlacement, applicationAccess })
    }
  } catch (error) {
    await host.close()
    throw error
  }
  if (!fixtureOptions.deferTurn) {
    await call('start-turn', { prompt: 'original prompt', correlationId: 'execution:execution' })
    await turnEntered
  }
  const initialStatus = await log.status(f.intent.operationId)
  if (initialStatus.status !== 'known') throw new Error('Missing original native status')
  const stop = async () => {
    return call('control', { command: { schemaVersion: 1, protocolVersion: 1, commandId: 'stop',
      operationId: f.intent.operationId, attemptId: f.intent.attemptId, executionId: f.intent.executionId,
      bindingHash: f.intent.bindingHash, owner: f.intent.owner, native: initialStatus.receipt.native, action: { kind: 'stop' } } })
  }
  const renewOwner = async () => {
    const nextIntent = { ...f.intent, owner: { grantId: 'renewed-grant', epoch: '2' } }
    await call('renew-owner', { intent: nextIntent, transition: { commandId: 'owner-renewal',
      operationId: f.intent.operationId, previousOwner: f.intent.owner, nextOwner: nextIntent.owner,
      native: initialStatus.receipt.native, evidenceDigest: 'a'.repeat(64) } })
    f.intent = nextIntent
    return nextIntent
  }
  return { ...f, host, journal: log, prepared, call, stop, finish, settled, retained, history, create, attach, turns, cancel, closeOwner, requests,
    outputs, outputMain, session, renewOwner,
    denyMcp: () => { mcpDenied = true },
    revokeRetention: () => { retentionDenied = true },
    disconnect: () => { live = undefined }, reconnect: (binding: DeviceSessionBinding) => { live = binding },
    cleanup: () => { cleanupOnly = true; launchDenied = true },
    renew: (expiry: string) => { expiresAt = expiry }, revoke: () => { launchDenied = true },
    revokeMcpLease: () => { mcpLeaseRevoked = true },
    changeProcess: () => { observed = { ...launch, provider: { pid: 201, startTicks: 'changed' } } } }
}

export async function restartedInstalledFixture(captureOptions: { accepted?: boolean; acknowledged?: boolean; sessionCaptured?: boolean } = {}) {
  const f = await sourceFixture()
  const runtimeLeaf = await attestInstalledWorkflowRuntimeLeaf(f)
  const originalConnection = DeviceConnectionIdentitySchema.strip().parse({ ...f.context.binding, bootId: randomUUID() })
  const registryRoot = join(f.root, 'workflow-native-processes')
  const registry = new NativeProcessRegistry(registryRoot)
  const owner = `execution:${f.intent.executionId}`
  const launchId = randomUUID()
  const parent = processIdentity(process.pid)!
  const guardian = { pid: 50001, startTicks: '101', group: 50001, session: 50001, state: 'S' }
  const provider = { pid: 50002, startTicks: '102' }
  const boundary = { kind: 'cgroup-v2' as const, path: `/sys/fs/cgroup/graphql-native-${launchId}`, device: '1', inode: '2' }
  const path = join(registryRoot, createHash('sha256').update(owner).digest('hex'), launchId)
  const shared = { format: 1, id: launchId, owner, boot: originalConnection.bootId }
  writeRecord(join(path, 'intent.json'), { ...shared, parent, controlKey: 'a'.repeat(64) })
  if (captureOptions.accepted !== false) {
    writeRecord(join(path, 'birth.json'), { ...shared, guardian, containment: boundary })
    writeRecord(join(path, 'provider.json'), { ...shared, guardian, provider, capture: 'captured' })
  }
  const launch: NativeLaunchObservation = { owner, launchId, bootId: originalConnection.bootId,
    guardian: { pid: guardian.pid, startTicks: guardian.startTicks }, provider, boundary, lifecycle: 'active' }
  const session: NativeSessionReference = { harness: 'codex', nativeSessionId: 'original-session', providerVersion: '0.154.0' }
  const native = { sessionId: session.nativeSessionId,
    processIdentityDigest: remoteWorkflowProcessDigest(originalConnection, f.intent, launch) }
  const journalPath = join(f.root, 'workflow-operations.json')
  const journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
  journals.push(journal)
  if (captureOptions.accepted !== false) {
    await journal.accept(f.intent, originalConnection, randomUUID())
    await journal.reserveEntry(f.intent.operationId)
  }
  if (captureOptions.accepted !== false && captureOptions.acknowledged !== false) {
    await journal.acknowledgeStart(f.intent.operationId, native)
    await journal.reserveTurn(f.intent.operationId, { correlationId: `execution:${f.intent.executionId}`, promptDigest: 'b'.repeat(64) })
    await journal.acknowledgeTurn(f.intent.operationId, 'original-turn')
    await journal.markRunning(f.intent.operationId)
  }
  const recovery = new InstalledWorkflowRecovery(join(f.root, 'workflow-recovery'), registry)
  recovery.rememberEntry({ version: 1, intent: f.intent, connection: originalConnection, owner, initialLaunchId: launchId })
  if (captureOptions.sessionCaptured !== false) {
    recovery.remember({ version: 1, intent: f.intent, connection: originalConnection, native, session,
      launch: RemoteWorkflowPhysicalReadoutSchema.shape.launch.parse(launch), runtimeLeaf,
      approvedRoots: f.approvedRoots,
      source: RemoteWorkflowPhysicalReadoutSchema.shape.source.parse({
        record: f.nativePlacement.materialization, workingTree: f.nativePlacement.workingTree }) })
  }
  const file = join(f.root, 'workflow.json')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, codexBinary: '/unit/codex', appMcpLauncher: '/unit/launcher.mjs',
    expectedVersion: '0.154.0', payloadPaths: [] }), { mode: 0o600 })
  let authorized = true
  const options: InstalledWorkflowHostOptions = { stateDirectory: f.root, mainNow: () => Date.now(), bootId: f.context.binding.bootId,
    pairing: { formatVersion: 1, mainId: f.context.binding.mainId, deviceId: f.context.binding.deviceId,
      workerInstallationId: f.context.binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      endpoint: 'wss://unit.invalid/device', mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z' }, configuration: { path: file, ownerUid: process.getuid!() },
    currentBinding: () => f.context.binding, captureRequest: () => ({ binding: f.context.binding,
      request: async (payload, requestOptions) => {
        requestOptions?.signal?.throwIfAborted()
        if (!authorized) throw new Error('Main denied recovery')
        const request = ExecutionAuthorityRequestSchema.parse(payload)
        return { payload: { version: 1, action: request.action, operationId: request.intent.operationId,
          attemptId: request.intent.attemptId, bindingHash: request.intent.bindingHash, owner: request.intent.owner } }
      } }), sources: f.sources, approvedRoots: async () => f.approvedRoots,
    codexSuiteRevision: 'codex-live-4', signal: new AbortController().signal }
  const startHost = async () => {
    const host = await createInstalledWorkflowHost(options)
    if (host.kind !== 'configured') throw new Error('Installed recovery host is unavailable')
    return host
  }
  return { ...f, journal, journalPath, registry, recovery, native, launch, session, startHost,
    deny: () => { authorized = false }, allow: () => { authorized = true } }
}

export async function constructionFixture(fixtureOptions: {
  artifactOutputKeys?: string[]
} = {}) {
  const harness = 'codex'
  const version = '0.154.0'
  const suiteRevision = 'codex-live-4'
  const binary = `/unit/${harness}`
  const f = await sourceFixture('', fixtureOptions)
  f.intent = { ...f.intent, inputDigest: commandInputHash(f.request.input) }
  if (f.placement.payload.kind !== 'agent') throw new Error('Expected Agent placement')
  const payload = f.placement.payload
  const binding = f.context.binding
  const timestamp = new Date().toISOString()
  const target = { hostRef: f.placement.hostRef, applicationInstallationId: binding.workerInstallationId,
    harnessInstallationId: payload.harnessInstallationId, installationFingerprint: payload.installationFingerprint }
  const installation = { hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId,
    installationFingerprint: target.installationFingerprint, driverId: harness, driverRevision: '1',
    protocolRevision: payload.protocolRevision, environmentGeneration: 'unit-worker-environment',
    connectionGeneration: harnessConnectionGeneration(binding),
    launcher: { requested: binary, resolvedLauncher: binary, fingerprint: target.installationFingerprint,
      payloadFingerprints: [{ path: binary, fingerprint: 'a'.repeat(64) }], status: 'installed', interpreter: null,
      diagnostics: [], environment: { generation: 'unit-worker-environment', provenance: 'worker', cwd: f.root, path: '/usr/bin' },
      checkedAt: timestamp }, observedVersion: version, installed: true, authenticated: true, compatible: true, qualified: true }
  const override = { instanceId: payload.instanceId, revision: 1, instanceRevision: payload.instanceRevision,
    target, presetId: 'unit-preset', enabled: true, driverId: harness, configuration: f.request.configuration.harness,
    configurationFingerprint: commandInputHash(withAdvancedDefaults(f.request.configuration.harness)), qualification: 'qualified' }
  const qualification = { harness, version, binarySha256: 'a'.repeat(64), status: 'qualified',
    profile: 'codex-0.156', suiteRevision, checks: [{ id: 'unit-native-check', passed: true, detail: null }],
    failureReason: null, startedAt: timestamp, checkedAt: timestamp }
  const facts = ExecutionFactsResultSchema.parse({ version: 1, intent: f.intent, placement: f.placement,
    configuration: f.request.configuration, executionPlacement: f.nativePlacement,
    harness: { installation, override, qualification, profileProof: {
      target, instanceRevision: override.instanceRevision, configurationFingerprint: override.configurationFingerprint,
      driverId: harness, driverRevision: '1', protocolRevision: payload.protocolRevision,
      suiteRevision: `${harness}-profile-check-v1`, environmentGeneration: installation.environmentGeneration,
      connectionGeneration: installation.connectionGeneration, authenticated: true, compatible: true,
      qualified: true, checkedAt: timestamp,
    } } })
  // Main, installed-binary and native-process observations are unit doubles; the host, journal and source guards are real.
  // Inspection reports the authenticated session it was asked about, as the installed inspection does.
  const inspect = vi.spyOn(installedInspection, 'inspectInstalledCodex').mockImplementation(async ({ binding: live }) => ({
    inventory: { instances: [], installations: [facts.harness.installation] },
    currentTarget: { binding: live, target, installation: facts.harness.installation,
      binarySha256: 'a'.repeat(64), expectedVersion: version },
  }))
  let authorized = true
  const readMain = vi.fn(async (raw: unknown): Promise<DeviceApplicationResult> => {
    const read = ExecutionFactsRequestSchema.safeParse(raw)
    if (read.success) {
      const { intent, placement } = read.data.authorization
      return { payload: { ...facts, intent, placement, executionPlacement: { ...facts.executionPlacement,
        executionId: intent.executionId, attemptId: intent.attemptId, operationId: intent.operationId } } }
    }
    if (!authorized) throw new Error('Main denied original execution access')
    const authority = ExecutionAuthorityRequestSchema.safeParse(raw)
    if (authority.success) {
      const { intent, action } = authority.data
      return { payload: { version: 1, action, operationId: intent.operationId, attemptId: intent.attemptId,
        bindingHash: intent.bindingHash, owner: intent.owner } }
    }
    return { payload: { version: 1, mainId: binding.mainId, audience: 'worker', principalId: 'unit-principal',
      executionId: f.intent.executionId, agentId: f.request.configuration.agentId, operationId: f.intent.operationId,
      attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, expiresAt: '2099-01-01T00:00:00.000Z' } }
  })
  const file = join(f.root, 'installed-workflow.json')
  const selection = { codexBinary: binary, expectedVersion: version, payloadPaths: [] }
  await writeFile(file, JSON.stringify({ schemaVersion: 1, ...selection, appMcpLauncher: '/unit/launcher.mjs' }), { mode: 0o600 })
  const journal = await RemoteOperationJournal.open(join(f.root, 'construction-journal'), { initializeNewInstallation: true })
  journals.push(journal)
  const n = nativeFixture()
  const currentBinding = vi.fn<() => typeof binding | undefined>(() => binding)
  const linkLostAt = vi.fn<() => number | undefined>(() => undefined)
  const openJournal = vi.fn(async () => journal)
  let applicationChannel: DeviceApplicationChannel | undefined
  const options: InstalledWorkflowHostOptions = { stateDirectory: f.root, mainNow: () => Date.now(), bootId: binding.bootId,
    pairing: { formatVersion: 1, mainId: binding.mainId, deviceId: binding.deviceId,
      workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision,
      authorizationRevision: binding.authorizationRevision, endpoint: 'wss://unit.invalid/device',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' },
    configuration: { path: file, ownerUid: process.getuid!() }, currentBinding, linkLostAt,
    captureRequest: namespace => {
      const live = currentBinding()
      return applicationChannel?.captureRequest(namespace) ?? (live && { binding: live, request: readMain })
    },
    sources: f.sources, approvedRoots: async () => f.approvedRoots,
    codexSuiteRevision: 'codex-live-4',
    signal: new AbortController().signal, registry: n.registry, journal: openJournal }
  const host = await createInstalledWorkflowHost(options)
  if (host.kind !== 'configured') throw new Error('Expected configured installed host')
  const handler = host.extensions[0]!.handle!
  return { ...f, registry: n.registry, session: n.session, launch: n.launch, snapshot: n.snapshot,
    host, handler, journal, readMain, inspect, currentBinding, linkLostAt, openJournal,
    setApplicationChannel: (channel: DeviceApplicationChannel) => { applicationChannel = channel },
    deny: () => { authorized = false } }
}

export function delayedFacts(readMain: Awaited<ReturnType<typeof constructionFixture>>['readMain'], executionId: string) {
  const entered = deferred()
  const release = deferred()
  const original = readMain.getMockImplementation()!
  readMain.mockImplementation(async raw => {
    const read = ExecutionFactsRequestSchema.safeParse(raw)
    if (read.success && read.data.authorization.intent.executionId === executionId) {
      entered.resolve()
      await release.promise
      throw new Error('Delayed qualification rejected')
    }
    return original(raw)
  })
  return { entered, release, restore: () => { readMain.mockImplementation(original) } }
}

export async function physicalFixture(relativeCwd='') {
  const f=await sourceFixture(relativeCwd),n=nativeFixture()
  const connection=DeviceConnectionIdentitySchema.parse({mainId:f.context.binding.mainId,deviceId:f.context.binding.deviceId,
    workerInstallationId:f.context.binding.workerInstallationId,keyRevision:f.context.binding.keyRevision,authorizationRevision:f.context.binding.authorizationRevision,
    bootId:f.context.binding.bootId,connectionGeneration:f.context.binding.connectionGeneration})
  const captured=captureInstalledWorkflowNativeOwner(n.registry,connection,f.intent,n.session)
  const journal=await RemoteOperationJournal.open(join(f.root,'physical-journal'),{initializeNewInstallation:true});journals.push(journal)
  await journal.accept(f.intent,connection,randomUUID());await journal.reserveEntry(f.intent.operationId)
  await journal.acknowledgeStart(f.intent.operationId,captured.native)
  await journal.reserveTurn(f.intent.operationId,{correlationId:`execution:${f.intent.executionId}`,promptDigest:'c'.repeat(64)})
  await journal.acknowledgeTurn(f.intent.operationId,'original-turn');await journal.markRunning(f.intent.operationId)
  const status=await journal.status(f.intent.operationId)
  if(status.status!=='known')throw new Error('Unit journal must retain its original receipt')
  const history={events:[],pendingInteractions:[],correlationId:`execution:${f.intent.executionId}`,nativeTurnId:'original-turn'}
  const source={type:'history' as const,history}
  const runtimeLeaf=await attestInstalledWorkflowRuntimeLeaf(f)
  const readout=RemoteWorkflowPhysicalReadoutSchema.parse({version:1,expiresAt:new Date(Date.now()+60_000).toISOString(),
    receipt:status.receipt,session:n.session,launch:captured.launch,
    observation:captured.launch,runtimeLeaf,source:{record:f.nativePlacement.materialization,workingTree:f.nativePlacement.workingTree},history})
  const execution:HarnessExecution={id:f.intent.executionId,runId:f.intent.runId,workflowNodeId:f.intent.nodeId,agentId:f.request.configuration.agentId,
    agentConfigurationVersionId:f.request.configuration.id,attempt:f.intent.technicalAttempt,state:'running',nativeSessionId:n.session.nativeSessionId,
    input:{},createdAt:new Date().toISOString(),workingDirectory:f.request.workingDirectory,runtimeDirectory:f.request.runtimeDirectory}
  const lifetime:RemoteWorkflowMainLifetime={execution,session:n.session,lifetimeGeneration:1,closureGeneration:'1',
    lane:{id:'original-main-lane',token:'unit-original-private-lane-token',connectionGeneration:2,providerId:'original-turn'},assertCurrent:vi.fn()}
  const reservation={execution:repeatExecutionIdentity(execution),scope:{runId:execution.runId}}
  const entry={phase:'entered',reservation,transition:{phase:'entered',reservation,launchDigest:`sha256:${'e'.repeat(64)}`},source_id:'actual-unit-entry',source_digest:`sha256:${'f'.repeat(64)}`}
  const lane={owner_agent_id:execution.agentId,harness:n.session.harness,native_session_id:n.session.nativeSessionId,generation:'2',token:lifetime.lane!.token,
    correlation:`execution:${execution.id}`,provider_id:'original-turn',held:true}
  const request=vi.fn<CapturedDeviceApplicationRequest['request']>(async()=>({payload:readout}))
  const currentBinding=vi.fn(()=>f.context.binding)
  const canonicalProofs:{record:{execution:ReturnType<typeof repeatExecutionIdentity>;session:NativeSessionReference;original:typeof source}}[]=[]
  const credential = { revoked: false, expiresAt: Date.now() + 3_600_000 }
  // Authenticated carrier/SQL/process observations are explicit unit doubles.
  // The real source materialization/runtime directory above exercises FD/CWD receipts; no native or signed connection is produced.
  const producer=createRemoteWorkflowPhysicalVerification({endpoint:()=>({currentBinding,captureRequest:()=>({binding:f.context.binding,request})})})
  const query=vi.fn(async(text:string)=>{
    if (text.startsWith('select r.id from runs r join execution_dispatch_intents')) {
      return { rows: [{ id: execution.runId }], rowCount: 1 }
    }
    if(['begin isolation level read committed','commit','rollback'].includes(text))return {rows:[],rowCount:0}
    if(text.includes('from execution_dispatch_intents'))return {rows:[{...f.intent,operation_id:f.intent.operationId,execution_id:f.intent.executionId,run_id:f.intent.runId,
      node_id:f.intent.nodeId,binding_hash:f.intent.bindingHash,attempt_id:f.intent.attemptId,record:f.intent}],rowCount:1}
    if(text.includes('remote_execution_owner_reconciliations'))return {rows:[],rowCount:0}
    if(text.includes('run_node_placements'))return {rows:[{record:f.placement}],rowCount:1}
    if(text.includes('execution_native_placements'))return {rows:[{record:f.nativePlacement}],rowCount:1}
    if(text.includes('source_execution_materializations'))return {rows:[{record:f.nativePlacement.materialization,state:f.nativePlacement.materialization.state}],rowCount:1}
    if(text.includes('remote_dispatch_origins'))return {rows:[{connection}],rowCount:1}
    if(text.includes('harness_executions'))return {rows:[{record:execution,accepted:true,
      authorized:!credential.revoked&&credential.expiresAt>Date.now()}],rowCount:1}
    if(text.includes('workflow_native_entries'))return {rows:[entry],rowCount:1}
    if(text.includes('workflow_native_proofs'))return {rows:canonicalProofs.map(row=>({...row,original:row.record.original})),rowCount:canonicalProofs.length}
    if(text.includes('execution_native_sessions'))return {rows:[{reference:n.session}],rowCount:1}
    if(text.includes('execution_native_closures'))return {rows:[{generation:'1',expected_reference:n.session,closed:false}],rowCount:1}
    if(text.includes('native_session_lanes'))return {rows:[lane],rowCount:1}
    throw new Error(`Unexpected physical SQL: ${text}`)
  })
  const sqlConnection=new ExclusiveGraphConnection({query} as unknown as pg.ClientBase,()=>{})
  const owner={runId:f.intent.runId,assertOwned:vi.fn()} as unknown as Parameters<typeof producer.bind>[2]
  const originals=createRemoteNativeSourceChannel()
  let original:Parameters<typeof producer.bind>[0]|undefined
  const bind=async()=>{
    const prepared=await producer.prefetch(readout.receipt,f.placement,source)
    await VerifiedRemoteEvidence.commit(readout.receipt,connection,{transaction:async(_operation,work)=>work({authority:async()=>({intent:f.intent,placement:f.placement,
      originalConnection:connection,originalIncarnationId:readout.receipt.workerIncarnationId,grantIsLive:true,lastSequence:0,lastReceipt:null,native:null,terminal:null}),
      reject:async()=>{throw new Error('Unit original receipt rejected')},accept:async verified=>{
        originals.observe(verified,source,()=>{});original=originals.verify.read(originals.capture(f.intent.executionId,source))
        producer.bind(original,prepared,owner,lifetime)
      }})})
    if(!original)throw new Error('Expected private unit original-source capability')
    return original
  }
  return {...f,registry:n.registry,snapshot:n.snapshot,session:n.session,launch:n.launch,connection,captured,journal,readout,source,execution,lifetime,
    entry,lane,request,currentBinding,producer,query,sqlConnection,owner,originals,bind,canonicalProofs,credential}
}
