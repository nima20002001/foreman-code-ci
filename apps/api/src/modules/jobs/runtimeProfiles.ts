import { JOB_VERIFICATION_OWNER_CONFIGURATION } from '@foreman-code/contracts/job-verification-policy'
import { withTransaction } from '../../infrastructure/transaction.js'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { JobRuntimeProfileInputSchema, JobRuntimeProfileSchema,
  JobRuntimeQualificationRequestSchema } from '@foreman-code/contracts/job-runtime'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { ResolvedJobDefinitionSpecRecord } from '@foreman-code/contracts/job-verification'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSourceService } from '../sources/service.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { JobSql } from './repository.js'
import { jobDigest } from './digest.js'
import { readJobRuntimeProfileVersion } from './runtimeProfileVersion.js'
import type { JobRuntimeInventory } from './sourcePreparation.js'
import type { JobRuntimeQualificationProducer, JobRuntimeQualificationResult } from './runtimeProfilePorts.js'
import { JobVerificationProfileSchema, JobVerificationRuntimeFingerprintSchema, JobVerificationRuntimeMeasurementSchema,
  JobRuntimeProfileRecordSchema, JobRuntimeProfileSaveRecordSchema, JobRuntimeApprovalRecordSchema,
  JobRuntimeQualificationSummarySchema,
  JobRuntimeFingerprintRecordSchema, JobRuntimeMeasurementRecordSchema, JobRuntimeNativeAdmissionRecordSchema,
  jobRuntimeProfilePolicy, jobRuntimeProfileLimits, type JobRuntimeApprovalRecord,
  type JobRuntimeProfileRecord, type JobRuntimeProfileSaveRecord }
  from '@foreman-code/contracts/job-verification-runtime'
import { createVerificationProfile, requireReviewedVerificationConfiguration } from './verificationProfiles.js'
import type { z } from 'zod'
import { verificationDependencyBasis } from './dependencyBasis.js'
import { runtimeQualificationFacts, validateRuntimeQualification, qualificationTimeoutMs, qualificationDeadline }
  from './runtimeQualificationFacts.js'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'

function usesRetiredHarness(profile: JobRuntimeProfileRecord): boolean {
  return profile.schemaVersion === 2
    && profile.measurement?.fingerprint.tools.some(tool => tool.kind === 'opencode') === true
}

/** Main CI policy metadata; machine/root identity continues to come from W07/W09/W12. */
export class JobRuntimeProfiles implements JobRuntimeInventory {
  enrollment?: { profileSaved(principal: ManagementPrincipal, workspaceId: string): Promise<void> }
  constructor(private readonly pool:pg.Pool,private readonly commands:PostgresCommandCoordinator,private readonly sources:PostgresSourceService,
    private readonly producer:JobRuntimeQualificationProducer,
    private readonly changed?: () => void) {}
  private async transaction<T>(work:(sql:pg.PoolClient)=>Promise<T>) {
    return withTransaction(this.pool, work)
  }
  private async authorize(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,write=false) {
    requireAuthorization(principal,write?'job_definitions:write':'job_definitions:read',{workspaceId})
    const live=await readLiveManagementPrincipal(sql,principal.id)
    requireAuthorization(live,write?'job_definitions:write':'job_definitions:read',{workspaceId})
    if(write)await lockActiveWorkspace(sql,workspaceId)
    return live
  }
  async record(sql:JobSql,workspaceId:string,id:string,lock=false) {
    const row=(await sql.query<{record:unknown}>(`select record from job_runtime_profiles where workspace_id=$1 and id=$2${lock?' for update':' for share'}`,[workspaceId,id])).rows[0]
    if(!row)throw new DomainError('JOB_RUNTIME_PROFILE_NOT_FOUND','The exact workspace CI runtime profile is missing.',404)
    const profile=JobRuntimeProfileRecordSchema.parse(row.record)
    if(profile.id!==id||profile.workspaceId!==workspaceId)throw new DomainError('JOB_RUNTIME_PROFILE_SCOPE_CONFLICT','The stored profile scope differs from its identifier.',409)
    return profile
  }
  async list(principal:ManagementPrincipal,workspaceId:string) {
    return this.transaction(async sql=>{
      await this.authorize(sql,principal,workspaceId)
      const rows=await sql.query<{record:unknown}>('select record from job_runtime_profiles where workspace_id=$1 order by id limit 100',[workspaceId])
      const profiles=await Promise.all(rows.rows.map(async row=>{
        const profile=JobRuntimeProfileRecordSchema.parse(row.record)
        let readiness: { ready: boolean; reasons: string[] }
        if (profile.schemaVersion === 2) readiness = await this.readiness(sql, profile)
        else readiness=profile.status==='qualified'&&profile.measurement&&Date.parse(profile.measurement.expiresAt)>Date.now()?await this.producer.revalidate(sql,profile):{ready:false,reasons:[`RUNTIME_${profile.status.toUpperCase().replaceAll('-','_')}`]}
        return {profile,...readiness,sideEffects:false as const}
      }))
      const approvals = (await sql.query<{
        record: unknown; run_command_id: string | null; run_principal_id: string | null
      }>(`select record,run_command_id,run_principal_id from job_runtime_qualification_approvals
        where workspace_id=$1 and record->>'status' in
        ('captured','awaiting-approval','approved','qualifying','recovery-required') order by id limit 100`,
      [workspaceId])).rows.map(row => JobRuntimeQualificationSummarySchema.parse({
        ...JobRuntimeApprovalRecordSchema.parse(row.record),
        ...(row.run_command_id ? { runCommandId: row.run_command_id } : {}),
        ...(row.run_principal_id ? { runPrincipalId: row.run_principal_id } : {}),
      }))
      await this.authorize(sql,principal,workspaceId);return {profiles,approvals}
    })
  }
  async save(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,raw:JobRuntimeProfileSaveRecord) {
    const input=JobRuntimeProfileSaveRecordSchema.parse(raw)
    requireAuthorization(principal,'job_definitions:write',{workspaceId})
    const result = await this.commands.execute({principal,source,operation:'job.runtime-profile.save',commandId:input.commandId,targetKey:workspaceId,payload:input,
      authorize:sql=>this.authorize(sql,principal,workspaceId,true).then(()=>undefined),perform:async sql=>{
        await lockActiveWorkspace(sql,workspaceId)
        const old=input.id?await this.record(sql,workspaceId,input.id,true):null
        if((old?.revision??null)!==input.expectedRevision)throw new DomainError('REVISION_CONFLICT','The runtime profile changed since it was read.',409)
        const rootRow=(await sql.query<{record:unknown}>('select record from source_root_bindings where workspace_id=$1 and root_id=$2 and binding_revision=$3 for share',[workspaceId,input.spec.rootId,input.spec.bindingRevision])).rows[0]
        if(!rootRow)throw new DomainError('SOURCE_ROOT_NOT_FOUND','The exact existing root binding is missing.',404)
        const rootRecord=SourceRootRecordSchema.parse(rootRow.record)
        const root=await this.sources.resolveRootBinding(sql,principal,{workspaceId,rootId:input.spec.rootId,bindingRevision:input.spec.bindingRevision,source:rootRecord.source})
        if(root.binding.accessMode!=='exclusive-write')throw new DomainError('SOURCE_READ_ONLY','CI requires an approved exclusive source namespace.',403)
        const id=old?.id??randomUUID(),revision=(old?.revision??0)+1,policy={...input.spec.policy,isolationPolicyId:id,isolationPolicyRevision:revision}
        const now=new Date().toISOString()
        let profile: JobRuntimeProfileRecord
        if ('resources' in input.spec) {
          const approvedSource = await this.sources.resolveApprovedSource(sql, principal, workspaceId, root.source)
          const sourceCommit = approvedSource.manifest.git?.commit
          if (!sourceCommit) throw new DomainError('JOB_SOURCE_COMMIT_REQUIRED',
            'Verification profiles require an approved source snapshot with its Git commit.', 409)
          profile = createVerificationProfile({ id, workspaceId, revision, name: input.name,
            root, sourceCommit, spec: input.spec, previous: old, now })
        } else {
          const specDigest=jobDigest({workspaceId,id,revision,root,policy,limits:input.spec.limits})
          profile=JobRuntimeProfileSchema.parse({schemaVersion:1,id,workspaceId,revision,name:input.name,root,policy,limits:input.spec.limits,specDigest,status:'unqualified',measurement:null,createdAt:old?.createdAt??now,updatedAt:now})
        }
        await sql.query('insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record) values($1,$2,$3,$4,$5,$6::jsonb) on conflict(id) do update set revision=excluded.revision,root_id=excluded.root_id,binding_revision=excluded.binding_revision,record=excluded.record',[id,workspaceId,revision,root.binding.rootId,root.binding.bindingRevision,JSON.stringify(profile)])
        await sql.query('insert into job_runtime_profile_versions(profile_id,revision,record) values($1,$2,$3::jsonb)',[id,revision,JSON.stringify(profile)])
        return profile
      }})
    await this.enrollment?.profileSaved(principal, workspaceId)
    this.changed?.()
    return result.value
  }
  async requestQualification(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,raw:unknown) {
    const input=JobRuntimeQualificationRequestSchema.parse(raw)
    requireAuthorization(principal,'job_definitions:write',{workspaceId})
    let captured:{profile:JobRuntimeProfileRecord;fingerprint:ReturnType<typeof JobRuntimeFingerprintRecordSchema.parse>}|undefined
    const result = await this.commands.execute({principal,source,operation:'job.runtime-profile.request',commandId:input.commandId,targetKey:workspaceId,payload:input,dedicatedConnection:true,
      authorize:sql=>this.authorize(sql,principal,workspaceId,true).then(()=>undefined),
      prepare:async()=>{
        const saved=await this.transaction(async sql=>{await this.authorize(sql,principal,workspaceId,true);return this.record(sql,workspaceId,input.profileId)})
        if(saved.revision!==input.expectedRevision)throw new DomainError('REVISION_CONFLICT','The runtime profile changed.',409)
        if (saved.schemaVersion === 2) requireReviewedVerificationConfiguration(saved)
        const profile = saved
        const {isolationPolicyId,isolationPolicyRevision,...policy}=jobRuntimeProfilePolicy(profile)
        if (profile.schemaVersion === 1) JobRuntimeProfileInputSchema.parse({rootId:profile.root.binding.rootId,bindingRevision:profile.root.binding.bindingRevision,limits:profile.limits,policy})
        if(isolationPolicyId!==profile.id||isolationPolicyRevision!==profile.revision)throw new DomainError('JOB_RUNTIME_PROFILE_SCOPE_CONFLICT','The policy differs from its exact profile revision.',409)
        const fingerprint=JobRuntimeFingerprintRecordSchema.parse(await this.producer.capture(profile))
        if (profile.schemaVersion === 2) JobVerificationRuntimeFingerprintSchema.parse(fingerprint)
        if (profile.schemaVersion === 2 && (fingerprint.schemaVersion !== 3
          || fingerprint.sourceCommit !== profile.sourceCommit)) {
          throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED',
            'Verification qualification must capture the approved commit and verification profile.', 409)
        }
        if(fingerprint.profileId!==profile.id||fingerprint.profileRevision!==profile.revision||fingerprint.specDigest!==profile.specDigest||canonicalJson(fingerprint.root)!==canonicalJson(profile.root)||canonicalJson(fingerprint.hostRef)!==canonicalJson(profile.root.selection.hostRef)||canonicalJson(fingerprint.registration)!==canonicalJson(profile.root.registration)||canonicalJson(fingerprint.limits)!==canonicalJson(jobRuntimeProfileLimits(profile)))throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT','Installed metadata does not match this profile revision.',409)
        if (profile.schemaVersion === 2 && (fingerprint.schemaVersion !== 3
          || canonicalJson(fingerprint.resources) !== canonicalJson(profile.spec.resources)
          || canonicalJson(fingerprint.approvalConfig) !== canonicalJson(profile.approvalConfig)
          || canonicalJson(fingerprint.network) !== canonicalJson(profile.spec.policy.network))) {
          throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT','Verification metadata differs from its saved configuration.',409)
        }
        if (profile.schemaVersion === 1 && fingerprint.schemaVersion === 3) {
          throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT','Build profiles cannot use verification metadata.',409)
        }
        captured={profile,fingerprint}
      },perform:async sql=>{
        if(!captured)throw new DomainError('JOB_RUNTIME_FINGERPRINT_MISSING','The actual installed candidate metadata is missing.',409)
        const profile=await this.record(sql,workspaceId,input.profileId,true)
        if(profile.specDigest!==captured.profile.specDigest)throw new DomainError('REVISION_CONFLICT','The runtime profile changed during candidate capture.',409)
        const requestedAt = new Date().toISOString()
        const lifetime = profile.schemaVersion === 2 ? profile.approvalConfig.approvalLifetimeMs : 3600000
        const approval=JobRuntimeApprovalRecordSchema.parse({schemaVersion:profile.schemaVersion,id:randomUUID(),qualificationId:randomUUID(),workspaceId,profileId:profile.id,profileRevision:profile.revision,fingerprint:captured.fingerprint,fingerprintDigest:jobDigest(captured.fingerprint),requestedByPrincipalId:principal.id,status:'captured',
          ...(profile.schemaVersion === 2 ? { requestedAt } : {}),
          expiresAt:new Date(Date.parse(requestedAt)+lifetime).toISOString()})
        await sql.query('insert into job_runtime_qualification_approvals(id,qualification_id,profile_id,profile_revision,workspace_id,record,requested_by) values($1,$2,$3,$4,$5,$6::jsonb,$7)',[approval.id,approval.qualificationId,profile.id,profile.revision,workspaceId,JSON.stringify(approval),principal.id])
        if (!profile.measurement && !profile.activeQualificationId) {
          await this.put(sql,{...profile,status:'captured',updatedAt:new Date().toISOString()})
        }
        return approval
      }})
    this.changed?.()
    return result.value
  }
  async qualify(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,commandId:string,approvalId:string,
    options: { signal?: AbortSignal } = {}) {
    let measurement:ReturnType<typeof JobRuntimeMeasurementRecordSchema.parse>|undefined
    let result:JobRuntimeQualificationResult|undefined
    let claimed=false
    let reconcile=false
    let recovering = false
    try {
      const outcome = await this.commands.execute({principal,source,operation:'job.runtime-profile.qualify',commandId,targetKey:workspaceId,payload:{approvalId},dedicatedConnection:true,
      shouldResumeReceipt: async sql => {
        const saved = await this.approval(sql, workspaceId, approvalId)
        return saved.status === 'recovery-required'
      },
      authorize:sql=>this.authorize(sql,principal,workspaceId,true).then(()=>undefined),prepare:async()=>{
        const approval=await this.transaction(async sql=>{
          await this.authorize(sql,principal,workspaceId,true)
          const value=await this.approval(sql,workspaceId,approvalId,true),profile=await this.record(sql,workspaceId,value.profileId,true)
          const owner=(await sql.query<{run_command_id:string|null;run_principal_id:string|null;measurement:unknown;run_result:JobRuntimeQualificationResult|null}>('select run_command_id,run_principal_id,measurement,run_result from job_runtime_qualification_approvals where id=$1 for update',[approvalId])).rows[0]!
          if(owner.run_command_id&&(owner.run_command_id!==commandId||owner.run_principal_id!==principal.id))throw new DomainError('JOB_RUNTIME_QUALIFICATION_IN_PROGRESS','Reconcile the original qualification command.',409)
          recovering = owner.run_command_id !== null
          const matchesProfile = profile.schemaVersion === value.schemaVersion
            && profile.revision === value.profileRevision && profile.specDigest === value.fingerprint.specDigest
          const currentCandidate = matchesProfile && Date.parse(value.expiresAt) > Date.now()
          if (!['captured','awaiting-approval','approved','qualifying','failed','recovery-required'].includes(value.status)
            || !recovering && !currentCandidate) {
            throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'Capture the current installed candidate before qualifying it.', 409)
          }
          if (value.schemaVersion === 2) {
            const live = await readLiveManagementPrincipal(sql, principal.id)
            requireAuthorization(live, 'jobs:start', { workspaceId })
            requireAuthorization(live, 'job_artifacts:read', { workspaceId })
            JobVerificationRuntimeFingerprintSchema.parse(value.fingerprint)
          }
          if(owner.measurement)measurement=JobRuntimeMeasurementRecordSchema.parse(owner.measurement)
          if(owner.run_result)result=owner.run_result
          const unresolved = !result && !measurement
            || result?.outcome === 'denied' && result.closure === 'unconfirmed'
          if(owner.run_command_id && unresolved) {
            if (!this.producer.reconcile) throw new DomainError('JOB_RUNTIME_RECOVERY_REQUIRED',
              'The original physical qualification requires owner reconciliation before another probe.',409)
            reconcile = true
            result = undefined
            measurement = undefined
          }
          await sql.query('update job_runtime_qualification_approvals set run_command_id=$2,run_principal_id=$3 where id=$1',[approvalId,commandId,principal.id])
          const next={...value,status:'qualifying' as const}
          await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb where id=$1',
            [approvalId,JSON.stringify(next)])
          const claimProfile = !recovering || !profile.activeQualificationId && !profile.measurement
          if (matchesProfile && claimProfile) await this.put(sql,{...profile,status:'qualifying',
            activeQualificationId:value.qualificationId})
          return next
        })
        claimed=true
        if (!result) {
          const timeoutMs = reconcile ? 240_000 : await this.transaction(async sql => {
            await this.authorize(sql,principal,workspaceId,true)
            return qualificationTimeoutMs(await this.record(sql,workspaceId,approval.profileId),approval)
          })
          const deadline = qualificationDeadline(timeoutMs)
          const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
          try {
            signal.throwIfAborted()
            result = reconcile ? await this.producer.reconcile!(approval,signal)
              : await this.producer.run(approval,signal)
          }
          finally { deadline.dispose() }
        }
        if(result.outcome==='qualified') {
          measurement=JobRuntimeMeasurementRecordSchema.parse(result.measurement)
          if (measurement.schemaVersion === 2) JobVerificationRuntimeMeasurementSchema.parse(measurement)
          validateRuntimeQualification(approval,measurement,{ allowExpired: recovering })
        }
        await this.transaction(async sql=>{await this.authorize(sql,principal,workspaceId,true);await sql.query('update job_runtime_qualification_approvals set measurement=$2::jsonb,run_result=$5::jsonb where id=$1 and run_command_id=$3 and run_principal_id=$4',[approvalId,measurement?JSON.stringify(measurement):null,commandId,principal.id,JSON.stringify(result)])})
      },perform:async sql=>{
        if(!result)throw new DomainError('JOB_RUNTIME_EVIDENCE_MISSING','Actual qualification result is missing.',409)
        const approval=await this.approval(sql,workspaceId,approvalId,true),profile=await this.record(sql,workspaceId,approval.profileId,true)
        if(result.outcome==='denied') {
          const status=result.closure==='unconfirmed'?'recovery-required' as const:'failed' as const
          const denied={...profile,status,measurement:null,updatedAt:new Date().toISOString()}
          if (result.closure === 'confirmed') delete denied.activeQualificationId
          const updateProfile = profile.revision === approval.profileRevision
            && profile.specDigest === approval.fingerprint.specDigest
            && profile.activeQualificationId === approval.qualificationId
          if (updateProfile) await this.put(sql, denied)
          await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb where id=$1',
            [approvalId,JSON.stringify({...approval,status})])
          return updateProfile ? denied : profile
        }
        if(!measurement)throw new DomainError('JOB_RUNTIME_EVIDENCE_MISSING','Actual measured evidence is missing.',409)
        const facts = runtimeQualificationFacts(measurement)
        if (approval.status !== 'qualifying') throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT',
          'Qualification context changed before publication.',409)
        const currentCandidate = profile.revision === facts.profileRevision && profile.specDigest === facts.specDigest
        const expired = Date.parse(approval.expiresAt) <= Date.now() || Date.parse(measurement.expiresAt) <= Date.now()
        const ownsProfile = profile.activeQualificationId === approval.qualificationId
        if (!ownsProfile || recovering && (!currentCandidate || expired)) {
          await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb where id=$1',
            [approvalId,JSON.stringify({...approval,status:'complete'})])
          if (ownsProfile && currentCandidate && !profile.measurement) {
            const unqualified = { ...profile,status:'unqualified' as const,updatedAt:new Date().toISOString() }
            delete unqualified.activeQualificationId
            await this.put(sql,unqualified)
            return unqualified
          }
          return profile
        }
        if (!currentCandidate || expired) throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT',
          'Qualification context changed before publication.',409)
        const qualified=JobRuntimeProfileRecordSchema.parse({...profile,status:'qualified',measurement,updatedAt:new Date().toISOString()})
        delete qualified.activeQualificationId
        const current=await this.producer.revalidate(sql,qualified)
        if(!current.ready)throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The actual captured host/root/runtime fingerprint changed.',409,{reasons:current.reasons})
        await this.put(sql,qualified);await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb,measurement=$3::jsonb where id=$1',[approvalId,JSON.stringify({...approval,status:'complete'}),JSON.stringify(measurement)]);return qualified
      }})
      this.changed?.()
      return outcome.value
    } catch(error) {
      if(claimed) {
        try {await this.transaction(async sql=>{
          await this.authorize(sql,principal,workspaceId,true)
          const approval=await this.approval(sql,workspaceId,approvalId,true)
          const owner=(await sql.query<{run_command_id:string|null;run_principal_id:string|null;measurement:unknown;run_result:JobRuntimeQualificationResult|null}>('select run_command_id,run_principal_id,measurement,run_result from job_runtime_qualification_approvals where id=$1 for update',[approvalId])).rows[0]!
          if(approval.status!=='qualifying'||owner.run_command_id!==commandId||owner.run_principal_id!==principal.id)return
          // A thrown producer cannot prove physical closure. Retain ownership and any original evidence; never launch a replacement.
          if(!owner.run_result&&!owner.measurement)await sql.query('update job_runtime_qualification_approvals set run_result=$2::jsonb where id=$1',[approvalId,JSON.stringify({outcome:'denied',closure:'unconfirmed',reasons:['JOB_RUNTIME_QUALIFICATION_FAILED']})])
          await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb where id=$1',[approvalId,JSON.stringify({...approval,status:'recovery-required'})])
          const profile=await this.record(sql,workspaceId,approval.profileId,true)
          if(profile.activeQualificationId===approval.qualificationId&&profile.status==='qualifying'&&profile.revision===approval.profileRevision&&profile.specDigest===approval.fingerprint.specDigest)await this.put(sql,{...profile,status:'recovery-required',measurement:null,updatedAt:new Date().toISOString()})
        })
        this.changed?.()
        } catch(settlementError) {throw new AggregateError([error,settlementError],'Qualification failed and its recovery state could not be persisted.',{cause:settlementError})}
      }
      throw error
    }
  }
  async getQualification(principal:ManagementPrincipal,workspaceId:string,id:string) {
    return this.transaction(async sql=>{
      await this.authorize(sql,principal,workspaceId)
      const approval=await this.approval(sql,workspaceId,id),profile=await this.record(sql,workspaceId,approval.profileId)
      const row=(await sql.query<{measurement:unknown;run_result:JobRuntimeQualificationResult|null;native_admission:unknown}>('select measurement,run_result,native_admission from job_runtime_qualification_approvals where id=$1',[id])).rows[0]!
      const measurement=row.measurement?JobRuntimeMeasurementRecordSchema.parse(row.measurement):null
      let readiness: { ready: boolean; reasons: string[] }
      if (usesRetiredHarness(profile)) {
        readiness = { ready: false, reasons: ['HARNESS_RETIRED'] }
      }
      else if (profile.status === 'qualified' && profile.measurement
        && Date.parse(profile.measurement.expiresAt) > Date.now()) {
        readiness = await this.producer.revalidate(sql, profile)
      } else {
        const reasons = row.run_result?.outcome === 'denied' ? row.run_result.reasons
          : [`RUNTIME_${profile.status.toUpperCase().replaceAll('-', '_')}`]
        readiness = { ready: false, reasons }
      }
      await this.authorize(sql,principal,workspaceId)
      return {approval,measurement,nativeAdmission:row.native_admission?JobRuntimeNativeAdmissionRecordSchema.parse(row.native_admission):null,profile,readiness:{...readiness,sideEffects:false as const}}
    })
  }
  private async approval(sql:JobSql,workspaceId:string,id:string,lock=false):Promise<JobRuntimeApprovalRecord> {
    const row=(await sql.query<{record:unknown}>(`select record from job_runtime_qualification_approvals where workspace_id=$1 and id=$2${lock?' for update':' for share'}`,[workspaceId,id])).rows[0]
    if(!row)throw new DomainError('JOB_RUNTIME_APPROVAL_NOT_FOUND','The exact workspace qualification approval is missing.',404)
    return JobRuntimeApprovalRecordSchema.parse(row.record)
  }
  private async put(sql:JobSql,profile:JobRuntimeProfileRecord) {await sql.query('update job_runtime_profiles set record=$3::jsonb where workspace_id=$1 and id=$2',[profile.workspaceId,profile.id,JSON.stringify(JobRuntimeProfileRecordSchema.parse(profile))])}
  async choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string) {
    await this.authorize(sql,principal,workspaceId)
    const rows=await sql.query<{record:unknown}>('select record from job_runtime_profiles where workspace_id=$1 and record->>\'status\'=\'qualified\' order by id limit 100',[workspaceId])
    const profiles = rows.rows.map(row => JobRuntimeProfileRecordSchema.parse(row.record))
    const policies = []
    for (const profile of profiles) {
      if (profile.measurement && Date.parse(profile.measurement.expiresAt) > Date.now()
        && (await this.readiness(sql, profile)).ready) policies.push(jobRuntimeProfilePolicy(profile))
    }
    return policies
  }
  readiness(sql: JobSql, profile: JobRuntimeProfileRecord) {
    if (usesRetiredHarness(profile)) return Promise.resolve({ ready: false, reasons: ['HARNESS_RETIRED'] })
    if (profile.schemaVersion === 2 && (!profile.approvalConfig.review || !profile.sourceCommit)) {
      return Promise.resolve({ ready: false, reasons: ['runtime_configuration_changed'] })
    }
    if (profile.status !== 'qualified' || !profile.measurement || Date.parse(profile.measurement.expiresAt) <= Date.now()) {
      return Promise.resolve({ ready: false, reasons: ['runtime_setup_required'] })
    }
    return this.producer.revalidate(sql, profile)
  }
  async revalidate(sql:JobSql,principal:ManagementPrincipal,root:SourceRootRecord,spec:ResolvedJobDefinitionSpecRecord) {
    requireAuthorization(principal,'source_roots:read',{workspaceId:root.binding.workspaceId})
    requireAuthorization(await readLiveManagementPrincipal(sql,principal.id),'source_roots:read',{workspaceId:root.binding.workspaceId})
    const profile = await readJobRuntimeProfileVersion(sql, root.binding.workspaceId,
      spec.policy.isolationPolicyId, spec.policy.isolationPolicyRevision)
    if (usesRetiredHarness(profile)) throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    const sameNamespace=canonicalJson(profile.root.selection.hostRef)===canonicalJson(root.selection.hostRef)&&canonicalJson(profile.root.registration)===canonicalJson(root.registration)&&profile.root.selection.rootPolicyId===root.selection.rootPolicyId&&profile.root.selection.rootPolicyRevision===root.selection.rootPolicyRevision&&canonicalJson(profile.root.binding.filesystem)===canonicalJson(root.binding.filesystem)&&profile.root.binding.canonicalPath===root.binding.canonicalPath
    if(profile.status!=='qualified'||!profile.measurement||profile.revision!==spec.policy.isolationPolicyRevision||canonicalJson(jobRuntimeProfilePolicy(profile))!==canonicalJson(spec.policy)||!sameNamespace)throw new DomainError('JOB_RUNTIME_UNQUALIFIED','The exact policy/root/host has no current actual qualification.',409)
    if ('verification' in spec) {
      if (profile.schemaVersion !== 2 || !profile.measurement) throw new DomainError('JOB_RUNTIME_UNQUALIFIED','A verification Job requires its measured verification profile.',409)
      requireReviewedVerificationConfiguration(profile)
      if (profile.measurement.fingerprint.sourceCommit !== profile.sourceCommit) {
        throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'The verification measurement belongs to another qualification commit.', 409)
      }
      // Any commit with the qualified dependency files runs; changed dependencies wait for a new qualification.
      await verificationDependencyBasis(sql, root.binding.workspaceId, profile, spec.source)
      const measured = profile.measurement.suites.find(value => value.suite === spec.verification.suite)
      if (!measured || canonicalJson(measured.resources) !== canonicalJson(spec.verification.resources)
        || spec.verification.parameters.unitWorkers > Math.min(measured.maxUnitWorkers, JOB_VERIFICATION_OWNER_CONFIGURATION.unitWorkers)
        || spec.verification.parameters.integrationShards > measured.maxIntegrationShards) {
        throw new DomainError('JOB_SUITE_UNQUALIFIED','The requested suite or budget has not been measured on this profile.',409)
      }
    }
    const current=await this.producer.revalidate(sql,profile)
    if(!current.ready)throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The qualified runtime context changed.',409,{reasons:current.reasons})
  }
}
/** Passive readiness only. Current fingerprint is installed-host metadata, never supplied by an Operator caller. */
export function verificationProfileReadiness(input: {
  profile: z.infer<typeof JobVerificationProfileSchema>
  currentFingerprint: z.infer<typeof JobVerificationRuntimeFingerprintSchema> | null
  now?: number
}): { ready: boolean; reasons: string[]; sideEffects: false } {
  const profile = JobVerificationProfileSchema.parse(input.profile)
  const measurement = profile.measurement
  if (usesRetiredHarness(profile)) return { ready: false, reasons: ['HARNESS_RETIRED'], sideEffects: false }
  const now = input.now ?? Date.now()
  const denied = (reason: string) => ({ ready: false, reasons: [reason], sideEffects: false as const })
  if (!profile.approvalConfig.review || !profile.sourceCommit) return denied('runtime_configuration_changed')
  if (profile.status !== 'qualified' || !measurement) return denied('runtime_setup_required')
  if (Date.parse(measurement.expiresAt) <= now || Date.parse(measurement.identity.approvalExpiresAt) <= now) {
    return denied('qualification_expired')
  }
  if (profile.spec.policy.network.mode !== 'none') return denied('network_enforcement_unavailable')
  if (!input.currentFingerprint) return denied('runtime_context_unavailable')
  const current = JobVerificationRuntimeFingerprintSchema.parse(input.currentFingerprint)
  if (canonicalJson(current) !== canonicalJson(measurement.fingerprint)
    || jobDigest(current) !== measurement.identity.fingerprintDigest) return denied('runtime_context_changed')
  if (current.quota.workloadHardLimitBytes > current.resources.limits.diskBytes
    || current.quota.workloadHardInodes > current.resources.mutableInodes
    || current.resources.controlTempBytes + current.resources.shmBytes > current.resources.limits.memoryBytes) {
    return denied('verification_quota_unenforced')
  }
  return { ready: true, reasons: [], sideEffects: false }
}
