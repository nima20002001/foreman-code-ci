import type { JobAuthoringChoicesRecord } from '@foreman-code/contracts/job-verification'
import { withTransaction } from '../../infrastructure/transaction.js'
import { join } from 'node:path'
import type pg from 'pg'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { InstalledSourceExecutionHosts } from '../sources/executionHosts.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  ApprovedSourceSchema,
  SourceRootRecordSchema,
  SourceMaterializationRecordSchema,
  type SourceRootRecord,
  type SourceMaterializationRecord,
} from '@foreman-code/contracts/source-admission'
import { JobTargetSchema } from '@foreman-code/contracts/jobs'
import {
  ResolvedJobDefinitionSpecRecordSchema,
  PreparedJobSpecRecordSchema,
  isAutoJobSpecRecord,
  jobPolicyRequirementsRecord,
  JobOrdinaryVerificationSuiteSchema,
  jobVerificationTemplate,
  type JobDefinitionSpecRecord,
  type ResolvedJobDefinitionSpecRecord,
  type JobExecutionRecord,
} from '@foreman-code/contracts/job-verification'
import { JobRuntimeProfileRecordSchema, jobRuntimeProfilePolicy, jobRuntimeProfileLimits } from '@foreman-code/contracts/job-verification-runtime'
import { JOB_VERIFICATION_OWNER_CONFIGURATION } from '@foreman-code/contracts/job-verification-policy'
import type { JobPlacementIntent } from '@foreman-code/contracts/job-admission'
import type { JobComputerCandidate, JobComputerDiscovery } from './computerSelection.js'
import { readJobRuntimeProfileVersion } from './runtimeProfileVersion.js'
import type { PostgresSourceService } from '../sources/service.js'
import { sourceMaterializationBytes } from '../sources/footprint.js'
import { sourceBindingHash, sourceMaterializationDigest } from '../sources/bindingHash.js'
import { sourceSha256 } from '../sources/manifest.js'
import { verifiedSourceWorkingTree } from '../sources/nativeStamp.js'
import { authorizeSource } from '../sources/authority.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import { matchesRuntimePolicy } from './runtimeSelection.js'
import { DeviceAccessError } from '../devices/access.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { JobRepository, type JobSql } from './repository.js'
import { computerNameKey, readComputerNames } from '../computers/names.js'
import { JobPreparationService, type JobPreparationSources } from './preparation.js'

/** W07/CI qualification readback; no probing, installing or pulling during authoring. */
export interface JobRuntimeInventory {
  choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string):Promise<JobAuthoringChoicesRecord['policies']>
  revalidate(sql:JobSql,principal:ManagementPrincipal,root:SourceRootRecord,spec:ResolvedJobDefinitionSpecRecord):Promise<void>
}
export interface JobDefinitionInputAuthority {validateDeclaredJobInputs(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,inputs:ResolvedJobDefinitionSpecRecord['inputs']):Promise<void>}
/** Creates/replays the approved detached repository on the actual selected host. */
export interface JobPrivateRepositoryPort {
  prepare(principal:ManagementPrincipal,record:SourceMaterializationRecord):Promise<void>
}
export class CanonicalJobPreparationSources implements JobPreparationSources {
  constructor(private readonly sources:PostgresSourceService,private readonly runtime:JobRuntimeInventory,
    private readonly repositories:JobPrivateRepositoryPort,private readonly inputs:JobDefinitionInputAuthority,private readonly roots:Pick<WorkspaceRootPolicyPort,'resolve'>) {}
  async choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string):Promise<JobAuthoringChoicesRecord> {
    await authorizeSource(sql,principal,'sources:read',workspaceId)
    await authorizeSource(sql,principal,'source_roots:read',workspaceId)
    const sources=(await sql.query<{record:unknown}>(`select record from source_snapshots where workspace_id=$1 and availability='retained' order by snapshot_id limit 100`,[workspaceId])).rows.map(row=>ApprovedSourceSchema.parse(row.record)).filter(source=>source.manifest.git!==undefined).map(source=>({approvedSourceId:source.manifest.approvedSourceId,snapshotId:source.manifest.snapshotId,manifestDigest:source.manifest.manifestDigest,commit:source.manifest.git!.commit}))
    const roots=(await sql.query<{record:unknown}>(`select b.record from source_root_catalog c join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision where c.workspace_id=$1 order by c.root_id limit 100`,[workspaceId])).rows.map(row=>SourceRootRecordSchema.parse(row.record))
    const policies=await this.runtime.choices(sql,principal,workspaceId)
    const targets:JobAuthoringChoicesRecord['targets']=[]
    const names=roots.length?await readComputerNames(sql,roots[0]!.selection.hostRef.mainId):new Map<string,string>()
    for(const root of roots.filter(root=>sources.some(source=>source.snapshotId===root.source.snapshotId&&source.manifestDigest===root.source.manifestDigest))) {
      try{const target=await this.target(sql,principal,root);targets.push({id:root.binding.rootId,label:names.get(computerNameKey(root.selection.hostRef.mainId,root.selection.hostRef.kind==='device'?root.selection.hostRef.deviceId:undefined))??(root.selection.hostRef.kind==='main'?'Main computer':`Computer ${root.selection.hostRef.deviceId}`),target,ready:root.binding.accessMode==='exclusive-write',reasons:root.binding.accessMode==='exclusive-write'?[]:['SOURCE_READ_ONLY']})}
      catch (error) {
        // Retained roots on revoked devices remain history, but cannot be selected for another Job.
        if (root.selection.hostRef.kind === 'device' && error instanceof DeviceAccessError && error.code === 'revoked') {
          continue
        }
        if (!(error instanceof DomainError) || error.status >= 500 || error.status === 403) throw error
      }
    }
    const profiles = (await sql.query<{ record: unknown }>(
      'select record from job_runtime_profiles where workspace_id=$1 order by id limit 100', [workspaceId],
    )).rows.map(row => JobRuntimeProfileRecordSchema.parse(row.record))
    const autoPolicies = profiles.filter(profile => profile.status !== 'revoked').map(profile => ({
      policy: jobPolicyRequirementsRecord(jobRuntimeProfilePolicy(profile)), limits: jobRuntimeProfileLimits(profile),
    }))
    const verificationTemplates = profiles.flatMap(profile => {
      if (profile.schemaVersion !== 2 || profile.status === 'revoked') return []
      const ready = policies.some(policy => canonicalJson(policy) === canonicalJson(jobRuntimeProfilePolicy(profile)))
      return profile.spec.suites.flatMap(value => {
        const suite = JobOrdinaryVerificationSuiteSchema.safeParse(value)
        if (!suite.success) return []
        const measurement = profile.measurement
        const measuredSuite = measurement?.suites.find(item => item.suite === suite.data)
        return [jobVerificationTemplate({ profileId: profile.id, profileRevision: profile.revision,
          hostRef: profile.root.selection.hostRef,
          suite: suite.data, ready, policy: profile.spec.policy, resources: profile.spec.resources,
          maxUnitWorkers: Math.min(JOB_VERIFICATION_OWNER_CONFIGURATION.unitWorkers,
            measuredSuite?.maxUnitWorkers ?? 1),
          maxIntegrationShards: measuredSuite?.maxIntegrationShards ?? 1 })]
      })
    })
    return {sources,targets,policies,autoPolicies,verificationTemplates}
  }
  async validateAuto(sql: JobSql, principal: ManagementPrincipal, workspaceId: string, spec: JobDefinitionSpecRecord) {
    await this.inputs.validateDeclaredJobInputs(sql, principal, workspaceId, spec.inputs)
    await authorizeSource(sql, principal, 'source_roots:read', workspaceId)
    const source = await this.sources.resolveApprovedSource(sql, principal, workspaceId, {
      approvedSourceId: spec.source.approvedSourceId, snapshotId: spec.source.snapshotId, manifestDigest: spec.source.manifestDigest,
    })
    if (source.manifest.git?.commit !== spec.source.commit) {
      throw new DomainError('JOB_SOURCE_PIN_CONFLICT', 'The saved commit differs from the approved snapshot.', 409)
    }
    return { valid: true, reasons: [], sideEffects: false as const, source }
  }
  async candidates(sql: JobSql, principal: ManagementPrincipal, workspaceId: string,
    spec: JobDefinitionSpecRecord, placement?: JobPlacementIntent,
    options: { queued?: boolean } = {}): Promise<JobComputerDiscovery> {
    const { source } = await this.validateAuto(sql, principal, workspaceId, spec)
    const historical = options.queued || 'verification' in spec
    const roots = (await sql.query<{ record: unknown }>(historical
      // Queued Jobs keep their captured source when later commits rebind the same root.
      ? `select distinct on (b.root_id) b.record from source_root_bindings b where b.workspace_id=$1 and b.snapshot_id=$2
          and ($3::text is null or b.record->>'attestationId'=$3)
          order by b.root_id,b.binding_revision desc limit 100`
      : `select b.record from source_root_catalog c join source_root_bindings b
          on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
          where c.workspace_id=$1 order by c.root_id limit 100`,
    historical ? [workspaceId, spec.source.snapshotId,
      isAutoJobSpecRecord(spec) ? null : spec.target.destination.attestationId] : [workspaceId]))
      .rows.map(row => SourceRootRecordSchema.parse(row.record))
    const profiles = isAutoJobSpecRecord(spec) ? (await sql.query<{ record: unknown }>(
      'select record from job_runtime_profiles where workspace_id=$1 order by id limit 100', [workspaceId],
    )).rows.map(row => JobRuntimeProfileRecordSchema.parse(row.record))
      : [await readJobRuntimeProfileVersion(sql, workspaceId,
        spec.policy.isolationPolicyId, spec.policy.isolationPolicyRevision)]
    const candidates: JobComputerCandidate[] = []
    const diagnosticCodes: string[] = []
    if (!isAutoJobSpecRecord(spec)) {
      const fixedTarget = spec.target
      const root = roots.find(root => root.selection.rootPolicyId === fixedTarget.destination.rootPolicyId)
      if (!root || canonicalJson(root.source) !== canonicalJson({ approvedSourceId: spec.source.approvedSourceId,
        snapshotId: spec.source.snapshotId, manifestDigest: spec.source.manifestDigest })) {
        throw new DomainError('JOB_ROOT_PIN_CONFLICT', 'The saved build root or source binding changed.', 409)
      }
      if (!profiles.some(profile => canonicalJson(jobRuntimeProfilePolicy(profile)) === canonicalJson(spec.policy))) {
        throw new DomainError('JOB_RUNTIME_UNQUALIFIED', 'The saved runtime policy is no longer qualified.', 409)
      }
    }
    for (const root of roots) {
      if (placement?.kind === 'explicit'
        && (root.selection.rootPolicyId !== placement.target.destination.rootPolicyId
          || canonicalJson(root.selection.hostRef) !== canonicalJson(placement.target.hostRef))) continue
      if (root.binding.accessMode !== 'exclusive-write' || root.source.snapshotId !== spec.source.snapshotId
        || root.source.manifestDigest !== spec.source.manifestDigest || root.source.approvedSourceId !== spec.source.approvedSourceId) continue
      const matchingProfiles = profiles.filter(profile =>
        canonicalJson(profile.root.selection.hostRef) === canonicalJson(root.selection.hostRef)
        && profile.root.selection.rootPolicyId === root.selection.rootPolicyId
        && (isAutoJobSpecRecord(spec)
          ? matchesRuntimePolicy(spec, profile)
            && canonicalJson(jobRuntimeProfileLimits(profile)) === canonicalJson(spec.limits)
          : canonicalJson(jobRuntimeProfilePolicy(profile)) === canonicalJson(spec.policy)))
      if (!matchingProfiles.length) continue
      let target: ResolvedJobDefinitionSpecRecord['target']
      try { target = await this.target(sql, principal, root) } catch (error) {
        const fixedRoot = !isAutoJobSpecRecord(spec) && root.selection.rootPolicyId === spec.target.destination.rootPolicyId
        if (fixedRoot) throw error
        if (error instanceof DeviceAccessError || error instanceof DomainError && [403, 409].includes(error.status)) {
          diagnosticCodes.push(error.code)
          continue
        }
        throw error
      }
      if (!isAutoJobSpecRecord(spec) && canonicalJson(target) !== canonicalJson(spec.target)) {
        if (root.selection.rootPolicyId === spec.target.destination.rootPolicyId) {
          throw new DomainError('JOB_ROOT_PIN_CONFLICT', 'The saved build root or computer identity changed.', 409)
        }
        continue
      }
      for (const profile of matchingProfiles) {
        if (('verification' in spec) !== (profile.schemaVersion === 2)) continue
        const resolved = ResolvedJobDefinitionSpecRecordSchema.parse({
          source: spec.source, argv: spec.argv, inputs: spec.inputs, outputs: spec.outputs,
          ...(spec.relativeCwd ? { relativeCwd: spec.relativeCwd } : {}),
          ...('verification' in spec ? { verification: spec.verification } : {}), target, policy: jobRuntimeProfilePolicy(profile),
        })
        const binding = root.binding
        const scopeId = `${binding.mainId}:${binding.deviceId ?? 'original-main'}:${binding.workerInstallationId ?? binding.mainId}:${binding.filesystem.device}:${binding.filesystem.mountId}`
        const candidate: JobComputerCandidate = { spec: resolved, profile, ready: true, reasons: [],
          sourceReservation: { scopeId, reservedBytes: sourceMaterializationBytes(source.manifest) } }
        if (profile.status !== 'qualified' || !profile.measurement || Date.parse(profile.measurement.expiresAt) <= Date.now()) {
          candidate.ready = false
          if (profile.status === 'revoked') candidate.reasons = ['authorization_revoked']
          else if (profile.measurement && Date.parse(profile.measurement.expiresAt) <= Date.now()) {
            candidate.reasons = ['qualification_expired']
          } else candidate.reasons = ['runtime_setup_required']
          candidates.push(candidate)
          continue
        }
        try {
          await this.sources.resolveRootBinding(sql, principal, { workspaceId, rootId: root.binding.rootId,
            bindingRevision: root.binding.bindingRevision, source: root.source })
          await this.runtime.revalidate(sql, principal, root, resolved)
        } catch (error) {
          if (!(error instanceof DomainError) && !(error instanceof DeviceAccessError)) throw error
          candidate.ready = false
          candidate.reasons = [error.code]
        }
        candidates.push(candidate)
      }
    }
    return { candidates, diagnosticCodes: [...new Set(diagnosticCodes)] }
  }
  private async target(sql:JobSql,principal:ManagementPrincipal,root:SourceRootRecord) {
    const policy=await this.roots.resolve(sql,principal,{workspaceId:root.binding.workspaceId,...root.selection})
    const main=(await sql.query<{id:string}>('select id from application_installation where singleton=true for share')).rows[0]
    if(!main||main.id!==root.binding.mainId||policy.hostRef.mainId!==main.id||canonicalJson(policy.hostRef)!==canonicalJson(root.selection.hostRef)||canonicalJson(policy.registration)!==canonicalJson(root.registration)||root.binding.canonicalPath!==join(policy.managedRuntimeRoot,'source-materializations',policy.rootPolicyId))throw new DomainError('JOB_ROOT_PIN_CONFLICT','The original root namespace, registration or actual main installation changed.',409)
    return JobTargetSchema.parse({schemaVersion:1,mainId:main.id,mainInstallationId:main.id,hostRef:root.selection.hostRef,registration:root.registration,
      destination:{canonicalProjectRoot:root.binding.canonicalPath,canonicalCwd:root.binding.canonicalPath,managedRuntimeRoot:policy.managedRuntimeRoot,
        directoryIdentityHash:sourceSha256(Buffer.from(JSON.stringify(root.binding.filesystem))),rootPolicyId:root.selection.rootPolicyId,rootPolicyRevision:root.selection.rootPolicyRevision,locationRevision:root.selection.locationRevision,attestationId:root.attestationId,attestationHash:root.attestationDigest}})
  }
  private async root(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:ResolvedJobDefinitionSpecRecord,
    options: { queued?: boolean } = {}) {
    const row=(await sql.query<{record:unknown}>(options.queued || 'verification' in spec
      ? `select b.record from source_root_bindings b where b.workspace_id=$1 and b.record->>'attestationId'=$2 for share of b`
      : `select b.record from source_root_catalog c join source_root_bindings b
          on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
          where c.workspace_id=$1 and b.record->>'attestationId'=$2 for share of b,c`,[workspaceId,spec.target.destination.attestationId])).rows
    if(row.length!==1)throw new DomainError('JOB_ROOT_PIN_CONFLICT','The captured job root attestation is unavailable.',409)
    const root=SourceRootRecordSchema.parse(row[0]!.record)
    if(root.binding.accessMode!=='exclusive-write'||canonicalJson(await this.target(sql,principal,root))!==canonicalJson(spec.target))throw new DomainError('JOB_ROOT_PIN_CONFLICT','The saved target is not the current exclusive job source root.',409)
    if(canonicalJson(root.source)!==canonicalJson({approvedSourceId:spec.source.approvedSourceId,snapshotId:spec.source.snapshotId,manifestDigest:spec.source.manifestDigest}))throw new DomainError('JOB_SOURCE_PIN_CONFLICT','The target root is bound to a different exact approved snapshot.',409)
    const source=await this.sources.resolveApprovedSource(sql,principal,workspaceId,{approvedSourceId:spec.source.approvedSourceId,snapshotId:spec.source.snapshotId,manifestDigest:spec.source.manifestDigest})
    if(source.manifest.git?.commit!==spec.source.commit)throw new DomainError('JOB_SOURCE_PIN_CONFLICT','The saved commit differs from the approved snapshot.',409)
    await this.sources.resolveRootBinding(sql,principal,{workspaceId,rootId:root.binding.rootId,bindingRevision:root.binding.bindingRevision,source:root.source})
    await this.runtime.revalidate(sql,principal,root,spec)
    return root
  }
  async validateSelection(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:ResolvedJobDefinitionSpecRecord,
    options: { queued?: boolean } = {}) {
    await this.inputs.validateDeclaredJobInputs(sql,principal,workspaceId,spec.inputs)
    await this.root(sql,principal,workspaceId,spec,options)
  }
  async materialize(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:ResolvedJobDefinitionSpecRecord,identity:{executionId:string;attemptId:string;operationId:string}) {
    await this.inputs.validateDeclaredJobInputs(sql,principal,workspaceId,spec.inputs)
    const root=await this.root(sql,principal,workspaceId,spec,{ queued: true })
    const attempt={executionId:identity.executionId,attemptId:identity.attemptId,keyRevision:root.registration?.keyRevision??null,authorizationRevision:root.registration?.authorizationRevision??null}
    const record=await this.sources.prepareExecution({principal,workspaceId,rootId:root.binding.rootId,bindingRevision:root.binding.bindingRevision,source:root.source,operationId:identity.operationId,attempt:{...attempt,placementHash:sourceBindingHash(root,attempt,identity.operationId)}})
    await this.repositories.prepare(principal,record)
    const path=await this.sources.verifyPreparation({principal,record}),tree=verifiedSourceWorkingTree(record,path)
    return PreparedJobSpecRecordSchema.parse({...spec,source:{...spec.source,materializationId:record.receipt.materializationId,materializationDigest:sourceMaterializationDigest(record)},
      target:{...spec.target,destination:{...spec.target.destination,canonicalProjectRoot:tree.canonicalProjectRoot,canonicalCwd:spec.relativeCwd?join(tree.canonicalProjectRoot,spec.relativeCwd):tree.canonicalCwd,directoryIdentityHash:tree.directoryIdentityHash}}})
  }
  async revalidateAccepted(sql:JobSql,principal:ManagementPrincipal,execution:JobExecutionRecord,
    options?: { requireQualification: boolean }) {
    const row=(await sql.query<{record:unknown;state:string}>('select record,state from source_execution_materializations where materialization_id=$1 and workspace_id=$2 and execution_id=$3 and attempt_id=$4 for share',[execution.acceptedSpec.source.materializationId,execution.workspaceId,execution.id,execution.attemptId])).rows[0]
    if(!row)throw new DomainError('SOURCE_ATTEMPT_CONFLICT','The original accepted source materialization is missing.',409)
    const record=SourceMaterializationRecordSchema.parse(row.record)
    record.state=SourceMaterializationRecordSchema.shape.state.parse(row.state)
    if(!['prepared','running','closed'].includes(record.state)||record.operationId!==execution.operationId||record.finalDispatchBindingHash!==execution.acceptedSpec.bindingHash||sourceMaterializationDigest(record)!==execution.acceptedSpec.source.materializationDigest)throw new DomainError('SOURCE_ATTEMPT_CONFLICT','The original accepted source binding changed.',409)
    const source={approvedSourceId:execution.acceptedSpec.source.approvedSourceId,snapshotId:execution.acceptedSpec.source.snapshotId,manifestDigest:execution.acceptedSpec.source.manifestDigest}
    const root=await this.sources.resolveRootBinding(sql,principal,{workspaceId:execution.workspaceId,rootId:record.receipt.binding.rootId,bindingRevision:record.receipt.binding.bindingRevision,source})
    if(root.attestationId!==execution.acceptedSpec.target.destination.attestationId||root.attestationDigest!==execution.acceptedSpec.target.destination.attestationHash||canonicalJson(root.registration)!==canonicalJson(execution.acceptedSpec.target.registration))throw new DomainError('JOB_ROOT_PIN_CONFLICT','The original accepted root/registration differs from its stored materialization.',409)
    await new JobRepository().version(sql,execution.workspaceId,execution.acceptedSpec.definitionVersionId,execution.acceptedSpec.definitionId)
    if (options?.requireQualification) await this.runtime.revalidate(sql,principal,root,execution.acceptedSpec)
  }
  async adoptFinalBinding(sql:JobSql,principal:ManagementPrincipal,execution:JobExecutionRecord) {
    const row=(await sql.query<{record:unknown}>('select record from source_execution_materializations where materialization_id=$1 and execution_id=$2 and attempt_id=$3 for update',[execution.acceptedSpec.source.materializationId,execution.id,execution.attemptId])).rows[0]
    if(!row)throw new DomainError('SOURCE_ATTEMPT_CONFLICT','The actual prepared job source is missing.',409)
    const record=SourceMaterializationRecordSchema.parse(row.record)
    if(record.operationId!==execution.operationId||sourceMaterializationDigest(record)!==execution.acceptedSpec.source.materializationDigest)throw new DomainError('SOURCE_ATTEMPT_CONFLICT','The job source belongs to another original operation.',409)
    await this.sources.adoptFinalBinding(sql,principal,record,execution.acceptedSpec.bindingHash)
  }
}

/** Includes the source/root pairing check before Save as well as native preparation. */
export class CanonicalJobPreparationService extends JobPreparationService {
  constructor(private readonly canonicalSources:CanonicalJobPreparationSources) {super(canonicalSources)}
  override async accept(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,
    spec:ResolvedJobDefinitionSpecRecord,identity:{executionId:string;attemptId:string;operationId:string}) {
    return PreparedJobSpecRecordSchema.parse(
      await this.canonicalSources.materialize(sql,principal,workspaceId,spec,identity))
  }
  override async validate(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:JobDefinitionSpecRecord,
    options: { queued?: boolean } = {}) {
    if (isAutoJobSpecRecord(spec)) {
      const { valid, reasons, sideEffects } = await this.canonicalSources.validateAuto(sql, principal, workspaceId, spec)
      return { valid, reasons, sideEffects }
    }
    try {
      await this.canonicalSources.validateSelection(sql,principal,workspaceId,spec,options)
      return { valid: true, reasons: [], sideEffects: false as const }
    } catch (error) {
      if (!(error instanceof DomainError) || error.status !== 409) throw error
      componentLogger('jobs').warn({code:error.code,reason:error.message,details:error.details},'Canonical Job validation denied')
      return { valid: false, reasons: [error.code], sideEffects: false as const }
    }
  }
}

/** Original-main implementation reuses the W09 detached repository writer. Remote
 * requests stay on its authenticated source host, carrying the original record. */
export class CanonicalJobPrivateRepositories implements JobPrivateRepositoryPort {
  constructor(private readonly pool:pg.Pool,private readonly sources:PostgresSourceService,
    private readonly hosts:InstalledSourceExecutionHosts,
    private readonly remote:{preparePrivateRepository(principal:ManagementPrincipal,record:SourceMaterializationRecord):Promise<void>}) {}
  async prepare(principal:ManagementPrincipal,record:SourceMaterializationRecord) {
    if(record.receipt.binding.deviceId!==null)return this.remote.preparePrivateRepository(principal,record)
    const manifest=await withTransaction(this.pool,async(sql)=>{
      const row=(await sql.query<{record:unknown}>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',[record.receipt.binding.rootId,record.receipt.binding.bindingRevision])).rows[0]
      const root=SourceRootRecordSchema.parse(row?.record)
      const source=await this.sources.resolveApprovedSource(sql,principal,record.receipt.binding.workspaceId,root.source)
      return source.manifest
    })
    await this.sources.verifyPreparation({principal,record})
    await this.hosts.privateRepository(record,manifest)
  }
}
