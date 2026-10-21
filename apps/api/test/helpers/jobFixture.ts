import { jobDigest } from '../../src/modules/jobs/service.js'
import { ResolvedJobDefinitionSpecSchema, type JobExecution } from '@foreman-code/contracts/jobs'
export function jobSpec() {
  const digest='1'.repeat(64),mainId='11111111-1111-4111-8111-111111111111'
  return ResolvedJobDefinitionSpecSchema.parse({source:{approvedSourceId:mainId,snapshotId:mainId,commit:'2'.repeat(40),manifestDigest:digest},
    target:{schemaVersion:1,mainId,hostRef:{kind:'main',mainId},registration:null,mainInstallationId:'test-main',destination:{canonicalProjectRoot:'/approved/project',canonicalCwd:'/approved/project',managedRuntimeRoot:'/approved/runtime',directoryIdentityHash:digest,rootPolicyId:'root',rootPolicyRevision:'1',locationRevision:'1',attestationId:'attestation',attestationHash:digest}},
    argv:['node','scripts/ci-fixtures/failure.mjs'],inputs:[],outputs:[],policy:{isolationPolicyId:'approved-container',isolationPolicyRevision:1,imageDigest:`sha256:${digest}`,toolchainDigest:digest,environmentScopeRefs:[],network:'none',queueTimeoutMs:10000,preparationTimeoutMs:10000,executionTimeoutMs:10000,cancellationGraceMs:1000,maxLogChunkBytes:1024,maxLogBytes:4096,maxWorkerSpoolBytes:4096,logOverflow:'stop',maxOutputBytes:4096,retentionSeconds:3600}})
}
export function jobExecution():JobExecution {
  const spec=jobSpec(),digest='1'.repeat(64),now='2026-10-01T00:00:00.000Z'
  const source={...spec.source,materializationId:'11111111-1111-4111-8111-111111111111',materializationDigest:digest}
  return {schemaVersion:1,id:'job-fixture',workspaceId:'workspace-fixture',acceptedSpec:{...spec,workflowInput:null,source,definitionId:'definition-fixture',definitionRevision:1,definitionVersionId:'version-fixture',scriptDigest:jobDigest(spec.argv),outputSpecDigest:jobDigest(spec.outputs),specDigest:jobDigest({...spec,source,workflowInput:null}),bindingHash:jobDigest({target:spec.target,source})},operationId:'operation-fixture',attemptId:'attempt-fixture',owner:{grantId:'grant-fixture',epoch:'1'},workflow:null,process:{phase:'queued',outcome:null,exitCode:null,signal:null,processStopped:false},transport:'unknown',publication:'pending',startedAt:null,finishedAt:null,lastSeenAt:null,resultIssue:null,cancelRequestedAt:null,createdAt:now,updatedAt:now}
}
