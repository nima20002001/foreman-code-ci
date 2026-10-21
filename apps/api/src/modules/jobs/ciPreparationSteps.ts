import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import type { CiRuntimeRequest, CiRuntimeWorkerState } from '@foreman-code/contracts'
import type { JobRuntimeProfiles } from './runtimeProfiles.js'
import type { PostgresSourceService } from '../sources/service.js'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { CiPreparationRecord } from './ciPreparationRepository.js'
import { temporaryCiConnectionError } from './ciRuntimeErrors.js'

export interface CiPreparationStepPorts {
  profiles: Pick<JobRuntimeProfiles, 'list' | 'save' | 'requestQualification' | 'qualify'>
  sources: Pick<PostgresSourceService, 'approveProject' | 'rootList' | 'bindRoot'>
  principal(): Promise<ManagementPrincipal>
  signal: AbortSignal
  checkpoint(): Promise<void>
  device(request: CiRuntimeRequest): Promise<CiRuntimeWorkerState>
  /** Images every current verification profile on this computer uses, across workspaces. */
  deviceImages(): Promise<string[]>
  repository(workspaceId: string): Promise<string>
  /** The computer fetches the commit from GitHub; Main publishes an Agent's commit there first. */
  publish(repository: string, commit: string): Promise<void>
  wait(): Promise<void>
  now(): Date
}

export async function runCiPreparation(record: CiPreparationRecord, ports: CiPreparationStepPorts): Promise<void> {
  const update = async (state: CiPreparationRecord['status']['state'], stage: string | null = null) => {
    record.status = { ...record.status, state, stage, message: null }
    if (state === 'qualified') record.status.failureCount = 0
    await ports.checkpoint()
  }
  if (!record.manifest) {
    const approved = await ports.sources.approveProject(await ports.principal(), {
      workspaceId: record.input.workspaceId, commandId: `${record.id}:source`,
      ...(record.input.commit ? { commit: record.input.commit } : {}),
    })
    record.manifest = approved.manifest
    record.status.commit = approved.manifest.git!.commit
    await ports.checkpoint()
  }
  const commit = record.manifest.git!.commit
  if (!record.prepared) {
    await update('preparing')
    const repository = record.manifest.git!.repository ?? await ports.repository(record.input.workspaceId)
    await ports.publish(repository, commit)
    let state = await ports.device({ operation: 'prepare', operationId: record.id,
      repository, commit,
      review: { reviewedByPrincipalId: record.principal.id,
        decisionDigest: record.profile.approvalConfig.review!.decisionDigest },
      keepImages: [...new Set([record.profile.spec.policy.imageDigest, ...await ports.deviceImages()])] })
    while (state.state === 'preparing' && state.operationId === record.id) {
      if (state.cache) record.status.cache = state.cache
      if (state.preparationLimits) record.status.preparationLimits = state.preparationLimits
      await update('preparing', state.stage)
      await ports.wait()
      state = await ports.device({ operation: 'status' })
    }
    if (state.state !== 'prepared' || state.operationId !== record.id || state.commit !== commit || !state.prepared) {
      throw new DomainError('CI_RUNTIME_PREPARE_FAILED', state.message ?? 'The computer could not prepare its CI runtime.', 502)
    }
    record.prepared = state.prepared
    if (state.cache) record.status.cache = state.cache
    if (state.preparationLimits) record.status.preparationLimits = state.preparationLimits
    await ports.checkpoint()
  }
  if (record.prepared.reusedImage) {
    const listed = await ports.profiles.list(await ports.principal(), record.input.workspaceId)
    const reusable = listed.profiles.find(value => value.profile.id === record.profile.id
      && value.profile.revision === record.profile.revision && value.ready)
    if (reusable?.profile.schemaVersion === 2 && reusable.profile.status === 'qualified'
      && reusable.profile.spec.policy.imageDigest === record.prepared.imageId) {
      record.status = { ...record.status, state: 'qualified', stage: null, message: null,
        failureCount: 0,
        profiles: [{ profileId: reusable.profile.id, revision: reusable.profile.revision, status: 'qualified' }],
        reuse: { image: true, qualification: true, qualificationSourceCommit: reusable.profile.sourceCommit ?? null } }
      await ports.checkpoint()
      return
    }
  }
  record.status.reuse = { image: record.prepared.reusedImage ?? false,
    qualification: false, qualificationSourceCommit: null }
  if (!record.root) {
    await update('binding')
    await bindPreparedRoot(record, ports)
  }
  await savePreparedProfiles(record, ports)
  if (!record.refreshed) {
    record.refreshStartedAt ??= ports.now().toISOString()
    await update('refreshing', 'restart')
    await refreshPreparedRuntime(record, ports)
    record.refreshed = true
    await ports.checkpoint()
  }
  await update('qualifying')
  for (const saved of record.saves!) {
    if (saved.qualified) continue
    const profile = saved.profile!
    await update('qualifying', profile.name)
    if (!saved.approvalId) {
      const approval = await ports.profiles.requestQualification(await ports.principal(), record.source,
        record.input.workspaceId, { commandId: `${record.id}:capture:${profile.id}`,
          profileId: profile.id, expectedRevision: profile.revision })
      saved.approvalId = approval.id
      await ports.checkpoint()
    }
    const qualified = await ports.profiles.qualify(await ports.principal(), record.source, record.input.workspaceId,
      `${record.id}:qualify:${profile.id}`, saved.approvalId, { signal: ports.signal })
    if (qualified.schemaVersion !== 2 || qualified.status !== 'qualified') {
      throw new DomainError('CI_RUNTIME_QUALIFICATION_FAILED', `${profile.name} did not qualify at ${commit.slice(0, 12)}.`, 502)
    }
    saved.qualified = qualified
    record.status.profiles = record.status.profiles.map(entry => entry.profileId === profile.id
      ? { ...entry, revision: qualified.revision, status: qualified.status } : entry)
    await ports.checkpoint()
  }
  await update('qualified')
}

async function bindPreparedRoot(record: CiPreparationRecord, ports: CiPreparationStepPorts): Promise<void> {
  const manifest = record.manifest!
  const pin = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  if (!record.rootInput) {
    const current = (await ports.sources.rootList(await ports.principal(), record.source,
      { workspaceId: record.input.workspaceId, limit: 100 })).items
      .find(root => root.binding.rootId === record.profile.root.binding.rootId)
    if (!current) throw new DomainError('SOURCE_ROOT_NOT_FOUND', 'The build computer’s root is no longer bound.', 404)
    if (canonicalJson(current.source) === canonicalJson(pin)) {
      record.root = current
    } else {
      record.rootInput = { workspaceId: record.input.workspaceId, source: pin, selection: current.selection,
        accessMode: current.binding.accessMode, expectedBindingRevision: current.binding.bindingRevision,
        commandId: `${record.id}:root` }
    }
    await ports.checkpoint()
  }
  if (!record.root) {
    record.root = (await ports.sources.bindRoot(await ports.principal(), record.source, record.rootInput!)).value
    await ports.checkpoint()
  }
}

async function savePreparedProfiles(record: CiPreparationRecord, ports: CiPreparationStepPorts): Promise<void> {
  if (!record.saves) {
    const runtime = (profile: JobVerificationProfile) => canonicalJson({ resources: profile.spec.resources,
      network: profile.spec.policy.network, toolchain: profile.spec.policy.toolchainDigest,
      approval: profile.spec.approvalConfig })
    const profiles = (await ports.profiles.list(await ports.principal(), record.input.workspaceId)).profiles
      .map(value => value.profile).filter((profile): profile is JobVerificationProfile => profile.schemaVersion === 2
        && profile.status !== 'revoked' && profile.root.binding.rootId === record.root!.binding.rootId
        && runtime(profile) === runtime(record.profile))
      .sort((left, right) => Number(right.id === record.profile.id) - Number(left.id === record.profile.id))
    record.saves = profiles.map(profile => ({ input: {
      commandId: `${record.id}:profile:${profile.id}`, id: profile.id, expectedRevision: profile.revision,
      name: profile.name, spec: { ...profile.spec, rootId: record.root!.binding.rootId,
        bindingRevision: record.root!.binding.bindingRevision,
        policy: { ...profile.spec.policy, imageDigest: record.prepared!.imageId } },
    } }))
    if (!record.saves.length) throw new DomainError('JOB_RUNTIME_PROFILE_NOT_FOUND', 'The prepared profiles were removed.', 404)
    await ports.checkpoint()
  }
  for (const saved of record.saves) {
    if (saved.profile) continue
    const profile = await ports.profiles.save(await ports.principal(), record.source, record.input.workspaceId, saved.input)
    if (profile.schemaVersion !== 2) throw new DomainError('JOB_RUNTIME_PROFILE_SCOPE_CONFLICT', 'The verification profile changed.', 409)
    saved.profile = profile
    record.status.profiles.push({ profileId: profile.id, revision: profile.revision, status: profile.status })
    await ports.checkpoint()
  }
}

async function refreshPreparedRuntime(record: CiPreparationRecord, ports: CiPreparationStepPorts): Promise<void> {
  for (;;) {
    if (ports.now().getTime() > Date.parse(record.refreshStartedAt!) + 15 * 60_000) {
      throw new DomainError('CI_RUNTIME_TIMEOUT', 'The computer did not come back after its runtime refresh.', 504)
    }
    const state = await ports.device({ operation: 'status' })
    if (state.operationId === record.id) {
      if (state.state === 'failed') {
        throw new DomainError('CI_RUNTIME_REFRESH_FAILED', state.message ?? 'The runtime refresh failed.', 502)
      }
      if (state.state === 'idle' && state.commit === record.status.commit && state.stage === 'refresh') return
      if (state.state === 'prepared') {
        try {
          await ports.device({ operation: 'refresh', operationId: record.id, commit: record.status.commit!,
            root: record.root!, manifest: record.manifest!, resources: record.profile.spec.resources })
        } catch (error) {
          if (!temporaryCiConnectionError(error)) throw error
          // The Worker may have accepted refresh before its channel closed; status reconciles that operation.
        }
      }
    }
    await ports.wait()
  }
}
