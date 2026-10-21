import { errorMessage } from '../../shared/errorMessage.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { BuildComputerPrepareGetInputSchema, BuildComputerPrepareInputSchema, BuildComputerPrepareStatusSchema,
  CI_HOST_NAMESPACE, CI_RUNTIME_NAMESPACE, CiRuntimeWorkerStateSchema, WorkspaceSchema, type BuildComputerPrepareInput,
  type BuildComputerPrepareStatus, type CiRuntimeRequest, type CiRuntimeWorkerState } from '@foreman-code/contracts'
import type { JobQueueTicket } from '@foreman-code/contracts/job-admission'
import type { JobDefinitionSpecRecord } from '@foreman-code/contracts/job-verification'
import type { JobVerificationProfile } from '@foreman-code/contracts/job-verification-runtime'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { intersectGrants } from '../access/operatorDelegation.js'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { ComputerAccountsEndpoint } from '../computers/accounts.js'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import { assertBuildComputerTarget, buildComputerTarget, readBuildComputerPreference }
  from '../settings/buildComputers.js'
import type { PostgresSourceService } from '../sources/service.js'
import { beforeGraphCommit } from '../run-graph/connection.js'
import { CI_PREPARATION_ACTIONS } from './ciAuthority.js'
import { CiPreparationRecordSchema, PostgresCiPreparationRepository,
  type CiPreparationRecord, type CiPreparationRepository } from './ciPreparationRepository.js'
import { runCiPreparation } from './ciPreparationSteps.js'
import type { CiRuntimeWorker } from './ciRuntimeWorker.js'
import { temporaryCiConnectionError } from './ciRuntimeErrors.js'
import { JobOwnership } from './ownership.js'
import type { JobRuntimeProfiles } from './runtimeProfiles.js'
import type { JobSql } from './repository.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { jobDigest } from './digest.js'
import { matchesRuntimePolicy } from './runtimeSelection.js'

export const BUILD_COMPUTER_PREPARE_ACTIONS = CI_PREPARATION_ACTIONS
const PREPARE_LIMIT_MS = 3 * 60 * 60_000
const stopped = () => new DomainError('CI_PREPARATION_STOPPED', 'Runtime preparation will resume on Main.', 503)
type Profiles = Pick<JobRuntimeProfiles, 'list' | 'save' | 'requestQualification' | 'qualify'>
type Sources = Pick<PostgresSourceService, 'approveProject' | 'rootList' | 'bindRoot' | 'publish'>
interface PreparationPorts {
  repository?: CiPreparationRepository
  acquire?: typeof JobOwnership.acquire
  changed?(): void
  timing?: { pollMs: number; wait(ms: number): Promise<void>; now(): Date }
  /** Main's own CI runtime, when Main has an installed one; Main is then a build computer too. */
  main?(): Pick<CiRuntimeWorker, 'handle'> | undefined
}

/** Main persists each input before its command and resumes the same operation under one computer owner. */
export class CiRuntimeProvisioner {
  private readonly repository: CiPreparationRepository
  private readonly acquire: typeof JobOwnership.acquire
  private readonly work = new Map<string, Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly timing: NonNullable<PreparationPorts['timing']>
  constructor(
    private readonly pool: pg.Pool,
    private readonly profiles: Profiles,
    private readonly sources: Sources,
    private readonly endpoint: () => ComputerAccountsEndpoint | undefined,
    private readonly commands: PostgresCommandCoordinator,
    private readonly ports: PreparationPorts = {},
  ) {
    this.repository = ports.repository ?? new PostgresCiPreparationRepository(pool)
    this.acquire = ports.acquire ?? JobOwnership.acquire
    this.timing = ports.timing ?? { pollMs: 15_000,
      wait: ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.() }), now: () => new Date() }
  }

  async start(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: BuildComputerPrepareInput): Promise<BuildComputerPrepareStatus> {
    const parsed = BuildComputerPrepareInputSchema.parse(raw)
    const input = { ...parsed, commandId: parsed.commandId ?? randomUUID() }
    try {
      this.requireActions(principal, input.workspaceId)
    } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'build_computer_prepare', `workspace:${input.workspaceId}`)
      throw error
    }
    let preparedTarget!: { profile: JobVerificationProfile; deviceId: string }
    const result = await this.commands.execute({ principal, source, operation: 'build_computer_prepare',
      commandId: input.commandId, targetKey: input.workspaceId, payload: input,
      authorize: async sql => { await this.livePrincipal(principal, input.workspaceId, sql) },
      prepare: async () => {
        preparedTarget = await this.target(principal, input.workspaceId, input.profileId)
      },
      perform: async sql => {
        const { profile, deviceId } = preparedTarget
        await this.requireEnabled(profile, sql)
        const previous = await this.repository.latest(input.workspaceId, deviceId)
        const sameCommit = !input.commit || input.commit === previous?.status.commit
        const failureCount = previous?.status.state === 'failed' && sameCommit
          ? previous.status.failureCount ?? 1 : 0
        const now = this.timing.now().toISOString()
        const record = CiPreparationRecordSchema.parse({ id: randomUUID(), input, principal, source, profile,
          status: { profileId: profile.id, deviceId, state: 'approving', commit: input.commit ?? null,
            stage: null, message: null, profiles: [], startedAt: now, updatedAt: now, failureCount } })
        await this.repository.create(sql, record)
        return { operationId: record.id }
      },
    })
    const record = await this.repository.get(result.value.operationId)
    this.launch(record)
    return record.status
  }

  async get(principal: ManagementPrincipal, raw: { workspaceId: string; profileId: string }): Promise<BuildComputerPrepareStatus> {
    const input = BuildComputerPrepareGetInputSchema.parse(raw)
    requireAuthorization(principal, 'job_definitions:read', { workspaceId: input.workspaceId })
    const live = (await currentOperatorAuthority(this.pool, principal.id)).principal
    requireAuthorization({ ...live, grants: intersectGrants(principal.grants, live.grants) },
      'job_definitions:read', { workspaceId: input.workspaceId })
    const { profile, deviceId } = await this.target(principal, input.workspaceId, input.profileId)
    return (await this.repository.latest(input.workspaceId, deviceId))?.status
      ?? BuildComputerPrepareStatusSchema.parse({ profileId: profile.id, deviceId, state: 'idle', commit: null,
        stage: null, message: null, profiles: [], startedAt: null, updatedAt: null })
  }

  async prepareForTicket(ticket: JobQueueTicket): Promise<void> {
    const spec = ticket.definition.spec
    if (!ticket.runtimePreparation || !['waiting', 'blocked'].includes(ticket.state)
      || !ticket.waitingReasons.includes('dependencies_changed') || !('verification' in spec)) return
    const principal = await this.livePrincipal(ticket.runtimePreparation, ticket.workspaceId)
    await this.prepareForCommit(principal, ticket.workspaceId, spec.verification.suite, spec.source.commit, spec)
  }

  async prepareForCommit(principal: ManagementPrincipal, workspaceId: string, suite: string, commit: string,
    request?: JobDefinitionSpecRecord): Promise<void> {
    const devices = new Map<string, JobVerificationProfile>()
    for (const { profile } of (await this.profiles.list(principal, workspaceId)).profiles) {
      if (profile.schemaVersion !== 2 || profile.status === 'revoked' || !profile.spec.suites.includes(suite as never)) continue
      if (this.usesHostCi(profile)) continue
      if (request && (!matchesRuntimePolicy(request, profile) || !('verification' in request)
        || canonicalJson(request.verification.resources) !== canonicalJson(profile.spec.resources))) continue
      const computer = this.computerId(profile)
      if (!computer || devices.has(computer)) continue
      const preference = await readBuildComputerPreference(this.pool, this.profileTarget(profile))
      if (preference.buildEnabled) devices.set(computer, profile)
    }
    for (const [deviceId, profile] of devices) {
      const latest = await this.repository.latestForDevice(deviceId)
      if (latest?.input.workspaceId === workspaceId && latest.status.commit === commit) {
        if (latest.status.state === 'qualified' || latest.status.state === 'failed') continue
        this.launch(latest)
        continue
      }
      try {
        await this.start(principal, 'mcp', { workspaceId, profileId: profile.id, commit,
          commandId: `auto-${jobDigest({ workspaceId, commit, deviceId, previousOperationId: latest?.id ?? null })}` })
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'CI_RUNTIME_BUSY') throw error
        // The blocked ticket remains scheduled and retries after the computer's current operation finishes.
      }
    }
  }

  async recover(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    for (const record of await this.repository.pending()) this.launch(record)
  }

  async close(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.work.values())
  }

  private launch(record: CiPreparationRecord): void {
    if (this.lifetime.signal.aborted || this.work.has(record.id) || ['qualified', 'failed'].includes(record.status.state)) return
    const task = this.run(record.id).finally(() => { this.work.delete(record.id) })
    this.work.set(record.id, task)
    void task.catch(error => componentLogger('jobs').error({ err: error, operationId: record.id }, 'CI preparation recovery failed'))
  }

  private async run(id: string): Promise<void> {
    const record = await this.repository.get(id)
    const lost = new AbortController()
    const owner = await this.acquire(this.pool, `ci-runtime:${record.status.deviceId}`, () => lost.abort())
    if (!owner) return
    const signal = AbortSignal.any([this.lifetime.signal, lost.signal])
    const assertActive = () => { owner.assertOwned(); if (signal.aborted) throw stopped() }
    const checkpoint = async () => {
      assertActive()
      record.status.updatedAt = this.timing.now().toISOString()
      await owner.connection.transaction(async sql => {
        beforeGraphCommit(sql, async () => { assertActive() })
        await this.repository.save(sql, record)
      })
    }
    const principal = async () => {
      assertActive()
      await this.requireEnabled(record.profile)
      return this.livePrincipal(record.principal, record.input.workspaceId)
    }
    try {
      // Another owner may have committed completion while this operation was being read.
      Object.assign(record, await this.repository.get(id))
      if (['qualified', 'failed'].includes(record.status.state)) return
      await principal()
      await runCiPreparation(record, { profiles: this.profiles, sources: this.sources, principal, signal, checkpoint,
        repository: workspaceId => this.projectRepository(workspaceId), now: this.timing.now,
        publish: (repository, commit) => this.sources.publish(repository, commit, signal),
        wait: () => this.wait(signal), device: request => this.device(record, request, principal, signal),
        deviceImages: () => this.deviceImages(record.profile.root.selection.hostRef) })
    } catch (error) {
      if (signal.aborted || error instanceof DomainError && error.code === 'JOB_OWNERSHIP_LOST') return
      const failureCount = (record.status.failureCount ?? 0) + 1
      const retryDelay = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(failureCount, 6))
      record.status = { ...record.status, state: 'failed',
        failureCount, retryAt: new Date(this.timing.now().getTime() + retryDelay).toISOString(),
        message: (errorMessage(error, 'Runtime preparation failed.')).slice(0, 2000) }
      await checkpoint()
    } finally {
      await owner.release()
      this.ports.changed?.()
    }
  }

  private async wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(stopped())
      signal.addEventListener('abort', abort, { once: true })
      this.timing.wait(this.timing.pollMs).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
    signal.throwIfAborted()
  }

  private async device(record: CiPreparationRecord, request: CiRuntimeRequest,
    principal: () => Promise<ManagementPrincipal>, signal: AbortSignal): Promise<CiRuntimeWorkerState> {
    for (;;) {
      await principal()
      const deadline = record.status.state !== 'refreshing'
        ? Date.parse(record.status.startedAt!) + PREPARE_LIMIT_MS
        : Date.parse(record.refreshStartedAt!) + 15 * 60_000
      if (this.timing.now().getTime() > deadline) throw new DomainError('CI_RUNTIME_TIMEOUT', 'The runtime preparation timed out.', 504)
      try {
        if (record.profile.root.selection.hostRef.kind === 'main') {
          const main = this.ports.main?.()
          if (!main) throw new DomainError('BUILD_COMPUTER_PREPARE_UNSUPPORTED', 'Main has no installed CI runtime to prepare.', 409)
          return await main.handle(request)
        }
        const endpoint = this.endpoint()
        if (!endpoint?.capabilities(record.status.deviceId!).some(value => value.namespace === CI_RUNTIME_NAMESPACE && value.mainCanRequest)) {
          throw new DomainError('COMPUTER_OFFLINE', 'The build computer is offline; preparation will reconcile when it reconnects.', 409)
        }
        return CiRuntimeWorkerStateSchema.parse((await endpoint.request(record.status.deviceId!, CI_RUNTIME_NAMESPACE, request,
          { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })).payload)
      } catch (error) {
        if (!temporaryCiConnectionError(error) || request.operation === 'refresh') throw error
        componentLogger('jobs').info({ operationId: record.id }, 'Waiting for the build computer to reconnect')
        await this.wait(signal)
      }
    }
  }

  private requireActions(principal: ManagementPrincipal, workspaceId: string): void {
    for (const action of BUILD_COMPUTER_PREPARE_ACTIONS) requireAuthorization(principal, action, { workspaceId })
  }

  private async livePrincipal(ceiling: ManagementPrincipal, workspaceId: string, sql: JobSql = this.pool): Promise<ManagementPrincipal> {
    const live = (await currentOperatorAuthority(sql, ceiling.id)).principal
    const principal = { ...live, grants: intersectGrants(ceiling.grants, live.grants),
      expiresAt: new Date(Math.min(Date.parse(ceiling.expiresAt), Date.parse(live.expiresAt))).toISOString() }
    this.requireActions(principal, workspaceId)
    return principal
  }

  private profileTarget(profile: JobVerificationProfile) {
    return buildComputerTarget({ hostRef: profile.root.selection.hostRef, registration: profile.root.registration,
      mainInstallationId: profile.root.binding.mainId })
  }

  private usesHostCi(profile: JobVerificationProfile): boolean {
    const hostRef = profile.root.selection.hostRef
    return hostRef.kind === 'device' && !!this.endpoint()?.capabilities(hostRef.deviceId)
      .some(value => value.namespace === CI_HOST_NAMESPACE && value.mainCanRequest)
  }

  private async requireEnabled(profile: JobVerificationProfile, sql: JobSql = this.pool): Promise<void> {
    const target = this.profileTarget(profile)
    await assertBuildComputerTarget(sql, target)
    if (!(await readBuildComputerPreference(sql, target)).buildEnabled) {
      throw new DomainError('BUILD_COMPUTER_DISABLED', 'Enable builds on this computer before preparing its runtime.', 409)
    }
    if (this.usesHostCi(profile)) {
      throw new DomainError('CI_RUNTIME_RETIRED',
        'This computer uses Host CI. Start a Host CI run with ci_run; legacy runtime preparation is unavailable.', 409)
    }
  }

  private async target(principal: ManagementPrincipal, workspaceId: string, profileId: string) {
    const profile = (await this.profiles.list(principal, workspaceId)).profiles.find(value => value.profile.id === profileId)?.profile
    if (!profile) throw new DomainError('JOB_RUNTIME_PROFILE_NOT_FOUND', 'The verification profile was not found.', 404)
    if (profile.workspaceId !== workspaceId) {
      throw new DomainError('JOB_RUNTIME_PROFILE_SCOPE_CONFLICT', 'The verification profile belongs to another workspace.', 403)
    }
    const deviceId = profile.schemaVersion === 2 ? this.computerId(profile) : null
    if (profile.schemaVersion !== 2 || !deviceId || !profile.approvalConfig.review) {
      throw new DomainError('BUILD_COMPUTER_PREPARE_UNSUPPORTED', 'Only reviewed verification profiles on Main or paired computers are prepared automatically.', 409)
    }
    return { profile, deviceId }
  }

  /** The computer that prepares this profile's runtime: a paired Worker, or Main under its installation id (the
   * canonical alias Main uses for itself as a computer). */
  private computerId(profile: JobVerificationProfile): string | null {
    const hostRef = profile.root.selection.hostRef
    if (hostRef.kind === 'device') return hostRef.deviceId
    return this.ports.main?.() ? hostRef.mainId : null
  }

  /** Images the computer's current verification profiles still use, in every workspace. Its Worker retires
   * other retained runtime configurations and their images; accepted Jobs keep theirs through its journal. */
  private async deviceImages(hostRef: JobVerificationProfile['root']['selection']['hostRef']): Promise<string[]> {
    const rows = (await this.pool.query<{ image: string | null }>(`select record->'spec'->'policy'->>'imageDigest' as image
      from job_runtime_profiles where record->'root'->'selection'->'hostRef'=$1::jsonb
      and record->>'status' <> 'revoked'`, [JSON.stringify(hostRef)])).rows
    return [...new Set(rows.flatMap(row => row.image ? [row.image] : []))]
  }

  private async projectRepository(workspaceId: string): Promise<string> {
    const row = (await this.pool.query<{ record: unknown }>('select record from workspaces where id=$1', [workspaceId])).rows[0]
    const repository = row && WorkspaceSchema.parse(row.record).repository
    if (!repository) throw new DomainError('SOURCE_REPOSITORY_REQUIRED', 'Set the workspace GitHub repository so build computers can fetch the commit.', 409)
    return `${repository.owner}/${repository.name}`
  }
}
