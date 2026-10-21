import { createHash,randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type pg from 'pg'
import { describe,expect,it,vi } from 'vitest'
import { WorkflowRunV3Schema,WorkflowVersionV3Schema,canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type { RemoteWorkflowPhysicalReadout } from '@foreman-code/contracts/remote-workflow-physical'
import { workflowArtifactTransferManifestDigest } from '@foreman-code/contracts/workflow-artifact-transfer-node'
import { workflowArtifactDigestsByOutputKey } from '@foreman-code/contracts/workflow-artifact-result'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { fileToolFixture } from '../../../../test/support/fileTools.js'
import { DistributedArtifactPublicationService,type AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import type { DistributedPublicationLink } from '../../files/distributed/publicationLedger.js'
import { bindingIdentity } from '../../files/tools/context.js'
import { transferContextForBinding } from '../../byte-transfer/carrier.js'
import { ExclusiveGraphConnection,type GraphTransactionSql } from '../../run-graph/connection.js'
import { repeatDigest } from '../repeatResolution.js'
import { NativeArtifactOutputSchema,type NativeArtifactOutput } from './nativeArtifactOutputs.js'
import { PostgresWorkflowPhysicalArtifacts } from './workflowPhysicalArtifacts.js'
import { artifactWorkflowReceipt, completeResultRepair } from './workflowRepair.test-support.js'
const hash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex')
// Real canonical allocation/publication services and immutable revision metadata;
// memory bytes and SQL/authority doubles. No worker readiness or physical claim.
async function fixture(aliases=false) {
  const f=await fileToolFixture()
  const binding:DeviceSessionBinding={mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),
    keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID(),connectionGeneration:3}
  const executionId=randomUUID(),operationId=randomUUID()
  if(f.scope.chat.kind!=='agent')throw new Error('Agent workflow fixture required')
  f.scope.chat.executionId=executionId
  const accepted:AcceptedArtifactPublication={context:f.context,transferContext:transferContextForBinding(binding),attempt:{workspaceId:'workspace-a',workflowId:'workflow-a',
    runId:'run-a',nodeId:'producer',executionId,attemptId:randomUUID(),placementHash:'a'.repeat(64)}}
  const caller={context:f.context,principal:f.principal,binding:bindingIdentity(f.context)}
  const keys=['z-last','a-first'],commands=aliases?[randomUUID()]:[randomUUID(),randomUUID()]
  const artifactOutputs={version:1 as const,outputs:keys.map((outputKey,index)=>({outputKey,commandId:commands[aliases?0:index]!}))}
  const result={outcome:'succeeded' as const,output:{text:JSON.stringify({data:{original:true},artifactOutputs})}}
  const version=WorkflowVersionV3Schema.parse({id:'version',workspaceId:'workspace-a',workflowId:'workflow-a',version:1,
    executionSemanticsVersion:3,entryNodeId:'producer',definition:{id:'workflow-a',workspaceId:'workspace-a',name:'Original',version:1,
      executionSemanticsVersion:3,entryNodeId:'producer',executionCondition:{kind:'manual'},approval:{handler:'user'},
      executionPolicy:{maxParallelism:1,maxNodeExecutions:1},nodes:[{id:'producer',agentId:'agent-a',name:'Original',
        artifactOutputs:{version:1,outputKeys:keys}}],edges:[]},agentConfigurationVersionIds:{'agent-a':'configuration'},
    approval:{handler:'user'},contentHash:repeatDigest('original saved version'),createdAt:f.clock().toISOString()})
  const run=WorkflowRunV3Schema.parse({id:'run-a',workspaceId:'workspace-a',workflowId:'workflow-a',workflowVersionId:version.id,
    executionSemanticsVersion:3,agentConfigurationVersionIds:version.agentConfigurationVersionIds,approval:{handler:'user'},
    executionCondition:{kind:'manual'},executionState:'running',outcome:'pending',input:{},createdAt:f.clock().toISOString()})
  const links=new Map<string,DistributedPublicationLink>(),receipts=new Map<string,VerifiedTransferReceipt>(),bodies=new Map<string,Buffer>()
  const admissions=new Map<string,{workerPrincipalId:string;accepted:AcceptedArtifactPublication;declaration:{commandId:string;sha256:string;byteSize:number};intent:VerifiedTransferReceipt['intent']}>()
  const admissionRows=new Map<string,{principal_id:string;command_id:string;input_hash:string;target_key:string}>()
  const authority={authorize:vi.fn(async()=>caller),authorizePublication:vi.fn(async()=>caller),
    assertSourceLive:vi.fn(async()=>{}),resolveWorkflowContext:vi.fn(async()=>accepted)}
  const ledger={read:async(_owner:string,request:string)=>links.get(request),linkPublication:async(link:DistributedPublicationLink)=>{
    if(!links.has(link.requestId))links.set(link.requestId,structuredClone(link))
  }}
  const transfers={resolveVerifiedReceipt:async(id:string)=>receipts.get(id)!,openVerified:async(receipt:VerifiedTransferReceipt)=>Readable.from([bodies.get(receipt.transferId)!])}
  const publisher=new DistributedArtifactPublicationService(f.files,ledger,transfers,authority,f.clock)
  for(const [index,commandId] of commands.entries()){
    const body=Buffer.from(`exact original canonical output ${index}`)
    const declaration={commandId,sha256:hash(body),byteSize:body.length}
    const transferId=randomUUID()
    const receipt:VerifiedTransferReceipt={version:1,receiptId:randomUUID(),transferId,sha256:declaration.sha256,byteSize:body.length,
      verifiedAt:f.clock().toISOString(),intent:{version:1,...accepted.transferContext,transferId,operationId,executionId,
        attemptId:accepted.attempt.attemptId,placementHash:accepted.attempt.placementHash,rootId:randomUUID(),rootBindingRevision:1,
        direction:'to-main',byteClass:'artifact',sha256:declaration.sha256,byteSize:body.length,
        manifestDigest:workflowArtifactTransferManifestDigest(declaration),chunkBytes:1024,expiresAt:'2099-01-01T00:00:00.000Z'}}
    bodies.set(transferId,body);receipts.set(transferId,receipt);admissions.set(transferId,{workerPrincipalId:'original-workflow-lease',accepted:structuredClone(accepted),declaration,intent:structuredClone(receipt.intent)})
    admissionRows.set(transferId,{principal_id:'original-workflow-lease',command_id:commandId,input_hash:commandInputHash(declaration),target_key:'workflow-artifact:original-workflow-lease'})
    await publisher.publishAccepted(accepted,transferId,{commandId,artifactId:randomUUID(),scope:f.scope,filename:`original-${index}.md`,mediaType:'text/markdown'})
  }
  const mappings=new Map<string,{principal_id:string;command_id:string;input_hash:string;result:NativeArtifactOutput}>()
  const readout={receipt:{intent:{mainId:binding.mainId,runId:run.id,nodeId:'producer',executionId,attemptId:accepted.attempt.attemptId,
    bindingHash:accepted.attempt.placementHash},native:{sessionId:f.context.nativeSessionId,turnId:f.context.turnId},
    terminal:{kind:'completed',result,artifactDigests:workflowArtifactDigestsByOutputKey(artifactOutputs.outputs.map(mapping=>({outputKey:mapping.outputKey,
      sha256:[...links.values()].find(link=>link.requestId===`fil05:remote:${hash(mapping.commandId)}`)!.transferReceipt.sha256}))) }},
    output:{kind:'published-artifacts',result,artifactOutputs}} as unknown as RemoteWorkflowPhysicalReadout
  const state={publication:true,admission:true,live:true,scope:true,queries:[] as string[]}
  const query=vi.fn(async(text:string,args:unknown[]=[]):Promise<pg.QueryResult>=>{
    state.queries.push(text);let rows:unknown[]=[]
    if(text.includes('from runs r join workflow_versions'))rows=[{run,version}]
    else if(text.includes('from file_tool_publications p')){
      const link=links.get(args[1] as string);if(state.publication&&link)rows=[{record:link,file_id:link.ref.fileId,revision_id:link.ref.revisionId}]
    }else if(text.includes('from file_tool_publications')){
      const link=links.get(args[1] as string);if(state.publication&&link)rows=[{record:link}]
    }else if(text.includes("operation='remote.artifact-transfer.admit'")){
      const original=admissions.get(args[0] as string);if(state.admission&&original)rows=[{...admissionRows.get(args[0] as string),result:original}]
    }else if(text.includes("operation='remote.native-artifact.output'")){
      const row=mappings.get(args[0] as string);if(row)rows=[row]
    }else if(text.includes('select file_id from files')&&state.live)rows=(args[0] as string[]).map(file_id=>({file_id}))
    else if(!['begin isolation level read committed','commit','rollback'].includes(text))throw new Error(`Unexpected metadata SQL: ${text}`)
    return {rows,rowCount:rows.length,fields:[],command:'',oid:0}
  })
  const connection=new ExclusiveGraphConnection({query} as unknown as pg.ClientBase,()=>{})
  const files={read:vi.fn(async(id:string,revision:string,sql?:GraphTransactionSql)=>{
    expect(sql).toBeDefined();const stored=await f.repository.read(id,revision)
    if(stored&&!state.scope)stored.value.file.scope=f.foreign
    return stored
  })}
  const verifier=new PostgresWorkflowPhysicalArtifacts(binding.mainId,{authority,files})
  const publications=()=>connection.transaction(sql=>verifier.assertPublications(sql,readout,binding))
  const adopted=()=>connection.transaction(sql=>verifier.assertAdopted(sql,readout,binding))
  const adopt=async()=>{
    for(const mapping of artifactOutputs.outputs){
      const requestId=`fil05:remote:${hash(mapping.commandId)}`,link=links.get(requestId)!,stored=await f.repository.read(link.ref.fileId,link.ref.revisionId)
      const record=NativeArtifactOutputSchema.parse({version:1,producer:accepted.attempt,outputKey:mapping.outputKey,commandId:mapping.commandId,
        nativeIdentity:{nativeSessionId:f.context.nativeSessionId,turnId:f.context.turnId},publication:{ownerPrincipalId:caller.principal.id,requestId,binding:caller.binding},
        pins:{...link.ref,sha256:link.transferReceipt.sha256,byteSize:link.transferReceipt.byteSize},scope:stored!.value.file.scope,transferReceipt:link.transferReceipt})
      const target=JSON.stringify([binding.mainId,accepted.attempt.executionId,accepted.attempt.attemptId,mapping.outputKey])
      mappings.set(target,{principal_id:caller.principal.id,command_id:hash(target),input_hash:hash(canonicalGraphJson(record)),result:record})
    }
  }
  return {f,binding,accepted,caller,artifactOutputs,result,run,version,links,admissions,admissionRows,mappings,readout,state,authority,files,connection,verifier,publications,adopted,adopt}
}
describe('canonical physical artifact metadata and final adoption',()=>{
  it.each([1, 2])('retains the publishing turn after %s corrections for physical verification and adopted readback', async count => {
    const t = await fixture()
    try {
      await t.adopt()
      const original = structuredClone({ links: t.links, admissions: t.admissions, mappings: t.mappings })
      const publicationCaller = structuredClone(t.caller)
      const remote = artifactWorkflowReceipt(t.accepted, t.result)
      remote.terminal!.artifactDigests = t.readout.receipt.terminal!.artifactDigests!
      for (let attempt = 1; attempt <= count; attempt++) completeResultRepair(remote, `corrective-${attempt}`)
      t.readout.receipt = remote
      t.accepted.context = { ...t.accepted.context, turnId: remote.native!.turnId! }
      t.caller.context = t.accepted.context
      t.caller.binding = bindingIdentity(t.caller.context)
      Object.assign(t.authority, { authorizePublication: vi.fn(async () => publicationCaller) })
      await t.publications()
      await t.adopted()
      expect({ links: t.links, admissions: t.admissions, mappings: t.mappings }).toEqual(original)
    } finally { await t.connection.close() }
  })

  it.each(['invalid_result', 'missing_publication'] as const)(
    'verifies %s against saved declarations and canonical publications without adopting outputs', async reason => {
      const t = await fixture()
      try {
        const failure = { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT' as const, reason }
        const result = reason === 'invalid_result' ? { outcome: 'succeeded' as const,
          output: { text: JSON.stringify({ data: null, artifactOutputs: { version: 1,
            outputs: [{ outputKey: 'foreign-key', commandId: 'foreign-command' }] } }) } } : t.result
        t.readout.output = { kind: 'invalid-artifacts', result, failure }
        t.readout.receipt.terminal = { ...t.readout.receipt.terminal!, result,
          artifactDigests: [], artifactValidationError: failure }
        if (reason === 'missing_publication') {
          await expect(t.publications()).rejects.toMatchObject({ code: 'REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE' })
          t.state.publication = false
        }
        await t.publications()
        await expect(t.adopted()).rejects.toMatchObject({ code: 'REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE' })
        expect(t.mappings.size).toBe(0)
        expect(t.readout.receipt.terminal.result).toEqual(result)
      } finally { await t.connection.close() }
    })
  it('proves canonical publications before adoption and requires exact durable mappings afterward without G1 byte IO',async()=>{
    const t=await fixture()
    try {
      const downloads=t.f.bytes.downloads
      await t.publications()
      expect(t.mappings.size).toBe(0)
      await expect(t.adopted()).rejects.toThrow()
      await t.adopt();await t.adopted()
      expect(t.f.bytes.downloads).toBe(downloads)
      for (const mapping of t.mappings.values()) {
        expect((await t.f.repository.read(mapping.result.pins.fileId, mapping.result.pins.revisionId))?.value.file.state).toBe('ready')
      }
    }finally{await t.connection.close()}
  })
  it('retains two digest entries and immutable native mapping order for aliases of one canonical publication',async()=>{
    const t=await fixture(true)
    try {await t.adopt();await t.adopted();expect(t.readout.receipt.terminal!.artifactDigests).toHaveLength(2)
      expect(t.artifactOutputs.outputs.map(row=>row.outputKey)).toEqual(['z-last','a-first']);expect(t.links.size).toBe(1)}
    finally{await t.connection.close()}
  })
  it.each(['missing-publication','missing-admission','admission-worker','admission-hash','admission-target','changed-intent','changed-command','changed-context','digest','size','manifest','scope','expiry',
    'mapping-order','digest-order','native-result','declaration','turn','publication-owner','revision','pins','adopted-hash','adopted-owner','adopted-command','adopted-result'] as const)(
    'rejects %s and cannot commit even if the caller catches rejection',async defect=>{
      const t=await fixture();await t.adopt()
      try {
        const link=[...t.links.values()][0]!,admission=t.admissions.get(link.transferReceipt.transferId)!,mapped=[...t.mappings.values()][0]!
        if(defect==='missing-publication')t.state.publication=false
        if(defect==='missing-admission')t.state.admission=false
        if(defect==='admission-worker')admission.workerPrincipalId='replacement'
        if(defect==='admission-hash')t.admissionRows.get(link.transferReceipt.transferId)!.input_hash='replacement'
        if(defect==='admission-target')t.admissionRows.get(link.transferReceipt.transferId)!.target_key='replacement'
        if(defect==='changed-intent')admission.intent.rootId=randomUUID()
        if(defect==='changed-command')admission.declaration.commandId=randomUUID()
        if(defect==='changed-context')admission.accepted.context.nativeSessionId='replacement'
        if(defect==='digest')t.readout.receipt.terminal!.artifactDigests=['b'.repeat(64),'b'.repeat(64)]
        if(defect==='size')link.transferReceipt.byteSize++
        if(defect==='manifest')link.transferReceipt.intent.manifestDigest='b'.repeat(64)
        if(defect==='scope')t.state.scope=false
        if(defect==='expiry')t.state.live=false
        if(defect==='mapping-order')t.readout.output={kind:'published-artifacts',result:t.result,artifactOutputs:{version:1,outputs:[...t.artifactOutputs.outputs].reverse()}}
        if(defect==='digest-order')t.readout.receipt.terminal!.artifactDigests!.reverse()
        if(defect==='native-result')t.readout.receipt.terminal!.result={outcome:'succeeded',output:{text:'different'}}
        if(defect==='declaration'){
          const node=t.version.definition.nodes[0]!;if(node.kind!=='job')node.artifactOutputs!.outputKeys=['different']
        }
        if(defect==='turn')t.accepted.context.turnId='replacement'
        if(defect==='publication-owner')link.ownerPrincipalId='replacement'
        if(defect==='revision')link.ref.revisionId=randomUUID()
        if(defect==='pins')mapped.result.pins.sha256='b'.repeat(64)
        if(defect==='adopted-hash')mapped.input_hash='b'.repeat(64)
        if(defect==='adopted-owner')mapped.principal_id='replacement'
        if(defect==='adopted-command')mapped.command_id=hash('replacement')
        if(defect==='adopted-result')mapped.result.commandId=randomUUID()
        await expect(t.connection.transaction(async sql=>{
          await expect(t.verifier.assertAdopted(sql,t.readout,t.binding)).rejects.toThrow()
        })).rejects.toThrow()
      }finally{await t.connection.close()}
    })
  it('rechecks authorization and expiry after metadata waits on the same SQL transaction',async()=>{
    const t=await fixture();await t.adopt()
    try {
      const authorize=t.authority.authorize.getMockImplementation()!
      t.authority.authorize.mockImplementationOnce(authorize).mockImplementationOnce(async()=>({...t.caller,binding:'replacement'}))
      await expect(t.adopted()).rejects.toThrow()
      t.authority.authorize.mockImplementation(authorize)
      t.files.read.mockImplementationOnce(async(id,revision,sql)=>{expect(sql).toBeDefined();t.state.live=false;return t.f.repository.read(id,revision)})
      await expect(t.publications()).rejects.toThrow()
    }finally{await t.connection.close()}
  })
})
