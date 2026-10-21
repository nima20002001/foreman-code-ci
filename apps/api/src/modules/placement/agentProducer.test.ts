import { describe, expect, it } from 'vitest'
import { ExecutionAuthorityRequestSchema } from '@foreman-code/contracts/execution-authority'
import { workerExecutionAuthorizer, workerReviewerAuthorizer } from './executionAuthorityClient.js'
import { freezePlacement, deriveDispatch, readPlacement } from './binding.js'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
const mainId='11111111-1111-4111-8111-111111111111', digest='a'.repeat(64)
const pin=freezePlacement({ schemaVersion:1,mainId,mainInstallationId:mainId,runId:'run',nodeId:'node',hostRef:{kind:'main',mainId},registration:null,
  destination:{canonicalProjectRoot:'/copies/root',canonicalCwd:'/copies/root',managedRuntimeRoot:'/native',directoryIdentityHash:digest,
    rootPolicyId:'policy',rootPolicyRevision:'1',locationRevision:'1',attestationId:'attestation',attestationHash:digest},
  source:{kind:'pending',approvedSourceId:mainId,snapshotId:mainId,revisionId:mainId,manifestDigest:digest,rootId:mainId,bindingRevision:1,materializationId:null,materializationDigest:null},
  payload:{kind:'agent',agentId:'agent',agentConfigurationVersionId:'config',driverId:'codex',driverRevision:'1',instanceId:'instance',instanceRevision:'1',harnessInstallationId:'harness',installationFingerprint:digest,runtimeContractVersion:1,protocolRevision:'1',credentialScopeRefs:[]} })
const intent=deriveDispatch(pin,{executionId:'execution',occurrenceId:null,occurrenceIndex:0,technicalAttempt:1,attemptId:'attempt',operationId:'operation',inputDigest:`sha256:${digest}`,owner:{grantId:'grant',epoch:'1'}})
describe('actual Agent admission contracts and private upstream authorizer',()=>{
  it.each([true, false])('rechecks cleanup after reviewer retention is denied (cleanup: %s)', async cleanupOnly => {
    const retentionError = new Error('Reviewer retention denied')
    const actions: string[] = []
    const authorize = workerReviewerAuthorizer(async (_namespace, raw) => {
      const input = ExecutionAuthorityRequestSchema.parse(raw)
      actions.push(input.action)
      if (input.action === 'retain-reviewer') throw retentionError
      return { payload: { version: 1, action: input.action, operationId: intent.operationId,
        attemptId: intent.attemptId, bindingHash: intent.bindingHash, owner: intent.owner,
        ...(cleanupOnly ? { cleanupOnly: true } : {}) } }
    })
    if (cleanupOnly) await expect(authorize(intent, pin)).resolves.toBeUndefined()
    else await expect(authorize(intent, pin)).rejects.toBe(retentionError)
    expect(actions).toEqual(['retain-reviewer', 'read'])
  })
  it('binds the exact saved artifact declaration and rejects a rewritten worker placement',()=>{
    if (pin.payload.kind !== 'agent') throw new Error('fixture')
    const {bindingHash: originalBindingHash,...base}=pin
    const declaration={version:1 as const,outputKeys:['report','alias']}
    const admitted=freezePlacement({...base,payload:{...pin.payload,artifactOutputs:declaration}})
    expect(admitted.bindingHash).not.toBe(originalBindingHash)
    expect(readPlacement(admitted).payload).toMatchObject({artifactOutputs:declaration})
    declaration.outputKeys.push('caller-mutation')
    expect(admitted.payload).toMatchObject({artifactOutputs:{version:1,outputKeys:['report','alias']}})
    const rewritten=structuredClone(admitted)
    if (rewritten.payload.kind !== 'agent') throw new Error('fixture')
    rewritten.payload.artifactOutputs={version:1,outputKeys:['foreign']}
    expect(()=>readPlacement(rewritten)).toThrow('Accepted placement hash')
    delete rewritten.payload.artifactOutputs
    expect(()=>readPlacement(rewritten)).toThrow('Accepted placement hash')
  })
  it('pins a deferred source without claiming a clone exists',()=>{expect(pin.source.materializationId).toBeNull();expect(ExecutionAuthorityRequestSchema.safeParse({version:1,action:'start',intent,placement:pin}).success).toBe(true)})
  it('rejects forged entry permits in an authority request',()=>{expect(ExecutionAuthorityRequestSchema.safeParse({version:1,action:'start',intent,placement:pin,permit:true}).success).toBe(false)})
  it('saves explicit approved source/root pins',()=>{expect(SavedNodePlacementSchema.parse({schemaVersion:1,hostRef:pin.hostRef,rootPolicyId:'policy',rootPolicyRevision:'1',locationRevision:'1',projectRoot:'/project',cwdPolicy:'project-root',relativeCwd:'',instanceId:'instance',instanceRevision:'1',harnessInstallationId:'harness',source:{approvedSourceId:mainId,snapshotId:mainId,manifestDigest:digest},rootBinding:{rootId:mainId,bindingRevision:1}}).source?.snapshotId).toBe(mainId)})
  it('uses only the authenticated namespace with exact echoed identities',async()=>{const authorize=workerExecutionAuthorizer(async(namespace,input)=>{expect(namespace).toBe('execution-authority-v1');expect(ExecutionAuthorityRequestSchema.parse(input).intent).toEqual(intent);return{payload:{version:1,action:'read',operationId:intent.operationId,attemptId:intent.attemptId,bindingHash:intent.bindingHash,owner:intent.owner}}});await authorize(intent,pin,'read')})
  it.each(['read', 'stop', 'start', 'control'] as const)('keeps cleanup-only authority limited to observations and Stop: %s', async action => {
    const authorize = workerExecutionAuthorizer(async () => ({ payload: { version: 1, action,
      operationId: intent.operationId, attemptId: intent.attemptId, bindingHash: intent.bindingHash,
      owner: intent.owner, cleanupOnly: true } }))
    if (action === 'read' || action === 'stop') {
      await expect(authorize(intent, pin, action)).resolves.toEqual({ cleanupOnly: true })
    } else await expect(authorize(intent, pin, action)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
  })
  it('rejects mismatched owner and binary authority responses',async()=>{const response={version:1,action:'start',operationId:intent.operationId,attemptId:intent.attemptId,bindingHash:intent.bindingHash,owner:intent.owner};await expect(workerExecutionAuthorizer(async()=>({payload:{...response,owner:{grantId:'forged',epoch:'1'}}}))(intent,pin,'start')).rejects.toThrow();await expect(workerExecutionAuthorizer(async()=>({payload:response,bytes:new Uint8Array([1])}))(intent,pin,'start')).rejects.toThrow()})
})

import type pg from 'pg'
import { makeCurrentWorkflowFixture, canonicalGraphJson, RunStartV3InputSchema } from '@foreman-code/contracts/wave25'
import { createHash } from 'node:crypto'
import { AgentPlacementProducer } from './agentProducer.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import { HarnessInstallationRegistry } from '../harnesses/installationRegistry.js'
import { HarnessInstanceRegistry } from '../harnesses/instanceRegistry.js'
function producerFixture(placed: boolean) {
  const fixture=makeCurrentWorkflowFixture('placement-producer','single')
  const version=structuredClone(fixture.version)
  const node=version.definition.nodes[0]!
  if (placed) node.placement={schemaVersion:1,hostRef:{kind:'main',mainId},rootPolicyId:'policy',rootPolicyRevision:'1',locationRevision:'1',projectRoot:'/project',cwdPolicy:'project-root',relativeCwd:'',instanceId:'instance',instanceRevision:'1',harnessInstallationId:'harness'}
  version.contentHash=`sha256:${createHash('sha256').update(canonicalGraphJson({definition:version.definition,configurations:version.agentConfigurationVersionIds,entryNodeId:version.entryNodeId})).digest('hex')}`
  const client={query:async(text:string)=>({rows:text.includes('from workflow_versions')?[{id:version.id,workspace_id:version.workspaceId,workflow_id:version.workflowId,version:version.version,entry_node_id:version.entryNodeId,execution_semantics_version:3,record:version}]:[],rowCount:text.includes('from workflow_versions')?1:0}),on:()=>undefined,removeListener:()=>undefined,release:()=>undefined}
  const pool={connect:async()=>client} as unknown as pg.Pool
  const sources={resolveRootBinding:async()=>{throw new Error('No source may be invented')}} as unknown as SourceAdmissionPort
  const roots={} as WorkspaceRootPolicyPort
  const registry=new HarnessInstallationRegistry(new HarnessInstanceRegistry([]))
  const producer=new AgentPlacementProducer(pool,mainId,sources,roots,{ installations: registry,
    pinOverride: () => { throw new Error('Missing source pins cannot select a harness') } },{codex:'codex-live-4'})
  return {producer,input:RunStartV3InputSchema.parse({workspaceId:version.workspaceId,workflowId:version.workflowId,workflowVersionId:version.id,expectedAgentConfigurationVersionIds:version.agentConfigurationVersionIds,commandId:'command-one',executionSemanticsVersion:3,expectedWorkflowRevision:1,expectedLocationRevision:1,input:{}}),principal:{id:'principal',name:'test',audience:'operator' as const,grants:[],expiresAt:'2099-01-01T00:00:00Z',revokedAt:null}}
}
it('real producer preserves unplaced local admission without source/resource allocation',async()=>{const f=producerFixture(false);expect(await f.producer.prepare(f.input,f.principal)).toBeUndefined()})
it('rejects an explicitly placed node without an approved source and root', async () => {
  const f = producerFixture(true)
  await expect(f.producer.prepare(f.input, f.principal)).rejects.toMatchObject({
    code: 'PLACEMENT_ADMISSION_CONFLICT',
  })
})
