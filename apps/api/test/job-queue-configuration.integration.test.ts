import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobBuildQueueConfiguration, JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { ResolvedJobDefinitionSpecSchema } from '@foreman-code/contracts/jobs'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { JobService, jobDigest } from '../src/modules/jobs/service.js'
import { createProductionJobs, createReviewedBuildQueueConfiguration,
  readBuildQueueConfiguration } from '../src/modules/jobs/production.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { jobRuntimeMetadataFixture } from './helpers/jobRuntimeMetadataFixture.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { workerClockReason } from '../src/modules/devices/workerClock.js'

describe.skipIf(!postgresEnabled)('build queue persistence and owner configuration', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let principal: Awaited<ReturnType<PostgresAccessService['issue']>>['principal']
  const services: JobService[] = []
  beforeEach(async () => {
    database = await agent3Database()
    const access = new PostgresAccessService(database.pool)
    principal = (await access.issue({ name: 'Queue configuration fixture', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ scope: {}, actions: [
        'job_definitions:read', 'job_definitions:write', 'jobs:read', 'jobs:start', 'jobs:cancel',
        'settings:read', 'settings:update',
        'sources:read', 'source_roots:read',
      ] }] })).principal
  }, 60000)
  afterEach(async () => {
    await Promise.allSettled(services.splice(0).map(service => service.closeQueue()))
    vi.restoreAllMocks()
    await database?.close()
  })
  async function fixture() {
    const f = await buildQueueFixture(database.pool, principal)
    services.push(f.jobs)
    return f
  }
  async function configuration(f: Awaited<ReturnType<typeof fixture>>): Promise<JobBuildQueueConfiguration> {
    const definition = await f.save()
    const policy = { schemaVersion: 1 as const, mainId: f.computers[0]!.candidate.spec.target.mainId,
      revision: 1, limits: f.queue.limits,
      envelopes: [await f.queue.resources(database.pool, definition)] }
    return { ...policy, review: { reviewedByPrincipalId: principal.id,
      reviewedAt: new Date().toISOString(), decisionDigest: jobDigest(policy) } }
  }
  async function submit(f: Awaited<ReturnType<typeof fixture>>) {
    const definition = await f.save()
    const result = await f.jobs.enqueue(principal, 'http', f.workspaceId, {
      commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision,
    })
    if (result.kind !== 'pending-admission') throw new Error('Offline fixture must remain pending')
    await f.jobs.wakeQueue()
    return f.jobs.getQueueTicket(principal, f.workspaceId, result.ticket.id)
  }
  function update(ticket: JobQueueTicket) {
    const record = structuredClone(ticket)
    delete record.selectedComputer
    delete record.cleanupStatus
    return database.pool.query('update job_admission_queue set record=$2::jsonb where id=$1',
      [ticket.id, JSON.stringify(record)])
  }
  it('rejects changed request facts, history deletion, scope mismatch and invalid public revisions', async () => {
    const f = await fixture()
    const ticket = await submit(f)
    const mutations: Array<(value: JobQueueTicket) => void> = [
      value => { value.definition.versionId = randomUUID() },
      value => { value.definition.spec.source.commit = '3'.repeat(40) },
      value => { value.definition.spec.argv = ['node', 'other.mjs'] },
      value => { value.definition.spec.inputs = [{ fileId: 'other', revisionId: 'other', path: 'input',
        sha256: '3'.repeat(64), byteSize: 1 }] },
      value => { value.definition.spec.outputs = [{ path: 'report.json', required: true, mediaType: 'application/json' }] },
      value => { value.definition.spec.policy.executionTimeoutMs++ },
      value => { value.executionId = randomUUID() },
      value => { value.attemptId = randomUUID() },
      value => { value.operationId = randomUUID() },
      value => { value.commandDigest = '3'.repeat(64) },
      value => { value.placementOverride = { kind: 'auto' } },
      value => { value.resources.mutableInodes++ },
      value => { value.enqueueSequence = '999999' },
      value => { value.enqueuedAt = new Date(Date.parse(value.enqueuedAt) + 1).toISOString() },
      value => { value.deadlineAt = new Date(Date.parse(value.deadlineAt) + 1).toISOString() },
      value => { value.workspaceId = randomUUID() },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(ticket)
      mutate(changed)
      changed.revision++
      await expect(update(changed)).rejects.toThrow('JOB_QUEUE_REQUEST_IMMUTABLE')
    }
    await expect(update({ ...ticket, revision: ticket.revision + 1 })).rejects.toThrow('JOB_QUEUE_REVISION_CONFLICT')
    await expect(update({ ...ticket, waitingReasons: ['busy'] })).rejects.toThrow('JOB_QUEUE_REVISION_CONFLICT')
    await expect(database.pool.query('delete from job_admission_queue where id=$1', [ticket.id]))
      .rejects.toThrow('JOB_QUEUE_HISTORY_IMMUTABLE')
    await expect(database.pool.query('delete from job_definition_versions where id=$1', [ticket.definition.versionId]))
      .rejects.toThrow()
    const duplicate = { ...ticket, id: randomUUID(), commandId: randomUUID(), executionId: randomUUID(),
      operationId: randomUUID(), enqueueSequence: '999999', revision: 1, state: 'waiting', waitingReasons: [] }
    const insert = (commandId: string) => database.pool.query(`insert into job_admission_queue
      (id,workspace_id,principal_id,command_id,execution_id,enqueue_sequence,record)
      values($1,$2,$3,$4,$5,$6,$7::jsonb)`, [duplicate.id, duplicate.workspaceId, duplicate.principalId,
      commandId, duplicate.executionId, duplicate.enqueueSequence, JSON.stringify(duplicate)])
    await expect(insert(duplicate.commandId)).rejects.toThrow()
    duplicate.attemptId = randomUUID()
    await expect(insert('column-record-mismatch')).rejects.toThrow()
    await expect(update({ ...ticket, revision: ticket.revision + 1, state: 'accepted', reservationId: ticket.id }))
      .rejects.toThrow('JOB_QUEUE_STATE_CONFLICT')
    await expect(update({ ...ticket, revision: ticket.revision + 1, state: 'claimed', reservationId: ticket.id }))
      .rejects.toThrow('JOB_QUEUE_SELECTION_CONFLICT')
    expect(await f.jobs.getQueueTicket(principal, f.workspaceId, ticket.id)).toEqual(ticket)
    await database.pool.query(`update job_admission_queue set diagnostic_codes='["offline"]'::jsonb,
      backfill_claims=1,owner_id='1',owner_fence='1' where id=$1`, [ticket.id])
    expect(await f.jobs.getQueueTicket(principal, f.workspaceId, ticket.id)).toEqual(ticket)
    await expect(database.pool.query('update job_admission_queue set backfill_claims=0 where id=$1', [ticket.id]))
      .rejects.toThrow('JOB_QUEUE_BACKFILL_CONFLICT')
    await update({ ...ticket, revision: ticket.revision + 1, waitingReasons: ['busy'] })
    expect(await f.jobs.getQueueTicket(principal, f.workspaceId, ticket.id))
      .toMatchObject({ revision: ticket.revision + 1, waitingReasons: ['busy'] })
  })
  it('retains the original selection, cancellation timestamp and accepted identity', async () => {
    const f = await fixture()
    const original = await submit(f)
    const cancelled = await f.jobs.cancelQueued(principal, 'http', f.workspaceId, {
      commandId: randomUUID(), ticketId: original.id, expectedRevision: original.revision,
    })
    await expect(update({ ...cancelled, revision: cancelled.revision + 1,
      cancelRequestedAt: new Date(Date.parse(cancelled.cancelRequestedAt!) + 1).toISOString() }))
      .rejects.toThrow('JOB_QUEUE_CANCELLATION_IMMUTABLE')
    const waiting = await submit(f)
    f.online()
    await f.jobs.wakeQueue()
    const accepted = await f.jobs.getQueueTicket(principal, f.workspaceId, waiting.id)
    expect(accepted).toMatchObject({ state: 'accepted', executionId: waiting.executionId,
      attemptId: waiting.attemptId, operationId: waiting.operationId, reservationId: waiting.id })
    await expect(update({ ...accepted, revision: accepted.revision + 1, reservationId: randomUUID() }))
      .rejects.toThrow('JOB_QUEUE_RESERVATION_IMMUTABLE')
    await expect(update({ ...accepted, revision: accepted.revision + 1, state: 'claimed' }))
      .rejects.toThrow('JOB_QUEUE_STATE_CONFLICT')
  })
  it('reads a private regular owner file and rejects symlinks, hard links and unprotected metadata', async () => {
    const f = await fixture()
    const config = await configuration(f)
    const directory = join(database.directory, randomUUID())
    await mkdir(directory, { mode: 0o700 })
    const path = join(directory, 'job-queue.json')
    expect(await readBuildQueueConfiguration(path)).toBeNull()
    await writeFile(path, JSON.stringify(config), { mode: 0o600 })
    expect(await readBuildQueueConfiguration(path)).toEqual(config)
    const linked = join(directory, 'linked.json')
    await symlink(path, linked)
    await expect(readBuildQueueConfiguration(linked)).rejects.toMatchObject({ code: 'ELOOP' })
    await chmod(path, 0o644)
    await expect(readBuildQueueConfiguration(path)).rejects.toMatchObject({ code: 'JOB_QUEUE_CONFIGURATION_UNPROTECTED' })
    await chmod(path, 0o600)
    await chmod(directory, 0o777)
    await expect(readBuildQueueConfiguration(path)).rejects.toMatchObject({ code: 'JOB_QUEUE_CONFIGURATION_UNPROTECTED' })
    await chmod(directory, 0o700)
    await link(path, join(directory, 'hard.json'))
    await expect(readBuildQueueConfiguration(path)).rejects.toMatchObject({ code: 'JOB_QUEUE_CONFIGURATION_UNPROTECTED' })
  })
  it('resolves saved Auto limits and immutable fixed-profile limits with review, scope and envelope checks', async () => {
    const f = await fixture()
    const config = await configuration(f)
    const mainId = config.mainId
    expect(() => createReviewedBuildQueueConfiguration(config, randomUUID())).toThrow('Queue review differs')
    expect(() => createReviewedBuildQueueConfiguration({ ...config, revision: 2 }, mainId)).toThrow('Queue review differs')
    const queue = createReviewedBuildQueueConfiguration(config, mainId)
    const auto = await f.save()
    expect(await queue.resources(database.pool, auto)).toEqual(config.envelopes[0])
    const profile = f.computers[0]!.candidate.profile
    const fixed = await f.save(f.computers[0]!.candidate.spec)
    const fixedSpec = ResolvedJobDefinitionSpecSchema.parse(fixed.spec)
    await database.pool.query('update job_runtime_profiles set revision=2,record=$2::jsonb where id=$1',
      [profile.id, JSON.stringify({ ...profile, revision: 2, limits: { ...profile.limits, cpuLimit: 2 } })])
    expect(await queue.resources(database.pool, fixed)).toEqual(config.envelopes[0])
    await expect(queue.resources(database.pool, { ...fixed, workspaceId: randomUUID() }))
      .rejects.toMatchObject({ code: 'JOB_QUEUE_PROFILE_CONFLICT' })
    await expect(queue.resources(database.pool, { ...fixed, spec: { ...fixedSpec,
      policy: { ...fixedSpec.policy, isolationPolicyRevision: 99 } } }))
      .rejects.toMatchObject({ code: 'JOB_RUNTIME_PROFILE_VERSION_NOT_FOUND' })
    await expect(queue.resources(database.pool, { ...fixed, spec: { ...fixedSpec,
      policy: { ...fixedSpec.policy, imageDigest: `sha256:${'3'.repeat(64)}` } } }))
      .rejects.toMatchObject({ code: 'JOB_QUEUE_PROFILE_CONFLICT' })
    await expect(queue.resources(database.pool, { ...auto, spec: { ...f.computers[0]!.auto,
      limits: { ...profile.limits, cpuLimit: 2 } } }))
      .rejects.toMatchObject({ code: 'JOB_QUEUE_ENVELOPE_REVIEW_REQUIRED' })
    const policy = { ...config, envelopes: [config.envelopes[0]!, config.envelopes[0]!] }
    expect(() => createReviewedBuildQueueConfiguration(policy, mainId)).toThrow()
  })
  it('starts production recovery, wakes after settings changes and closes the queue before dispatch and output resources', async () => {
    const f = await fixture()
    const config = await configuration(f)
    const directory = join(database.directory, randomUUID())
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, 'job-queue.json'), JSON.stringify(config), { mode: 0o600 })
    const startup = vi.spyOn(JobService.prototype, 'startQueueRecovery')
    const runtime = await createProductionJobs({ pool: database.pool, commands: f.commands,
      locations: new WorkspaceLocationService(database.pool, f.commands), mainId: config.mainId,
      runtimeRoot: directory, storageRoot: join(directory, 'storage'),
      endpoint: () => { throw new Error('Empty queue and Main settings must not contact a Worker') } })
    const closed: string[] = []
    const closeQueue = runtime.jobs.closeQueue.bind(runtime.jobs)
    const closeDispatch = runtime.dispatch.close.bind(runtime.dispatch)
    const closeOutputs = runtime.outputs.close.bind(runtime.outputs)
    vi.spyOn(runtime.jobs, 'closeQueue').mockImplementation(async () => { await closeQueue(); closed.push('queue') })
    vi.spyOn(runtime.dispatch, 'close').mockImplementation(async () => { await closeDispatch(); closed.push('dispatch') })
    vi.spyOn(runtime.outputs, 'close').mockImplementation(async () => { await closeOutputs(); closed.push('outputs') })
    try {
      expect(startup).toHaveBeenCalledOnce()
      await runtime.jobs.wakeQueue()
      const wake = vi.spyOn(runtime.jobs, 'requestQueueWake')
      await runtime.buildComputers.update(principal, 'http', { commandId: randomUUID(), expectedRevision: 0,
        target: { hostRef: { kind: 'main', mainId: config.mainId }, applicationInstallationId: config.mainId,
          keyRevision: null, authorizationRevision: null }, buildEnabled: true, buildPriority: 100 })
      expect(wake).toHaveBeenCalledOnce()
      await runtime.jobs.wakeQueue()
    } finally {
      await runtime.close()
      vi.restoreAllMocks()
    }
    expect(closed).toEqual(['queue', 'dispatch', 'outputs'])
  })
  it('retains readable definitions and admits no fresh request when owner queue review is absent', async () => {
    const f = await fixture()
    const definition = await f.save()
    const directory = join(database.directory, randomUUID())
    await mkdir(directory, { mode: 0o700 })
    const runtime = await createProductionJobs({ pool: database.pool, commands: f.commands,
      locations: new WorkspaceLocationService(database.pool, f.commands),
      mainId: f.computers[0]!.candidate.spec.target.mainId,
      runtimeRoot: directory, storageRoot: join(directory, 'storage'),
      endpoint: () => { throw new Error('Unconfigured admission must not contact a Worker') } })
    try {
      await expect(runtime.jobs.enqueue(principal, 'http', f.workspaceId, { commandId: randomUUID(),
        definitionId: definition.id, expectedRevision: definition.revision }))
        .rejects.toMatchObject({ code: 'JOB_QUEUE_UNAVAILABLE' })
      expect(await runtime.jobs.listQueue(principal, f.workspaceId)).toEqual([])
      expect(await runtime.jobs.getDefinitionVersion(principal, f.workspaceId, definition.id, definition.versionId))
        .toEqual(definition)
    } finally { await runtime.close() }
  })
  it('restores retained runtime eligibility in fresh production compositions and reinspects reconnects', async () => {
    const f = await fixture()
    const config = await configuration(f)
    const computer = f.computers[0]!
    let binding: DeviceSessionBinding = { mainId: config.mainId, deviceId: computer.registration.deviceId,
      workerInstallationId: computer.registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
    const retained = jobRuntimeMetadataFixture(computer.candidate.profile, binding.bootId)
    const profile = retained.profile
    const root = profile.root
    const destination = computer.candidate.spec.target.destination
    const rootPolicy = WorkspaceRootPolicySchema.parse({
      schemaVersion: 1,
      rootPolicyId: root.selection.rootPolicyId,
      rootPolicyRevision: root.selection.rootPolicyRevision,
      workspaceId: f.workspaceId,
      hostRef: root.selection.hostRef,
      applicationInstallationId: computer.registration.workerInstallationId,
      registration: root.registration,
      locationRevision: root.selection.locationRevision,
      ownerPrincipalId: principal.id,
      allowedBaseId: root.binding.rootId,
      configurationRevision: '1',
      relativePath: 'project',
      accessMode: 'read-write',
      canonicalProjectRoot: root.binding.canonicalPath,
      filesystem: root.binding.filesystem,
      directoryIdentityHash: destination.directoryIdentityHash,
      managedRuntimeRoot: destination.managedRuntimeRoot,
      runtimeFilesystem: root.binding.filesystem,
      attestationId: root.attestationId,
      attestationDigest: root.attestationDigest,
    })
    await database.pool.query(`insert into workspace_root_policies
      (root_policy_id,root_policy_revision,workspace_id,host_scope,location_revision,record)
      values($1,$2,$3,$4,$5,$6::jsonb)`, [rootPolicy.rootPolicyId, rootPolicy.rootPolicyRevision,
      f.workspaceId, `main:${config.mainId}:device:${computer.registration.deviceId}`,
      rootPolicy.locationRevision, JSON.stringify(rootPolicy)])
    await database.pool.query('update job_runtime_profiles set record=$2::jsonb where id=$1',
      [profile.id, JSON.stringify(profile)])
    const measurement = profile.measurement!
    const approval = { schemaVersion: 1, id: measurement.approvalId, qualificationId: measurement.qualificationId,
      workspaceId: f.workspaceId, profileId: profile.id, profileRevision: 1,
      fingerprint: retained.fingerprint, fingerprintDigest: measurement.fingerprintDigest,
      requestedByPrincipalId: principal.id, status: 'complete', approvedByPrincipalId: principal.id,
      approvedAt: measurement.checkedAt, expiresAt: measurement.expiresAt }
    await database.pool.query(`insert into job_runtime_qualification_approvals
      (id,qualification_id,profile_id,profile_revision,workspace_id,record,measurement,requested_by,approved_by)
      values($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,$7,$7)`, [approval.id, approval.qualificationId,
      profile.id, f.workspaceId, JSON.stringify(approval), JSON.stringify(measurement), principal.id])
    let changed = false
    const inspections: number[] = []
    const endpoint = {
      currentBinding: () => binding,
      clockReason: () => workerClockReason(1_000_000, 1_000_000),
      captureRequest: () => ({ binding: structuredClone(binding), request: async () => {
        inspections.push(binding.connectionGeneration)
        return { payload: { version: 1, operation: 'inspect', descriptor: retained.descriptor,
          fingerprint: { ...retained.fingerprint,
            configurationDigest: changed ? '6'.repeat(64) : retained.fingerprint.configurationDigest } } }
      } }),
    } as unknown as DeviceEndpoint
    const directory = join(database.directory, randomUUID())
    await mkdir(directory, { mode: 0o700 })
    const create = () => createProductionJobs({ pool: database.pool, commands: f.commands,
      locations: new WorkspaceLocationService(database.pool, f.commands), mainId: config.mainId,
      runtimeRoot: directory, storageRoot: join(directory, 'storage'), endpoint: () => endpoint,
      infrastructure: { installedConfiguration: null, queueConfiguration: config } })
    for (let restart = 0; restart < 2; restart++) {
      const runtime = await create()
      try {
        await vi.waitFor(async () => {
          expect(await runtime.profiles.readiness(database.pool, profile)).toEqual({ ready: true, reasons: [] })
        })
        expect(profile.measurement).toEqual(retained.profile.measurement)
        await expect(runtime.profiles.revalidate(database.pool, principal, profile.root, computer.candidate.spec))
          .resolves.toBeUndefined()
        if (restart === 1) {
          binding = { ...binding, connectionEpoch: randomUUID(), connectionGeneration: 2 }
          expect(await runtime.host.currentMetadata(database.pool, profile)).toBeNull()
          runtime.requestQueueWake()
          await vi.waitFor(async () => {
            expect(await runtime.profiles.readiness(database.pool, profile)).toEqual({ ready: true, reasons: [] })
          })
          changed = true
          binding = { ...binding, connectionEpoch: randomUUID(), connectionGeneration: 3 }
          runtime.requestQueueWake()
          await vi.waitFor(() => { expect(inspections).toContain(3) })
          expect(await runtime.profiles.readiness(database.pool, profile))
            .toEqual({ ready: false, reasons: ['context_changed'] })
          await database.pool.query(`update workspace_root_policies set revoked_at=now()
            where root_policy_id=$1 and root_policy_revision=$2`,
          [rootPolicy.rootPolicyId, rootPolicy.rootPolicyRevision])
          expect(await runtime.profiles.readiness(database.pool, profile))
            .toEqual({ ready: false, reasons: ['root_context_changed'] })
        }
      } finally { await runtime.close() }
    }
    expect(inspections.filter(generation => generation === 1)).toHaveLength(2)
    expect((await database.pool.query<{ record: unknown }>('select record from job_runtime_profiles where id=$1',
      [profile.id])).rows[0]!.record).toEqual(profile)
  })
})
