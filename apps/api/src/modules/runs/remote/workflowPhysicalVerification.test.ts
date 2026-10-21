import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion, type NativeSessionReference } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { NativeProcessRegistry, type NativeLaunchObservation } from '../../harnesses/recovery/processRegistry.js'
import { bootIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { captureInstalledWorkflowNativeOwner, attestInstalledWorkflowRuntimeLeaf } from './installedWorkflowHost.js'
import { SourceOperationWorkerService } from '../../sources/operationWorker.js'
import { PrivateSourceMaterializer } from '../../sources/materialization.js'
import { createSourceManifest, sourceSha256 } from '../../sources/manifest.js'
import { sourceBindingHash } from '../../sources/bindingHash.js'
import { identity, openPrivateRoot } from '../../sources/privateFilesystem.js'
import { verifyMaterializedWorkingDirectory } from '../../sources/workingDirectory.js'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { bindNativeExecution } from '../../placement/executionBinding.js'
import type { SourceRootRecord, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { HarnessExecution } from '@foreman-code/contracts'
import type pg from 'pg'
import { createRemoteWorkflowPhysicalVerification, type RemoteWorkflowMainLifetime } from './workflowPhysicalVerification.js'
import { RemoteWorkflowPhysicalReadoutSchema } from '@foreman-code/contracts/remote-workflow-physical'
import { assertRemoteNativeSourceLocked, createRemoteNativeSourceChannel, type RemoteNativeSourceEvidence } from '../../placement/remoteNativeSource.js'
import { VerifiedRemoteEvidence } from './resultBridge.js'
import { deviceRequestTimeoutMs } from '../../devices/deviceRequestRetry.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { DomainError } from '../../errors.js'
import { ExclusiveGraphConnection, beforeGraphCommit } from '../../run-graph/connection.js'
import { repeatExecutionIdentity, repeatDigest } from '../repeatResolution.js'

import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import type { WorkflowNativeCapture, WorkflowOriginalNativeSource } from '../../interactions/workflowNativeCapture.js'
import type { WorkflowPhysicalArtifactsPort } from './workflowPhysicalArtifacts.js'
import { workflowNativeReservation } from '../workflowNativeEntry.js'
import { workflowNativeSourceRecord } from '../workflowNativeSource.js'
import { remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import type { StoredRepeatExecution } from '../repeatPostgres.js'
const roots:string[]=[],journals:RemoteOperationJournal[]=[]
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(journals.splice(0).map(journal=>journal.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function directory() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'installed-workflow-'))
  roots.push(root)
  return root
}
function nativeFixture(harness: 'codex' = 'codex') {
  const connection=DeviceConnectionIdentitySchema.parse({mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),
    bootId:bootIdentity(),keyRevision:1,authorizationRevision:1,connectionGeneration:4})
  const intent=DispatchIntentSchema.parse({schemaVersion:1,protocolVersion:1,mainId:connection.mainId,runId:'run',nodeId:'node',executionId:'execution',
    occurrenceId:null,occurrenceIndex:0,technicalAttempt:1,attemptId:'attempt',operationId:'operation',bindingHash:'a'.repeat(64),inputDigest:`sha256:${'b'.repeat(64)}`,owner:{grantId:'grant',epoch:'1'}})
  const session: NativeSessionReference = {
    harness,
    providerVersion: 'codex-cli 0.154.0',
    nativeSessionId: 'native-session',
  }
  // Provider/closure doubles test the exact consumer contract; no process or physical closure is produced here.
  const launch:NativeLaunchObservation={owner:'execution:execution',launchId:randomUUID(),bootId:connection.bootId,
    guardian:{pid:200,startTicks:'2000'},provider:{pid:201,startTicks:'2001'},boundary:{kind:'cgroup-v2',path:'/unit/boundary',device:'1',inode:'2'},lifecycle:'active'}
  const registry=new NativeProcessRegistry('/unit/registry'),snapshot=vi.spyOn(registry,'snapshot').mockReturnValue({revision:'snapshot:1',launches:[launch]})
  return {connection,intent,session,launch,registry,snapshot}
}
async function sourceFixture(options: { relativeCwd?: string; harness?: 'codex' } = {}) {
  const relativeCwd = options.relativeCwd ?? ''
  const harness = options.harness ?? 'codex'
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
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: harness,
      driverRevision: '1', instanceId: randomUUID(), instanceRevision: '1', harnessInstallationId: `installed-${harness}`,
      installationFingerprint: 'a'.repeat(64), runtimeContractVersion: 1,
      protocolRevision: `${harness}-native-adapter-v1`, credentialScopeRefs: [] } })
  const intent=deriveDispatch(placement,{executionId:'execution',attemptId:'attempt',operationId:'operation',technicalAttempt:1,occurrenceId:null,occurrenceIndex:0,inputDigest:`sha256:${'b'.repeat(64)}`,owner:{grantId:'grant',epoch:'1'}})
  const attempt={executionId:intent.executionId,attemptId:intent.attemptId,keyRevision:1,authorizationRevision:1,placementHash:''}
  attempt.placementHash=sourceBindingHash(sourceRoot,attempt,intent.operationId)
  const receipt=await new PrivateSourceMaterializer({read:async()=>bytes},async()=>undefined).prepare({manifest,binding:sourceRoot.binding,attempt,signal:new AbortController().signal})
  const record:SourceMaterializationRecord={receipt,rootPolicyId,rootPolicyRevision:'1',operationId:intent.operationId,reservationId:randomUUID(),sourceBindingHash:attempt.placementHash,finalDispatchBindingHash:null,state:'prepared'}
  const workingTree=await verifyMaterializedWorkingDirectory(record,relativeCwd,async()=>undefined)
  const nativePlacement=bindNativeExecution(placement,intent,record,workingTree)
  nativePlacement.materialization.finalDispatchBindingHash=nativePlacement.bindingHash
  const owner:SourceOperationOwner={identity:{operationId:intent.operationId,ownerPrincipalId:'owner',expiresAt:'2099-01-01T00:00:00.000Z'},root:sourceRoot,attempt,source,record:nativePlacement.materialization,physicalClosureConfirmed:false}
  const sources=new SourceOperationWorkerService({mainNow:()=>Date.now(),authenticate:async()=>undefined,approvedRoots:async()=>approvedRoots,currentOwner:async()=>owner})
  const configuration: AgentConfigurationVersion = {
    id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1,
    prompt: { system: 'Unit workflow instructions.' }, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS[harness],
    contentHash: 'fixture', createdAt: new Date().toISOString(),
  }
  const request={executionId:intent.executionId,runId:intent.runId,workspaceId:'workspace',workflowNodeId:intent.nodeId,workingDirectory:workingTree.canonicalCwd,
    runtimeDirectory:join(runtime,'workflow-runs',intent.executionId,intent.attemptId),configuration,input:{}}
  return {root,approvedRoots,sources,owner,nativePlacement,intent,placement,request,context:{binding,signal:new AbortController().signal}}
}
async function physicalFixture(options: {
  artifacts?: WorkflowPhysicalArtifactsPort
  harness?: 'codex'
  phase?: 'session-created' | 'running'
} = {}) {
  const artifacts = options.artifacts
  const harness = options.harness ?? 'codex'
  const f = await sourceFixture({ harness })
  const n = nativeFixture(harness)
  const connection=DeviceConnectionIdentitySchema.parse({mainId:f.context.binding.mainId,deviceId:f.context.binding.deviceId,
    workerInstallationId:f.context.binding.workerInstallationId,keyRevision:f.context.binding.keyRevision,authorizationRevision:f.context.binding.authorizationRevision,
    bootId:f.context.binding.bootId,connectionGeneration:f.context.binding.connectionGeneration})
  const captured=captureInstalledWorkflowNativeOwner(n.registry,connection,f.intent,n.session)
  const journal=await RemoteOperationJournal.open(join(f.root,'physical-journal'),{initializeNewInstallation:true});journals.push(journal)
  await journal.accept(f.intent,connection,randomUUID());await journal.reserveEntry(f.intent.operationId)
  await journal.acknowledgeStart(f.intent.operationId,captured.native)
  if (options.phase !== 'session-created') {
    await journal.reserveTurn(f.intent.operationId, {
      correlationId: `execution:${f.intent.executionId}`, promptDigest: 'c'.repeat(64),
    })
    await journal.acknowledgeTurn(f.intent.operationId, 'original-turn')
    await journal.markRunning(f.intent.operationId)
  }
  const status=await journal.status(f.intent.operationId)
  if(status.status!=='known')throw new Error('Unit journal must retain its original receipt')
  const history={events:[],pendingInteractions:[],correlationId:`execution:${f.intent.executionId}`,
    ...(options.phase === 'session-created' ? {} : { nativeTurnId:'original-turn' })}
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
  const reservation=workflowNativeReservation({workspaceId:'workspace',workflowId:'workflow',runId:execution.runId,workflowVersionId:'version',executionSemanticsVersion:3},
    {nodeId:execution.workflowNodeId,occurrence:null},execution,repeatDigest(execution.input))
  const transition={phase:'entered' as const,reservation,ownerId:'original-owner',ownerFence:'1',launchDigest:`sha256:${'e'.repeat(64)}`}
  const entry={phase:'entered',reservation,reservation_digest:repeatDigest(reservation),transition,source_id:'actual-unit-entry',source_digest:repeatDigest(transition,8*1024*1024)}
  const lane={owner_agent_id:execution.agentId,harness:n.session.harness,native_session_id:n.session.nativeSessionId,generation:'2',token:lifetime.lane!.token as string|null,
    correlation:`execution:${execution.id}`,provider_id:'original-turn',held:true}
  const request=vi.fn(async(payload:unknown):Promise<DeviceApplicationResult>=>{void payload;return {payload:readout}})
  const currentBinding=vi.fn<()=>DeviceSessionBinding|undefined>(()=>f.context.binding)
  const canonicalProofs:{record:{execution:ReturnType<typeof repeatExecutionIdentity>;session:NativeSessionReference;
    original:WorkflowOriginalNativeSource;proofId?:string;settlementOf?:string}}[]=[]
  let proofReadLimit = Infinity
  const proofId = (original: WorkflowOriginalNativeSource) => workflowNativeSourceRecord(
    { ...lifetime, source: original } as unknown as WorkflowNativeCapture,
    { execution, ref: { nodeId: execution.workflowNodeId, occurrence: null } } as StoredRepeatExecution,
    reservation.scope, { ownerId: 'original-owner', fence: '1' },
  ).proofId
  // Authenticated carrier/SQL/process observations are explicit unit doubles.
  // The real source materialization/runtime directory above exercises FD/CWD receipts; no native or signed connection is produced.
  const producer=createRemoteWorkflowPhysicalVerification({...artifacts?{artifacts}:{},endpoint:()=>({currentBinding,captureRequest:()=>({binding:f.context.binding,request})})})
  const closure={generation:'1',expected_reference:n.session,closed_reference:null as NativeSessionReference|null,closed:false,detached:false,closed_without_session:false,execution_identity:null as unknown}
  const retained={proof:undefined as WorkflowNativeProofRecord|undefined,canonical:true,receipt:readout.receipt,accepted:false,
    inputBound:true,inputCanonical:true,entryCanonical:true,inputEffectDigest:repeatDigest('original input.bind')}
  const query=vi.fn(async(text:string,args:unknown[]=[])=>{
    if(['begin isolation level read committed','commit','rollback'].includes(text))return {rows:[],rowCount:0}
    if(text.includes('select r.id from runs r'))return {rows:[{id:f.intent.runId}],rowCount:1}
    if(text.includes('from execution_dispatch_intents'))return {rows:[{...f.intent,operation_id:f.intent.operationId,execution_id:f.intent.executionId,run_id:f.intent.runId,
      node_id:f.intent.nodeId,binding_hash:f.intent.bindingHash,attempt_id:f.intent.attemptId,record:f.intent}],rowCount:1}
    if(text.includes('remote_execution_owner_reconciliations'))return {rows:[],rowCount:0}
    if(text.includes('run_node_placements'))return {rows:[{record:f.placement}],rowCount:1}
    if(text.includes('execution_native_placements'))return {rows:[{record:f.nativePlacement}],rowCount:1}
    if(text.includes('source_execution_materializations'))return {rows:[{record:f.nativePlacement.materialization,state:f.nativePlacement.materialization.state}],rowCount:1}
    if(text.includes('remote_dispatch_origins'))return {rows:[{connection}],rowCount:1}
    if(text.includes('harness_executions'))return {rows:[{record:execution,accepted:retained.accepted,authorized:true}],rowCount:1}
    if(text.includes('workflow_native_entries'))return {rows:[entry],rowCount:1}
    if(text.includes('source_digest from workflow_native_proofs'))return {rows:retained.proof?[{record:retained.proof,source_digest:repeatDigest(retained.proof,4*1024*1024)}]:[],rowCount:retained.proof?1:0}
    if (text.includes('workflow_native_proofs')) {
      if (!Array.isArray(args[1]) && Array.isArray(args[2]) && args[2].length === 0) return { rows: [], rowCount: 0 }
      const id = (row: typeof canonicalProofs[number]) => row.record.proofId ?? proofId(row.record.original)
      const ids = new Set(canonicalProofs.map(id))
      const keys = args.flatMap(value => Array.isArray(value) ? value : [value])
      const indexed = keys.filter(value => typeof value === 'string' && ids.has(value))
      const byId = Array.isArray(args[1]) || typeof args[2] === 'string' || Array.isArray(args[2])
      const rows = canonicalProofs.filter(row => !byId || indexed.includes(id(row))
        || text.includes("record ? 'settlementOf'") && row.record.settlementOf
          && (Array.isArray(args[2]) ? args[2].includes(row.record.execution.executionId)
            : args[3] === true && args[0] === row.record.execution.executionId))
      if (rows.length > proofReadLimit) {
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      }
      return { rows: rows.map(row => ({ ...row, original: row.record.original })), rowCount: rows.length }
    }
    if(text.includes('execution_native_sessions'))return {rows:[{reference:n.session}],rowCount:1}
    if(text.includes('execution_native_closures'))return {rows:[closure],rowCount:1}
    if(text.includes('remote_execution_receipts'))return {rows:[{receipt:retained.receipt}],rowCount:1}
    if(text.includes('from run_repeat_effects'))return {rows:retained.inputBound?[{payload_digest:retained.inputEffectDigest}]:[],rowCount:retained.inputBound?1:0}
    if (text.includes('join run_graph_sources')) {
      const readReceipt = (parameters: unknown[]) => {
        const kind = parameters[1]
        let valid = retained.canonical && !!retained.proof
        if (kind === 'execution') valid = retained.entryCanonical
        if (kind === 'input_binding') valid = retained.inputCanonical
        let digest = retained.inputEffectDigest
        if (kind === 'execution') digest = entry.source_digest
        else if (kind !== 'input_binding') digest = repeatDigest(retained.proof, 4 * 1024 * 1024)
        return valid ? [{ workspace_id: 'workspace', workflow_id: 'workflow', workflow_version_id: 'version',
          execution_semantics_version: 3, protocol_version: 1, head_sequence: '2', source_digest: digest,
          source_semantic_digest: repeatDigest('semantic'), source_sequence: '2',
          effect_digest: parameters[4] ? digest : null,
          effect_semantic_digest: parameters[4] ? repeatDigest('semantic') : null,
          effect_sequence: parameters[4] ? '2' : null }] : []
      }
      if (text.trimStart().startsWith('select p.ordinal,')) {
        const requests = JSON.parse(String(args[0])) as Array<{ ordinal: number; run_id: string;
          source_kind: string; source_id: string; source_revision: string; effect_kind: string; entity_id: string }>
        const rows = requests.map(request => ({ ordinal: request.ordinal, receipts: readReceipt([
          request.run_id, request.source_kind, request.source_id, request.source_revision,
          request.effect_kind, request.entity_id,
        ]) }))
        return { rows, rowCount: rows.length }
      }
      const rows = readReceipt(args)
      return { rows, rowCount: rows.length }
    }
    if(text.includes('native_session_lanes'))return {rows:[lane],rowCount:1}
    throw new Error(`Unexpected physical SQL: ${text}`)
  })
  const sqlConnection=new ExclusiveGraphConnection({query} as unknown as pg.ClientBase,()=>{})
  const owner={runId:f.intent.runId,assertOwned:vi.fn(),readOneShotFence:vi.fn(async()=>({ownerId:'original-owner',fence:'1'}))} as unknown as Parameters<typeof producer.bind>[2]
  const originals=createRemoteNativeSourceChannel()
  let original:Parameters<typeof producer.bind>[0]|undefined
  const bind=async(observedSource: WorkflowOriginalNativeSource = source)=>{
    const prepared=await producer.prefetch(readout.receipt,f.placement,observedSource)
    await VerifiedRemoteEvidence.commit(readout.receipt,connection,{transaction:async(_operation,work)=>work({authority:async()=>({intent:f.intent,placement:f.placement,
      originalConnection:connection,originalIncarnationId:readout.receipt.workerIncarnationId,grantIsLive:true,lastSequence:0,lastReceipt:null,native:null,terminal:null}),
      reject:async()=>{throw new Error('Unit original receipt rejected')},accept:async verified=>{
        originals.observe(verified,observedSource,()=>{});original=originals.verify.read(originals.capture(f.intent.executionId,observedSource))
        producer.bind(original,prepared,owner,lifetime)
      }})})
    if(!original)throw new Error('Expected private unit original-source capability')
    return original
  }
  return {...f,registry:n.registry,snapshot:n.snapshot,session:n.session,launch:n.launch,connection,captured,journal,readout,source,execution,lifetime,
    entry,lane,request,currentBinding,producer,query,sqlConnection,owner,originals,bind,canonicalProofs,closure,retained,
    limitProofReads: (limit: number) => { proofReadLimit = limit } }
}

// Keep the verifier and retained-reviewer authority readers real; only the SQL boundary is doubled.
async function retainedReviewerFixture() {
  const f = await physicalFixture()
  const base = makeCurrentWorkflowFixture('physical-reviewer', 'approval')
  const result = { outcome: 'succeeded' as const, output: { text: 'Workflow complete' } }
  Object.assign(f.execution, { state: 'completed', result, finishedAt: new Date().toISOString() })
  const history = { ...f.source.history, terminalTurn: {
    correlationId: `execution:${f.execution.id}`, providerId: 'original-turn', result,
  } }
  await f.journal.retainReviewer(f.intent.operationId, {
    agentId: f.execution.agentId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, history)
  const status = await f.journal.status(f.intent.operationId)
  if (status.status !== 'known') throw new Error('Expected retained reviewer receipt')
  f.readout.receipt = status.receipt
  f.readout.history = history
  f.source.history = history
  f.retained.receipt = status.receipt
  const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: f.execution.agentId }
  const otherConfigurationIds = Object.fromEntries(Object.entries(base.version.agentConfigurationVersionIds)
    .filter(([agentId]) => agentId !== base.configurations[0]!.agentId))
  const configurationIds = { ...otherConfigurationIds,
    [f.execution.agentId]: f.execution.agentConfigurationVersionId }
  const entryId = base.version.entryNodeId
  const version = { ...base.version, entryNodeId: f.execution.workflowNodeId, approval,
    agentConfigurationVersionIds: configurationIds, definition: { ...base.version.definition,
      entryNodeId: f.execution.workflowNodeId, approval,
      nodes: base.version.definition.nodes.map(node => node.id === entryId
        ? { ...node, id: f.execution.workflowNodeId, agentId: f.execution.agentId } : node),
      edges: base.version.definition.edges.map(edge => ({ ...edge,
        source: edge.source === entryId ? f.execution.workflowNodeId : edge.source })),
    } }
  const run = { ...base.run, id: f.execution.runId, executionState: 'running', approval,
    agentConfigurationVersionIds: configurationIds }
  const configuration = { ...base.configurations[0]!, id: f.execution.agentConfigurationVersionId,
    agentId: f.execution.agentId }
  const principal = { id: 'reviewer-principal', name: 'Reviewer', audience: 'worker', agent_id: f.execution.agentId,
    expires_at: new Date(Date.now() + 60_000), revoked_at: null as Date | null,
    grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: {
      workspaceIds: [run.workspaceId], workflowIds: [run.workflowId], runIds: [run.id],
    } }] }
  const reviewer = { generation: '1', session: f.session, executionId: f.execution.id }
  let authorityReads = 0
  const rows = (values: unknown[]) => ({ rows: values, rowCount: values.length })
  const baseQuery = f.query.getMockImplementation()!
  const query = async (text: string, args: unknown[] = []) => {
    if (text.includes('select r.record as run,v.record as version')) {
      authorityReads++
      return rows([{ run, version, execution: f.execution, configuration, reference: reviewer.session, finalized: true }])
    }
    if (text.includes('from harness_executions')) return rows([{ record: f.execution, authorized: false }])
    if (text.includes('c.detached_at is not null as detached')) {
      return rows([{ generation: reviewer.generation, live: true, detached: false, reference: reviewer.session }])
    }
    if (text.startsWith('select 1 from workflow_native_proofs')) return rows([{}])
    if (text.startsWith('select b.principal_id')) {
      return rows(args[0] === reviewer.executionId ? [{ principal_id: principal.id }] : [])
    }
    if (text.startsWith('select id,name,audience')) return rows([principal])
    return baseQuery(text, args)
  }
  await f.sqlConnection.close()
  const sqlConnection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
  const original = await f.bind()
  const verify = () => sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
  return { ...f, sqlConnection, principal, reviewer, verify, authorityReads: () => authorityReads }
}

describe('retained reviewer authorization for original workflow sources', () => {
  it('allows a live reviewer after its workflow credential has been promoted', async () => {
    const f = await retainedReviewerFixture()
    try {
      await expect(f.verify()).resolves.toBeUndefined()
      expect(f.authorityReads()).toBeGreaterThan(0)
    } finally { await f.sqlConnection.close() }
  })

  it.each([
    ['revoked', 'REVIEWER_CREDENTIAL_LOST'],
    ['expired', 'REVIEWER_CREDENTIAL_LOST'],
    ['wrong-generation', 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'],
    ['wrong-session', 'REMOTE_REVIEWER_DENIED'],
    ['cross-execution', 'REMOTE_REVIEWER_DENIED'],
  ] as const)('denies a %s reviewer when workflow authorization is absent', async (defect, code) => {
    const f = await retainedReviewerFixture()
    try {
      // Establish that this exact original source can use the fallback before invalidating its authority.
      await f.verify()
      if (defect === 'revoked') f.principal.revoked_at = new Date()
      if (defect === 'expired') f.principal.expires_at = new Date(Date.now() - 1_000)
      if (defect === 'wrong-generation') f.reviewer.generation = '2'
      if (defect === 'wrong-session') f.reviewer.session = { ...f.session, nativeSessionId: 'different-session' }
      if (defect === 'cross-execution') f.reviewer.executionId = 'different-execution'
      await expect(f.verify()).rejects.toMatchObject({ code,
        ...(defect === 'wrong-generation' ? { details: { reason: 'execution_authorization' } } : {}),
      })
      expect(f.authorityReads()).toBeGreaterThan(0)
    } finally { await f.sqlConnection.close() }
  })
})

it('acknowledges an original history without scanning unrelated retained histories', async () => {
  const f = await physicalFixture()
  try {
    const original = await f.bind()
    for (let index = 0; index < 40; index += 1) {
      f.canonicalProofs.push({ record: { execution: repeatExecutionIdentity(f.execution), session: f.session,
        original: { type: 'history', history: { ...f.source.history, nativeTurnId: `earlier-turn-${index}` } } } })
    }
    f.canonicalProofs.push({ record: {
      execution: repeatExecutionIdentity(f.execution), session: f.session, original: f.source,
    } })
    f.limitProofReads(1)
    await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
    const ack = { version: 1, operationId: f.intent.operationId, receiptSequence: f.readout.receipt.sequence,
      sourceDigest: original.sourceDigest, status: 'retired' }
    f.request.mockResolvedValueOnce({ payload: ack })
    await expect(f.producer.acknowledge(original)).resolves.toEqual(ack)
  } finally { await f.sqlConnection.close() }
})
// Real private directories and original capability; SQL/carrier/process boundaries
// are unit doubles. These fixtures never establish physical qualification.
async function terminalFixture(harness: 'codex' = 'codex') {
  const artifacts={assertPublications:vi.fn(async()=>{}),assertAdopted:vi.fn(async()=>{})}
  const f=await physicalFixture({ artifacts, harness })
  const artifactOutputs={version:1 as const,outputs:[{outputKey:'report',commandId:randomUUID()}]}
  const result={outcome:'succeeded' as const,output:{text:JSON.stringify({data:{original:true},artifactOutputs})}}
  const history={...f.source.history,terminalTurn:{correlationId:`execution:${f.execution.id}`,providerId:'original-turn',result}}
  await f.journal.terminal(f.intent.operationId,{kind:'completed',result,
    resultDigest:commandInputHash(result).slice('sha256:'.length),artifactDigests:['a'.repeat(64)],
    closureEvidenceDigest:commandInputHash({intent:f.intent,native:f.readout.receipt.native,launch:f.captured.launch,physicalOwnerClosed:true}).slice('sha256:'.length)})
  const status=await f.journal.status(f.intent.operationId)
  if(status.status!=='known')throw new Error('Expected unit original terminal')
  f.readout.receipt=status.receipt;f.retained.receipt=status.receipt
  f.readout.history=history;f.source.history=history
  f.readout.observation=RemoteWorkflowPhysicalReadoutSchema.shape.observation.parse({...f.captured.launch,lifecycle:'closed',closureEvidence:'cgroup_v2_empty'})
  f.readout.closure={ownerClosed:true,launch:f.readout.observation}
  f.readout.output={kind:'published-artifacts',result,artifactOutputs}
  const original=await f.bind()
  const capture:WorkflowNativeCapture={kind:'live',observedAt:f.execution.createdAt,owner:f.owner,...f.lifetime,source:f.source,assertCurrent:vi.fn()}
  const proof:WorkflowNativeProofRecord={proofId:randomUUID(),scope:{workspaceId:'workspace',workflowId:'workflow',runId:f.execution.runId,
    workflowVersionId:'version',executionSemanticsVersion:3},ref:{nodeId:f.execution.workflowNodeId,occurrence:null},
    execution:repeatExecutionIdentity(f.execution),inputDigest:repeatDigest(f.execution.input),commandId:`execution:${f.execution.id}`,
    session:f.session,original:f.source,observedAt:f.execution.createdAt,ownerId:'original-owner',ownerFence:'1',
    lifetimeGeneration:1,closureGeneration:'1',lane:f.lifetime.lane}
  f.retained.proof=structuredClone(proof);f.canonicalProofs.push({record:{execution:proof.execution,session:proof.session,original:f.source}})
  const retain=()=>f.sqlConnection.transaction(sql=>f.producer.artifactTerminalContext(sql,f.owner,original,capture,proof))
  const complete=()=>{
    f.execution.state='completed';f.execution.result=result;f.execution.finishedAt=new Date().toISOString()
    f.closure.closed=true;f.closure.closed_reference=f.session
    const e=f.execution
    f.closure.execution_identity={id:e.id,runId:e.runId,workflowNodeId:e.workflowNodeId,agentId:e.agentId,
      agentConfigurationVersionId:e.agentConfigurationVersionId,attempt:e.attempt,workingDirectory:e.workingDirectory,runtimeDirectory:e.runtimeDirectory}
    f.lane.held=false;f.lane.token=null
    vi.mocked(f.lifetime.assertCurrent).mockImplementation(()=>{throw new Error('Original live lifetime ended')})
    vi.mocked(capture.assertCurrent).mockImplementation(()=>{throw new Error('Original live capture ended')})
  }
  return {...f,artifacts,result,original,capture,proof,retain,complete}
}

async function closeTextOnlyFixture(f: Awaited<ReturnType<typeof physicalFixture>>, disposition: 'completed' | 'stopped') {
  const result = { outcome: 'succeeded' as const, output: { text: 'Original provider output' } }
  if (disposition === 'stopped') await f.journal.revokeFence(f.intent.operationId)
  const closureEvidenceDigest = commandInputHash({
    intent: f.intent, native: f.readout.receipt.native, launch: f.captured.launch, physicalOwnerClosed: true,
  }).slice('sha256:'.length)
  const terminal = disposition === 'completed'
    ? { kind: 'completed' as const, result, resultDigest: commandInputHash(result).slice('sha256:'.length),
      closureEvidenceDigest }
    : { kind: 'cancelled' as const, closureEvidenceDigest }
  await f.journal.terminal(f.intent.operationId, terminal)
  const status = await f.journal.status(f.intent.operationId)
  if (status.status !== 'known') throw new Error('Expected original terminal receipt')
  f.readout.receipt = status.receipt
  f.retained.receipt = status.receipt
  f.readout.observation = { ...f.readout.observation, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }
  f.readout.closure = { ownerClosed: true, launch: f.readout.observation }
  if (disposition === 'completed') {
    const history = { ...f.source.history, terminalTurn: {
      correlationId: `execution:${f.execution.id}`, providerId: 'original-turn', result,
    } }
    f.readout.history = history
    f.source.history = history
    f.readout.output = { kind: 'text-only', result }
  }
}

it('recovers closure only from the captured closed original session', async () => {
  const f = await physicalFixture()
  const active = await f.producer.prefetch(f.readout.receipt, f.placement, f.source)
  expect(f.producer.confirmedClosed(active, f.session)).toBe(false)
  expect(f.producer.confirmedClosed(active, null)).toBe(false)
  await closeTextOnlyFixture(f, 'stopped')
  const closed = await f.producer.prefetch(f.readout.receipt, f.placement, f.source)
  expect(f.producer.confirmedClosed(closed, f.session)).toBe(true)
  expect(f.producer.confirmedClosed(closed, null)).toBe(true)
  expect(f.producer.confirmedClosed(closed, { ...f.session, nativeSessionId: 'different-session' })).toBe(false)
  f.currentBinding.mockReturnValue(undefined)
  expect(() => f.producer.confirmedClosed(closed, f.session)).toThrow()
})

describe('accepted physical session harness', () => {
  it.each(['codex'] as const)('verifies the installed %s session before its first turn', async harness => {
    const f = await physicalFixture({ harness, phase: 'session-created' })
    try {
      expect(f.readout.receipt.native?.turnId).toBeUndefined()
      const original = await f.bind({ type: 'session_created', session: f.session })
      await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
      expect(original.source).toEqual({ type: 'session_created', session: f.session })
    } finally { await f.sqlConnection.close() }
  })

  it('verifies an observed native boundary that has no retained source proof', async () => {
    const f = await physicalFixture({ harness: 'codex' })
    try {
      const original = await f.bind({ type: 'boundary' })
      await expect(f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))).resolves.toBeUndefined()
      expect(original.source).toEqual({ type: 'boundary' })
    } finally { await f.sqlConnection.close() }
  })

  it('keeps the accepted Codex process available to its running Main owner', async () => {
    const f = await physicalFixture({ harness: 'codex' })
    try {
      const original = await f.bind()
      await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
      const owner = f.producer.passiveNativeOwner(original)
      expect(owner).toMatchObject({ nativeOwner: 'execution:execution', native: f.readout.receipt.native })
      owner!.assertCurrent()
    } finally { await f.sqlConnection.close() }
  })

  it.each(['codex'] as const)('verifies %s completion with the original result and owner closure', async harness => {
    const f = await physicalFixture({ harness })
    try {
      await closeTextOnlyFixture(f, 'completed')
      const original = await f.bind()
      await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
      expect(original.verified.receipt.terminal).toMatchObject({
        kind: 'completed', result: { outcome: 'succeeded', output: { text: 'Original provider output' } },
      })
    } finally { await f.sqlConnection.close() }
  })

  it.each(['codex'] as const)('verifies %s Stop after the original owner closes', async harness => {
    const f = await physicalFixture({ harness })
    try {
      await closeTextOnlyFixture(f, 'stopped')
      const original = await f.bind()
      await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
      expect(original.verified.receipt.stopFence).toBeTruthy()
      expect(original.verified.receipt.terminal?.kind).toBe('cancelled')
      expect(original.verified.receipt.terminal?.result).toBeUndefined()
    } finally { await f.sqlConnection.close() }
  })

  it('keeps Codex artifact completion verifiable after its Main lifetime and lane release', async () => {
    const f = await terminalFixture('codex')
    try {
      await f.retain()
      f.complete()
      await f.sqlConnection.transaction(sql => f.producer.assertArtifactTerminal(sql, f.owner, f.capture, f.proof))
      await f.sqlConnection.transaction(sql => f.producer.assertAdoptedArtifacts(sql, f.owner, f.original))
      expect(f.artifacts.assertAdopted).toHaveBeenCalledTimes(2)
    } finally { await f.sqlConnection.close() }
  })

  it.each(['codex'] as const)('rejects a different session harness for accepted %s placement', async harness => {
    const f = await physicalFixture({ harness })
    try {
      f.readout.session = { ...f.session, harness: 'claude' }
      await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source)).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'harness_binding' },
      })
    } finally { await f.sqlConnection.close() }
  })

  it.each(['session', 'owner', 'provider', 'boundary'] as const)('preserves the Codex %s identity check', async identity => {
    const f = await physicalFixture({ harness: 'codex' })
    try {
      if (identity === 'session') f.readout.session.nativeSessionId = 'replacement-session'
      if (identity === 'owner') f.readout.observation.owner = 'execution:replacement'
      if (identity === 'provider') f.readout.observation.provider = { pid: 201, startTicks: '2002' }
      if (identity === 'boundary') f.readout.observation.boundary = { ...f.readout.observation.boundary, inode: '3' }
      await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source)).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'process_identity' },
      })
    } finally { await f.sqlConnection.close() }
  })

  it('rejects Codex completion when the output differs from the original provider result', async () => {
    const f = await physicalFixture({ harness: 'codex' })
    try {
      await closeTextOnlyFixture(f, 'completed')
      f.readout.output = { kind: 'text-only', result: { outcome: 'succeeded', output: { text: 'Replacement output' } } }
      await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source)).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'terminal_result' },
      })
    } finally { await f.sqlConnection.close() }
  })

  it('rejects Codex Stop without positive original owner closure', async () => {
    const f = await physicalFixture({ harness: 'codex' })
    try {
      await closeTextOnlyFixture(f, 'stopped')
      delete f.readout.closure
      await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source)).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'terminal_closure' },
      })
    } finally { await f.sqlConnection.close() }
  })
})

describe('original published-artifact terminal physical companion',()=>{
  it('verifies the first original running physical capture before any terminal result exists',async()=>{
    const f=await physicalFixture()
    try {
      expect(f.retained.accepted).toBe(false);expect(f.execution.result).toBeUndefined()
      const original=await f.bind()
      await f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))
      expect(f.request).toHaveBeenCalledOnce()
    }finally{await f.sqlConnection.close()}
  })
  it('retains running and unaccepted SQL proof without requiring an adopted mapping or result acceptance',async()=>{
    const f=await terminalFixture()
    try {
      expect(f.execution.state).toBe('running')
      expect(f.retained.accepted).toBe(false)
      expect(await f.retain()).toMatchObject({mainId:f.context.binding.mainId,deviceId:f.context.binding.deviceId})
      expect(f.artifacts.assertAdopted).not.toHaveBeenCalled()
      expect(f.request).toHaveBeenCalledOnce()
    }finally{await f.sqlConnection.close()}
  })
  it('verifies committed completed but unaccepted SQL before adoption after original lifetime and lane release',async()=>{
    const f=await terminalFixture()
    try {
      await f.retain()
      f.complete()
      expect(f.execution.state).toBe('completed');expect(f.retained.accepted).toBe(false)
      await f.sqlConnection.transaction(sql=>f.producer.assertArtifactTerminal(sql,f.owner,f.capture,f.proof))
      await f.sqlConnection.transaction(sql=>f.producer.assertAdoptedArtifacts(sql,f.owner,f.original))
      expect(f.artifacts.assertAdopted).toHaveBeenCalledTimes(2)
      expect(f.request).toHaveBeenCalledOnce()
    }finally{await f.sqlConnection.close()}
  })
  it('replays the same original proof and durable output gate after terminal result acceptance',async()=>{
    const f=await terminalFixture()
    try {
      await f.retain();f.complete()
      await f.sqlConnection.transaction(sql=>f.producer.assertArtifactTerminal(sql,f.owner,f.capture,f.proof))
      f.retained.accepted=true
      await f.sqlConnection.transaction(sql=>f.producer.assertArtifactTerminal(sql,f.owner,f.capture,f.proof))
      await f.sqlConnection.transaction(sql=>f.producer.assertAdoptedArtifacts(sql,f.owner,f.original))
      expect(f.execution.result).toEqual(f.result);expect(f.request).toHaveBeenCalledOnce()
    }finally{await f.sqlConnection.close()}
  })
  it.each(['input-bind','input-canonical','entry-canonical','reservation','input-digest','occurrence'] as const)(
    'requires genuine original %s admission before physical proof even when result accepted is true',async defect=>{
      const f=await terminalFixture()
      try {
        f.retained.accepted=true
        if(defect==='input-bind')f.retained.inputBound=false
        if(defect==='input-canonical')f.retained.inputCanonical=false
        if(defect==='entry-canonical')f.retained.entryCanonical=false
        if(defect==='reservation')f.entry.reservation_digest=repeatDigest('foreign reservation')
        if(defect==='input-digest')f.entry.reservation.inputDigest=repeatDigest('replacement input')
        if(defect==='occurrence'){
          f.entry.reservation.ref.occurrence={scope:f.entry.reservation.scope,blockId:'foreign',occurrenceId:'foreign',occurrenceIndex:1}
          f.entry.reservation_digest=repeatDigest(f.entry.reservation);f.entry.source_digest=repeatDigest(f.entry.transition,8*1024*1024)
        }
        await expect(f.retain()).rejects.toThrow();expect(f.request).toHaveBeenCalledOnce()
      }finally{await f.sqlConnection.close()}
    })
  it('requires a committed first witness and rejects rollback even if the original failure was caught',async()=>{
    const f=await terminalFixture()
    try {
      await expect(f.sqlConnection.transaction(async sql=>{
        await f.producer.artifactTerminalContext(sql,f.owner,f.original,f.capture,f.proof)
        await expect(f.producer.assertArtifactTerminal(sql,f.owner,f.capture,f.proof)).rejects.toThrow()
      })).rejects.toThrow()
      f.complete()
      await expect(f.sqlConnection.transaction(sql=>f.producer.assertArtifactTerminal(sql,f.owner,f.capture,f.proof))).rejects.toThrow()
    }finally{await f.sqlConnection.close()}
  })
  it('does not treat a committed running row as the persisted completed result',async()=>{
    const f=await terminalFixture()
    try {await f.retain();await expect(f.sqlConnection.transaction(sql=>f.producer.assertArtifactTerminal(sql,f.owner,f.capture,f.proof))).rejects.toThrow()}
    finally{await f.sqlConnection.close()}
  })
  it.each(['detached','unproven-close','changed-close','generation','lane-generation','new-lane-token','device','session','runtime','execution-input',
    'result','canonical-receipt','remote-receipt','proof','capture','owner-fence','publication'] as const)('rejects retained %s substitution without native IO',async defect=>{
    const f=await terminalFixture()
    try {
      await f.retain();f.complete()
      let capture=f.capture,proof=f.proof
      if(defect==='detached')f.closure.detached=true
      if(defect==='unproven-close'){f.closure.closed=false;f.closure.closed_reference=null}
      if(defect==='changed-close')f.closure.closed_reference={...f.session,nativeSessionId:'replacement'}
      if(defect==='generation')f.closure.generation='2'
      if(defect==='lane-generation')f.lane.generation='3'
      if(defect==='new-lane-token')f.lane.token='replacement-token'
      if(defect==='device')f.currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
      if(defect==='session')f.lane.native_session_id='replacement'
      if(defect==='runtime')f.execution.runtimeDirectory='/replacement/runtime'
      if(defect==='execution-input')f.execution.input={replacement:true}
      if(defect==='result')f.execution.result={outcome:'succeeded',output:{text:'replacement'}}
      if(defect==='canonical-receipt')f.retained.canonical=false
      if(defect==='remote-receipt')f.retained.receipt={...f.retained.receipt,sequence:f.retained.receipt.sequence+1}
      if(defect==='proof')proof={...proof,proofId:randomUUID()}
      if(defect==='capture')capture={...capture}
      if(defect==='owner-fence')vi.spyOn(f.owner,'readOneShotFence').mockResolvedValue({ownerId:'replacement-owner',fence:'2'})
      if(defect==='publication')f.artifacts.assertPublications.mockRejectedValue(new Error('Original canonical publication missing'))
      await expect(f.sqlConnection.transaction(sql=>f.producer.assertArtifactTerminal(sql,f.owner,capture,proof))).rejects.toThrow()
      expect(f.request).toHaveBeenCalledOnce()
    }finally{await f.sqlConnection.close()}
  })
  it('rechecks the actual binding at COMMIT and poisons failed final adoption',async()=>{
    const f=await terminalFixture()
    try {
      await f.retain();f.complete()
      await expect(f.sqlConnection.transaction(async sql=>{
        await f.producer.assertArtifactTerminal(sql,f.owner,f.capture,f.proof)
        f.currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
      })).rejects.toThrow()
      f.currentBinding.mockReturnValue(f.context.binding)
      f.artifacts.assertAdopted.mockRejectedValue(new Error('W09 map absent'))
      await expect(f.sqlConnection.transaction(async sql=>{
        await expect(f.producer.assertAdoptedArtifacts(sql,f.owner,f.original)).rejects.toThrow('W09 map absent')
      })).rejects.toThrow()
    }finally{await f.sqlConnection.close()}
  })
})

async function publishPhysicalObservation(f: Awaited<ReturnType<typeof physicalFixture>>) {
  const original = await f.bind()
  f.canonicalProofs.push({ record: {
    execution: repeatExecutionIdentity(f.execution), session: f.session, original: f.source,
  } })
  await f.sqlConnection.transaction(sql => f.producer.assertOriginal(sql, f.owner, original))
  return original
}

it.each(['device', 'domain'] as const)('propagates a displaced %s selector without retrying it', async kind => {
  const f = await physicalFixture()
  const expired = kind === 'device' ? new DeviceApplicationError('REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED')
    : new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'Reply displaced', 409, { reason: 'not_retained' })
  try {
    vi.useFakeTimers()
    f.request.mockRejectedValue(expired)
    const outcome = f.producer.prefetch(f.readout.receipt, f.placement, f.source)
      .then(() => undefined, error => error)
    await vi.runAllTimersAsync()
    expect(await outcome).toBe(expired)
    expect(f.request).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers(); await f.sqlConnection.close() }
})

describe('physical acknowledgment retry eligibility', () => {
  it.each(['single', 'batch'] as const)(
    'retires and releases changed terminal history retained by settlement: %s', async mode => {
      const f = await physicalFixture()
      try {
        await closeTextOnlyFixture(f, 'completed')
        f.execution.state = 'completed'
        f.execution.result = f.readout.output!.result
        f.execution.finishedAt = new Date().toISOString()
        const sourceRecord = () => workflowNativeSourceRecord({ ...f.lifetime, source: f.source,
          owner: f.owner, kind: 'live', observedAt: f.execution.finishedAt } as WorkflowNativeCapture,
        { execution: f.execution, ref: { nodeId: f.execution.workflowNodeId, occurrence: null },
          inputDigest: repeatDigest(f.execution.input) } as StoredRepeatExecution,
        f.entry.reservation.scope, { ownerId: 'original-owner', fence: '1' })
        const initial = structuredClone(sourceRecord())
        Object.assign(f.source.history, { nextCursor: 'settled-history' })
        const settlement = { ...structuredClone(sourceRecord()),
          proofId: randomUUID(), settlementOf: initial.proofId }
        expect(settlement.original).not.toEqual(initial.original)
        f.canonicalProofs.push({ record: initial }, { record: settlement })
        const saved = structuredClone(f.canonicalProofs)
        const original = await f.bind()
        await f.sqlConnection.transaction(sql => mode === 'single'
          ? f.producer.assertOriginal(sql, f.owner, original)
          : f.producer.assertOriginals(sql, f.owner, [original]))
        const ack = { version: 1, operationId: f.intent.operationId,
          receiptSequence: f.readout.receipt.sequence, sourceDigest: original.sourceDigest, status: 'retired' }
        f.request.mockResolvedValueOnce({ payload: ack })
        await expect(f.producer.acknowledge(original)).resolves.toEqual(ack)
        expect(f.request).toHaveBeenLastCalledWith({ method: 'physical-ack', intent: f.readout.receipt.intent,
          placement: f.placement, receiptSequence: f.readout.receipt.sequence,
          sourceDigest: original.sourceDigest, retire: true }, { timeoutMs: deviceRequestTimeoutMs })
        expect(f.producer.releaseExecution(original)).toBe(true)
        expect(f.canonicalProofs).toEqual(saved)
      } finally { await f.sqlConnection.close() }
    },
  )

  it.each(['running', 'rolled-back', 'completed'] as const)(
    'retires terminal history only after its matching execution result commits: %s', async state => {
      const f = await physicalFixture()
      try {
        await closeTextOnlyFixture(f, 'completed')
        const original = await publishPhysicalObservation(f)
        if (state !== 'running') {
          f.execution.state = 'completed'
          f.execution.result = f.readout.output!.result
          f.execution.finishedAt = new Date().toISOString()
          const transaction = f.sqlConnection.transaction(async sql => {
            await f.producer.assertOriginal(sql, f.owner, original)
            if (state === 'rolled-back') throw new Error('Terminal update rolled back')
          })
          if (state === 'rolled-back') await expect(transaction).rejects.toThrow('Terminal update rolled back')
          else await transaction
        }
        const ack = { version: 1, operationId: f.intent.operationId,
          receiptSequence: f.readout.receipt.sequence, sourceDigest: original.sourceDigest, status: 'retired' }
        f.request.mockResolvedValueOnce({ payload: ack })
        await expect(f.producer.acknowledge(original)).resolves.toEqual(ack)
        expect(f.request).toHaveBeenLastCalledWith({ method: 'physical-ack', intent: f.readout.receipt.intent,
          placement: f.placement, receiptSequence: f.readout.receipt.sequence, sourceDigest: original.sourceDigest,
          ...(state === 'completed' ? { retire: true } : {}) }, { timeoutMs: deviceRequestTimeoutMs })
      } finally { await f.sqlConnection.close() }
    },
  )

  it('acknowledges a committed observation after Main outlasts its original window', async () => {
    const f = await physicalFixture()
    try {
      const original = await publishPhysicalObservation(f)
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.readout.expiresAt) + 1)
      const ack = { version: 1, operationId: f.intent.operationId,
        receiptSequence: f.readout.receipt.sequence, sourceDigest: original.sourceDigest, status: 'retired' }
      f.request.mockResolvedValue({ payload: ack })
      await expect(f.producer.acknowledge(original)).resolves.toEqual(ack)
      await expect(f.producer.acknowledgeReply(original)).resolves.toEqual(ack)
      expect(f.request).toHaveBeenCalledTimes(3)
    } finally { await f.sqlConnection.close() }
  })

  it('retires an observation after connection replacement without sending an ACK', async () => {
    const f = await physicalFixture()
    try {
      const original = await publishPhysicalObservation(f)
      f.currentBinding.mockReturnValue({ ...f.context.binding, connectionGeneration: 4 })
      await expect(f.producer.acknowledge(original)).rejects.toMatchObject({ code: 'REMOTE_NATIVE_ACK_OBSOLETE' })
      await expect(f.producer.acknowledgeReply(original)).rejects.toMatchObject({ code: 'REMOTE_NATIVE_ACK_OBSOLETE' })
      expect(f.request).toHaveBeenCalledOnce()
    } finally { await f.sqlConnection.close() }
  })

  it('keeps a disconnected observation retryable while its original binding and proof remain valid', async () => {
    const f = await physicalFixture()
    try {
      const original = await publishPhysicalObservation(f)
      f.currentBinding.mockReturnValue(undefined)
      await expect(f.producer.acknowledge(original)).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'connection_expired' },
      })
      expect(f.request).toHaveBeenCalledOnce()
      f.currentBinding.mockReturnValue(f.context.binding)
      const ack = { version: 1, operationId: f.intent.operationId,
        receiptSequence: f.readout.receipt.sequence, sourceDigest: original.sourceDigest, status: 'retired' }
      f.request.mockRejectedValueOnce(new Error('Temporary transport failure'))
      await expect(f.producer.acknowledge(original)).rejects.toThrow('Temporary transport failure')
      f.request.mockResolvedValueOnce({ payload: ack })
      await expect(f.producer.acknowledge(original)).resolves.toEqual(ack)
      expect(f.request).toHaveBeenLastCalledWith({ method: 'physical-ack', intent: f.readout.receipt.intent,
        placement: f.placement, receiptSequence: f.readout.receipt.sequence, sourceDigest: original.sourceDigest }, { timeoutMs: deviceRequestTimeoutMs })
    } finally { await f.sqlConnection.close() }
  })

  it('requires committed publication even when an observation has expired', async () => {
    const f = await physicalFixture()
    try {
      const original = await f.bind()
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.readout.expiresAt) + 1)
      await expect(f.producer.acknowledge(original)).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'uncommitted_publication' },
      })
      expect(f.request).toHaveBeenCalledOnce()
    } finally { await f.sqlConnection.close() }
  })
})

async function bindRemoteEvent(f: Awaited<ReturnType<typeof physicalFixture>>, source: WorkflowOriginalNativeSource) {
  const prepared = await f.producer.prefetch(f.readout.receipt, f.placement, source)
  let evidence: RemoteNativeSourceEvidence | undefined
  await VerifiedRemoteEvidence.commit(f.readout.receipt, f.connection, { transaction: async (_operation, work) => work({
    authority: async () => ({ intent: f.intent, placement: f.placement, originalConnection: f.connection,
      originalIncarnationId: f.readout.receipt.workerIncarnationId, grantIsLive: true, lastSequence: 0, lastReceipt: null,
      native: null, terminal: null }),
    reject: async () => { throw new Error('Unit original receipt rejected') },
    accept: async verified => {
      f.originals.observe(verified, source, () => {})
      evidence = f.originals.capture(f.execution.id, source)
      f.producer.bind(f.originals.verify.read(evidence), prepared, f.owner, f.lifetime)
    } }) })
  if (!evidence) throw new Error('Expected private unit original-source evidence')
  return evidence
}

describe('remote history publication under the Run lock', () => {
  it('verifies every event of one remote history without repeating the shared binding reads per event', async () => {
    const f = await physicalFixture()
    try {
      const events = Array.from({ length: 24 }, (_, sequence) => ({ sequence, type: 'item.completed',
        occurredAt: f.execution.createdAt, payload: { index: sequence } }))
      f.readout.history = { ...f.readout.history!, events }
      const sources = events.map(event => ({ type: 'event' as const, event: { ...event, executionId: f.execution.id } }))
      const evidences: RemoteNativeSourceEvidence[] = []
      for (const source of sources) evidences.push(await bindRemoteEvent(f, source))
      for (const source of sources) {
        f.canonicalProofs.push({ record: { execution: repeatExecutionIdentity(f.execution), session: f.session, original: source as never } })
      }
      // The canonical writer verifies each capture, then checks it again before COMMIT.
      const publish = async (count: number) => {
        f.query.mockClear()
        await f.sqlConnection.transaction(async sql => {
          for (const evidence of evidences.slice(0, count)) {
            const verify = () => assertRemoteNativeSourceLocked(sql, f.owner, f.execution,
              f.originals.verify.read(evidence).source, evidence, f.originals.verify, f.producer)
            await verify()
            beforeGraphCommit(sql, verify)
          }
        })
        return f.query.mock.calls.length
      }
      const one = await publish(1)
      const all = await publish(events.length)
      expect(all - one).toBeLessThanOrEqual((events.length - 1) * 6)
      const last = f.originals.verify.read(evidences.at(-1)!)
      const ack = { version: 1, operationId: f.intent.operationId, receiptSequence: f.readout.receipt.sequence,
        sourceDigest: last.sourceDigest, status: 'retired' }
      f.request.mockResolvedValueOnce({ payload: ack })
      await expect(f.producer.acknowledge(last)).resolves.toEqual(ack)
    } finally { await f.sqlConnection.close() }
  })

  it('still rejects at COMMIT when the shared binding changes after the first event was verified', async () => {
    const f = await physicalFixture()
    try {
      const events = Array.from({ length: 3 }, (_, sequence) => ({ sequence, type: 'item.completed',
        occurredAt: f.execution.createdAt, payload: { index: sequence } }))
      f.readout.history = { ...f.readout.history!, events }
      const evidences: RemoteNativeSourceEvidence[] = []
      for (const event of events) evidences.push(await bindRemoteEvent(f, { type: 'event', event: { ...event, executionId: f.execution.id } }))
      await expect(f.sqlConnection.transaction(async sql => {
        for (const evidence of evidences) {
          await assertRemoteNativeSourceLocked(sql, f.owner, f.execution,
            f.originals.verify.read(evidence).source, evidence, f.originals.verify, f.producer)
        }
        f.closure.detached = true
      })).rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'closure_generation' } })
    } finally { await f.sqlConnection.close() }
  })
})


it('retains every remote frame and acknowledges a large reply with one grouped proof read', async () => {
  const f = await physicalFixture()
  try {
    const events = Array.from({ length: 16 }, (_, sequence) => ({
      connectionId: 'connection', sequence,
      type: 'native.notification', occurredAt: f.execution.createdAt,
      payload: { nativeMethod: 'item/agentMessage/delta', text: `frame ${sequence}` },
    }))
    f.readout.history!.events = events
    const originals: Awaited<ReturnType<typeof f.bind>>[] = []
    for (const event of events) {
      const source = { type: 'event' as const, event: { ...event, executionId: f.execution.id } }
      const original = await f.bind(source)
      originals.push(original)
      const record = workflowNativeSourceRecord({ ...f.lifetime, source, owner: f.owner, kind: 'live',
        observedAt: event.occurredAt } as WorkflowNativeCapture,
      { execution: f.execution, ref: { nodeId: f.execution.workflowNodeId, occurrence: null },
        inputDigest: repeatDigest(f.execution.input) } as StoredRepeatExecution,
      f.entry.reservation.scope, { ownerId: 'original-owner', fence: '1' })
      f.canonicalProofs.push({ record })
    }
    const saved = structuredClone(f.canonicalProofs)
    f.query.mockClear()
    await f.sqlConnection.transaction(sql => f.producer.assertOriginals(sql, f.owner, originals))
    expect(f.query.mock.calls.length).toBeLessThanOrEqual(25)
    expect(f.canonicalProofs).toEqual(saved)
    for (const original of originals) {
      const ack = { version: 1, operationId: f.intent.operationId, receiptSequence: f.readout.receipt.sequence,
        sourceDigest: original.sourceDigest, status: 'retired' }
      f.request.mockResolvedValueOnce({ payload: ack })
      await expect(f.producer.acknowledge(original)).resolves.toEqual(ack)
    }
    const sourceDigest = remoteWorkflowSourceDigest({ type: 'history', history: f.readout.history! as Parameters<typeof remoteWorkflowSourceDigest>[0] extends { history: infer H } ? H : never })
    const replyAck = { version: 1, operationId: f.intent.operationId,
      receiptSequence: f.readout.receipt.sequence, sourceDigest, status: 'retired' }
    f.request.mockResolvedValueOnce({ payload: replyAck })
    await expect(f.producer.acknowledgeReply(originals[0]!)).resolves.toEqual(replyAck)
  } finally { await f.sqlConnection.close() }
})
