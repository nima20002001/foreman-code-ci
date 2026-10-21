import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type pg from 'pg'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceRequestPriority } from '@foreman-code/contracts/device-application'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { assertDeviceHostInstallation } from '../../devices/hostAuthorization.js'
import { deviceBackpressured } from '../../devices/deviceBusyError.js'
import { harnessConnectionGeneration } from '../hostConnectionGeneration.js'
import { HostHarnessProfileCheckRequestSchema, HostHarnessInstanceCheckInputSchema, HostHarnessProfileEvidenceSchema, type HostHarnessInstanceCheckInput, type HostHarnessOverride, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../../access/policy.js'
import type { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { DomainError } from '../../errors.js'
import { assertClaudeFullAccess } from '../nativeWorkflowConfiguration.js'
import type { HostHarnessOverrideAuthority } from './authority.js'
import { harnessHostKey, type HarnessInstanceSettingsRepository } from './repository.js'
import type { NativeQualificationRetention } from '../installedNativeQualificationRetention.js'
import type { HostHarnessProfileEvidenceRepository } from './profileRepository.js'
import type { HarnessInstallationRecord } from '../installationRegistry.js'
import { qualificationError, staleQualification } from '../qualificationErrors.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from '../claudeSdk/profileRevision.js'
import { logIgnoredError } from '../../diagnostics/ignoredError.js'

export interface AutomaticHostProfileCheck {
  host: CanonicalMachineReference
  driverId: string
  applicationInstallationId: string
  generation: string
  signal: AbortSignal
  authorize(client: pg.PoolClient): Promise<void>
  installation(value: HostHarnessOverride): HarnessInstallationRecord | undefined
  beforeChecks?: () => Promise<void>
  /** Refreshes this host's inventory; a changed generation supersedes the running batch. */
  refresh?: (signal: AbortSignal) => Promise<void>
}

export interface HostHarnessProfileQualifier {
  /** Actual admitted factory/worker implementation; includes current driver suite and model/profile qualification. */
  qualify(value: HostHarnessOverride, input: {
    checkId: string; signal: AbortSignal; priority?: DeviceRequestPriority
  }): Promise<HostHarnessProfileEvidence>
}
const sameTarget = (a: HostHarnessOverride['target'], b: HostHarnessOverride['target']) => harnessHostKey(a.hostRef) === harnessHostKey(b.hostRef)
  && a.applicationInstallationId === b.applicationInstallationId && a.harnessInstallationId === b.harnessInstallationId && a.installationFingerprint === b.installationFingerprint
type ProfileCheckSelection = Pick<HostHarnessOverride, 'instanceId' | 'revision' | 'driverId' | 'target'>
interface AutomaticProfileCheckBatch {
  hostKey: string
  driverId?: string
  pendingProfiles?: Set<string>
}
const profileKey = (value: Pick<ProfileCheckSelection, 'instanceId' | 'revision'>) => `${value.instanceId}:${value.revision}`
const automaticChecksPerHost = 2

export function nativeProfileCheckId(mainId: string, principalId: string, commandId: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['harness.instance.check', mainId, principalId, commandId])).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

/** Reuses command receipts; native IO runs outside authority row locks and proof commit reauthorizes. */
export class HostHarnessInstanceProfileChecks {
  private readonly stopping = new AbortController()
  private readonly flights = new Set<Promise<unknown>>()
  private readonly hostChecks = new Map<string, Set<Promise<void>>>()
  private readonly profileFlights = new Map<string, Promise<void>>()
  private readonly reconnects = new Map<string, {
    generation: string; task: Promise<void>; batch: AutomaticProfileCheckBatch
  }>()
  private readonly updates = new Map<string, {
    generation: string; abort: AbortController; task: Promise<void>; batch: AutomaticProfileCheckBatch
  }>()
  constructor(private readonly settings: HarnessInstanceSettingsRepository, private readonly proofs: HostHarnessProfileEvidenceRepository,
    private readonly commands: PostgresCommandCoordinator, private readonly authority: HostHarnessOverrideAuthority,
    private readonly qualifier: HostHarnessProfileQualifier, private readonly nativeRetention?: NativeQualificationRetention) {}
  check(principal: ManagementPrincipal, source: 'http' | 'mcp', input: HostHarnessInstanceCheckInput) {
    if (this.stopping.signal.aborted) return Promise.reject(new DomainError('HARNESS_CHECK_SHUTTING_DOWN', 'Host profile checks are stopping.', 503))
    if (this.flights.size >= 16) return Promise.reject(new DomainError('HARNESS_PROFILE_CHECK_BUSY', 'Host profile checks are busy; retry the same command.', 429))
    const flight = this.perform(principal, source, input).then(async result => {
      if (result.value.proof.completedNativeQualification) {
        if (!this.nativeRetention) throw new DomainError('HARNESS_NATIVE_RETENTION_UNAVAILABLE',
          'Completed native qualification requires the Main transaction retention service.', 503)
        await this.nativeRetention.refresh(result.value.override, this.stopping.signal)
      }
      return result
    })
    this.flights.add(flight)
    void flight.finally(() => this.flights.delete(flight)).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return flight
  }
  recheckWorker(binding: Readonly<DeviceSessionBinding>, connectionSignal: AbortSignal,
    currentBinding: () => Readonly<DeviceSessionBinding> | null): Promise<void> {
    const host = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
    const key = harnessHostKey(host)
    const generation = harnessConnectionGeneration(binding)
    const previous = this.reconnects.get(key)
    if (previous?.generation === generation) return previous.task
    const signal = AbortSignal.any([this.stopping.signal, connectionSignal])
    const batch: AutomaticProfileCheckBatch = { hostKey: key }
    const task = this.recheckProfiles(host, binding, signal, currentBinding, batch)
    const entry = { generation, task, batch }
    this.reconnects.set(key, entry)
    this.flights.add(task)
    const cleanup = () => {
      this.flights.delete(task)
      if (this.reconnects.get(key) === entry) this.reconnects.delete(key)
    }
    void task.then(cleanup, cleanup)
    return task
  }
  assertReady(profile: ProfileCheckSelection): void {
    if (this.pending(profile)) {
      throw new DomainError('HARNESS_PROFILE_CHECK_PENDING',
        'The selected harness profile is being checked. Retry Run start shortly.',
        503, { reason: 'automatic_profile_check_pending', retryable: true })
    }
  }
  pending(profile: ProfileCheckSelection): boolean {
    if (this.profileFlights.has(profileKey(profile))) return true
    const hostKey = harnessHostKey(profile.target.hostRef)
    const batches = [...this.reconnects.values(), ...this.updates.values()]
    return batches.some(({ batch }) => batch.hostKey === hostKey
      && (!batch.driverId || batch.driverId === profile.driverId)
      && (!batch.pendingProfiles || batch.pendingProfiles.has(profileKey(profile))))
  }
  async failure(value: HostHarnessOverride, client?: pg.PoolClient) {
    return (await this.proofs.latest(value.instanceId, value.revision, client))?.failure
  }
  checkAutomatically(value: HostHarnessOverride, installation: HarnessInstallationRecord): Promise<void> {
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(240_000)])
    return this.shareProfileCheck(value, () => this.withHostCheckSlot(value.target.hostRef, signal,
      () => this.checkRequestedProfile(value, installation, signal)))
  }
  private shareProfileCheck(value: ProfileCheckSelection, check: () => Promise<void>): Promise<void> {
    const key = profileKey(value)
    const previous = this.profileFlights.get(key)
    if (previous) return previous
    const task = Promise.resolve().then(check)
    this.profileFlights.set(key, task)
    this.flights.add(task)
    const cleanup = () => {
      this.flights.delete(task)
      if (this.profileFlights.get(key) === task) this.profileFlights.delete(key)
    }
    void task.then(cleanup, cleanup)
    return task
  }
  private async checkRequestedProfile(value: HostHarnessOverride, installation: HarnessInstallationRecord,
    signal: AbortSignal): Promise<void> {
    const checkId = randomUUID()
    const input = { commandId: checkId, instanceId: value.instanceId,
      expectedRevision: value.revision, target: value.target }
    const authorize = async (client: pg.PoolClient) => {
      signal.throwIfAborted()
      await assertDeviceHostInstallation(client, value.target.hostRef, value.target.applicationInstallationId)
    }
    let result: { override: HostHarnessOverride; proof: HostHarnessProfileEvidence }
    try {
      result = await this.qualifyAutomatically(input, checkId, authorize, signal)
    } catch (error) {
      if (this.stopping.signal.aborted || staleQualification(error)) throw error
      const failure = qualificationError(error)
      await this.settings.readAuthorized(async client => {
        await assertDeviceHostInstallation(client, value.target.hostRef, value.target.applicationInstallationId)
        await this.settings.lockRevision(client, value.instanceId)
        const current = await this.settings.latest(client, value.instanceId)
        if (current?.revision !== value.revision || !sameTarget(current.target, value.target)) return
        const proof = HostHarnessProfileEvidenceSchema.parse({ target: value.target,
          instanceRevision: value.instanceRevision, configurationFingerprint: value.configurationFingerprint,
          driverId: value.driverId, driverRevision: installation.driverRevision,
          protocolRevision: installation.protocolRevision,
          suiteRevision: value.driverId === 'claude' ? CLAUDE_PROFILE_CHECK_REVISION : `${value.driverId}-profile-check-v1`,
          environmentGeneration: installation.environmentGeneration, connectionGeneration: installation.connectionGeneration,
          authenticated: null, compatible: null, qualified: false,
          failure: { code: failure.code, message: failure.message.slice(0, 500) }, checkedAt: new Date().toISOString() })
        const completed = await this.proofs.findCheck(checkId, value.instanceId, value.revision, client)
        await this.proofs.append(client, completed ? randomUUID() : checkId, value, proof)
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values(null,'system','harness.instance.check',$1,'failed',$2::jsonb)`,
        [`harness-instance:${value.instanceId}`, JSON.stringify({ checkId, code: failure.code })])
      })
      throw failure
    }
    // Discovery follows the committed native result; its failure must not replace that result.
    if (result.proof.completedNativeQualification) await this.nativeRetention!.refresh(result.override, signal)
  }
  recheckInstallation(input: AutomaticHostProfileCheck): Promise<void> {
    const hostKey = harnessHostKey(input.host)
    const key = `${hostKey}:${input.driverId}`
    const previous = this.updates.get(key)
    if (previous?.generation === input.generation) return previous.task
    const abort = new AbortController()
    previous?.abort.abort(new DomainError('HARNESS_INVENTORY_STALE', 'The harness installation changed again.', 409))
    const signal = AbortSignal.any([input.signal, abort.signal, this.stopping.signal])
    const batch: AutomaticProfileCheckBatch = { hostKey, driverId: input.driverId }
    const task = Promise.resolve().then(async () => {
      if (previous) await Promise.allSettled([previous.task])
      signal.throwIfAborted()
      await this.recheckInstalledProfiles({ ...input, signal }, batch)
    })
    const entry = { generation: input.generation, abort, task, batch }
    this.updates.set(key, entry)
    this.flights.add(task)
    const cleanup = () => {
      this.flights.delete(task)
      if (this.updates.get(key) === entry) this.updates.delete(key)
    }
    void task.then(cleanup, cleanup)
    return task
  }
  private async recheckInstalledProfiles(input: AutomaticHostProfileCheck, batch: AutomaticProfileCheckBatch): Promise<void> {
    const profiles = await this.settings.list(input.host, input.applicationInstallationId)
    const qualified: HostHarnessOverride[] = []
    for (const value of profiles) {
      input.signal.throwIfAborted()
      if (!value.enabled || value.driverId !== input.driverId
        || value.driverId === 'opencode' || value.configuration.harness === 'opencode') continue
      if (await this.proofs.previouslyQualified(value)) qualified.push(value)
    }
    batch.pendingProfiles = new Set(qualified.map(profileKey))
    if (!qualified.length) return
    const ordered = await this.settings.prioritizeForRuns(qualified)
    let preparationFailure: unknown
    try {
      if (qualified.some(value => value.driverId === 'codex') && input.beforeChecks) {
        await this.withHostCheckSlot(input.host, input.signal, input.beforeChecks)
      }
    } catch (error) { preparationFailure = error }
    const failures: unknown[] = []
    const checkProfile = async (saved: HostHarnessOverride, refreshed = false): Promise<void> => {
      input.signal.throwIfAborted()
      const installation = input.installation(saved)
      const checkId = randomUUID()
      let value = saved
      let result: { override: HostHarnessOverride; proof: HostHarnessProfileEvidence }
      const bounded = AbortSignal.any([input.signal, AbortSignal.timeout(240_000)])
      try {
        if (!installation?.installed || !installation.installationFingerprint) throw new DomainError(
          'HARNESS_INSTALLATION_UNAVAILABLE', 'The updated harness installation is unavailable.', 409)
        const target = { ...saved.target, harnessInstallationId: installation.harnessInstallationId,
          installationFingerprint: installation.installationFingerprint }
        if (!sameTarget(target, saved.target)) {
          batch.pendingProfiles!.add(profileKey({ ...saved, revision: saved.revision + 1 }))
          value = await this.settings.readAuthorized(async client => {
            await input.authorize(client)
            input.signal.throwIfAborted()
            return this.settings.replaceInstallation(client, saved, target)
          })
        }
        if (preparationFailure && value.driverId === 'codex') throw preparationFailure
        const request = { commandId: checkId, instanceId: value.instanceId,
          expectedRevision: value.revision, target: value.target }
        result = await this.qualifyAutomatically(request, checkId, input.authorize, bounded)
      } catch (error) {
        input.signal.throwIfAborted()
        if (staleQualification(error)) {
          if (!refreshed && input.refresh) {
            // Recheck on the settled inventory in this slot so the profile keeps its priority;
            // a changed inventory generation aborts this batch for a new prioritized one.
            try {
              await input.refresh(input.signal)
            } catch (refreshFailure) {
              input.signal.throwIfAborted()
              logIgnoredError('harness', 'refresh inventory after a stale profile check', refreshFailure,
                { instanceId: value.instanceId })
              failures.push(error)
              return
            }
            return checkProfile(value, true)
          }
          // The Worker no longer matches the requested target; the monitor retries once its inventory settles.
          failures.push(error)
          return
        }
        const failure = qualificationError(error)
        await this.settings.readAuthorized(async client => {
          await input.authorize(client)
          await this.settings.lockRevision(client, value.instanceId)
          const current = await this.settings.latest(client, value.instanceId)
          if (current?.revision !== value.revision) return
          if (installation && sameTarget(value.target, { ...value.target,
            harnessInstallationId: installation.harnessInstallationId,
            installationFingerprint: installation.installationFingerprint ?? value.target.installationFingerprint })) {
            const proof = HostHarnessProfileEvidenceSchema.parse({ target: value.target,
              instanceRevision: value.instanceRevision, configurationFingerprint: value.configurationFingerprint,
              driverId: value.driverId, driverRevision: installation.driverRevision,
              protocolRevision: installation.protocolRevision,
              suiteRevision: value.driverId === 'claude' ? CLAUDE_PROFILE_CHECK_REVISION : `${value.driverId}-profile-check-v1`,
              environmentGeneration: installation.environmentGeneration, connectionGeneration: installation.connectionGeneration,
              authenticated: null, compatible: null, qualified: false,
              failure: { code: failure.code, message: failure.message.slice(0, 500) }, checkedAt: new Date().toISOString() })
            const completed = await this.proofs.findCheck(checkId, value.instanceId, value.revision, client)
            await this.proofs.append(client, completed ? randomUUID() : checkId, value, proof)
          } else {
            const previous = await this.proofs.latest(value.instanceId, value.revision, client)
            if (previous) await this.proofs.append(client, checkId, value, { ...previous,
              qualified: false, authenticated: null, compatible: null,
              failure: { code: failure.code, message: failure.message.slice(0, 500) }, checkedAt: new Date().toISOString() })
          }
          await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values(null,'system','harness.instance.check',$1,'failed',$2::jsonb)`,
          [`harness-instance:${value.instanceId}`, JSON.stringify({ checkId, code: failure.code })])
        })
        failures.push(error)
        return
      }
      try {
        if (result.proof.completedNativeQualification) await this.nativeRetention!.refresh(result.override, bounded)
      } catch (error) {
        input.signal.throwIfAborted()
        failures.push(error)
      }
      batch.pendingProfiles!.delete(profileKey(value))
    }
    await this.recheckInParallel(ordered, input.signal, saved => checkProfile(saved), batch)
    if (failures.length) throw new AggregateError(failures, 'Automatic harness profile checks failed.')
  }
  private async recheckProfiles(host: CanonicalMachineReference, binding: Readonly<DeviceSessionBinding>,
    signal: AbortSignal, currentBinding: () => Readonly<DeviceSessionBinding> | null,
    batch: AutomaticProfileCheckBatch): Promise<void> {
    const profiles = await this.settings.list(host, binding.workerInstallationId)
    const qualified: HostHarnessOverride[] = []
    for (const value of profiles) {
      signal.throwIfAborted()
      if (!value.enabled || value.driverId === 'opencode' || value.configuration.harness === 'opencode') continue
      const previous = await this.proofs.latest(value.instanceId, value.revision)
      if (!previous?.qualified || previous.authenticated !== true || previous.compatible !== true) continue
      const generation = harnessConnectionGeneration(binding)
      if (previous.connectionGeneration === generation) continue
      qualified.push(value)
    }
    batch.pendingProfiles = new Set(qualified.map(profileKey))
    if (!qualified.length) return
    const ordered = await this.settings.prioritizeForRuns(qualified)
    const failures: unknown[] = []
    await this.recheckInParallel(ordered, signal, async value => {
      const generation = harnessConnectionGeneration(binding)
      const checkId = nativeProfileCheckId(binding.mainId, 'system',
        `${generation}:${value.instanceId}:${value.revision}`)
      const input = { commandId: checkId, instanceId: value.instanceId,
        expectedRevision: value.revision, target: value.target }
      const authorize = async (client: pg.PoolClient) => {
        signal.throwIfAborted()
        const registration = await assertDeviceHostInstallation(client, host, binding.workerInstallationId)
        const current = currentBinding()
        if (!registration || registration.keyRevision !== binding.keyRevision
          || registration.authorizationRevision !== binding.authorizationRevision
          || !current || harnessConnectionGeneration(current) !== generation) {
          throw new DomainError('HARNESS_INVENTORY_STALE', 'The Worker connection changed during its profile check.', 409)
        }
      }
      try {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(240_000)])
        const result = await this.qualifyAutomatically(input, checkId, authorize, bounded)
        if (result.proof.completedNativeQualification) await this.nativeRetention!.refresh(result.override, bounded)
        batch.pendingProfiles!.delete(profileKey(value))
      } catch (error) {
        await this.settings.readAuthorized(client => client.query(`insert into management_audit
          (principal_id,source,action,target_key,outcome,details)
          values(null,'system','harness.instance.check',$1,'failed',$2::jsonb)`,
        [`harness-instance:${value.instanceId}`, JSON.stringify({ checkId,
          code: error instanceof DomainError ? error.code : 'HARNESS_PROFILE_CHECK_FAILED' })]))
        failures.push(error)
      }
    }, batch)
    if (failures.length) throw new AggregateError(failures, 'Automatic Worker profile checks failed.')
  }
  private async recheckInParallel(profiles: HostHarnessOverride[], signal: AbortSignal,
    check: (value: HostHarnessOverride) => Promise<void>, batch: AutomaticProfileCheckBatch): Promise<void> {
    let next = 0
    const worker = async () => {
      while (next < profiles.length) {
        signal.throwIfAborted()
        const value = profiles[next++]!
        await this.shareProfileCheck(value, () =>
          this.withHostCheckSlot(value.target.hostRef, signal, () => check(value)))
        batch.pendingProfiles?.delete(profileKey(value))
      }
    }
    const workers = Array.from({ length: Math.min(automaticChecksPerHost, profiles.length) }, worker)
    const results = await Promise.allSettled(workers)
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Automatic harness profile checks interrupted.')
  }
  private async withHostCheckSlot(host: CanonicalMachineReference, signal: AbortSignal,
    check: () => Promise<void>): Promise<void> {
    const key = harnessHostKey(host)
    const active = this.hostChecks.get(key) ?? new Set<Promise<void>>()
    this.hostChecks.set(key, active)
    while (active.size >= automaticChecksPerHost) {
      await Promise.race(active)
      signal.throwIfAborted()
    }
    signal.throwIfAborted()
    let release!: () => void
    const slot = new Promise<void>(resolve => { release = resolve })
    active.add(slot)
    try {
      await check()
    } finally {
      active.delete(slot)
      release()
    }
  }
  async close(): Promise<void> {
    this.stopping.abort(new Error('Host profile checks are stopping.'))
    await Promise.allSettled([...this.flights])
  }
  private async perform(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HostHarnessInstanceCheckInput) {
    requireAuthorization(principal, 'harnesses:read'); requireAuthorization(principal, 'harnesses:update')
    const input = HostHarnessInstanceCheckInputSchema.parse(raw)
    const automatic = this.profileFlights.get(profileKey({
      instanceId: input.instanceId, revision: input.expectedRevision,
    }))
    const authorize = async (client: import('pg').PoolClient) => {
      await this.authority.authorize(principal, 'harnesses:read', input.target.hostRef, input.target.applicationInstallationId, client)
      await this.authority.authorize(principal, 'harnesses:update', input.target.hostRef, input.target.applicationInstallationId, client)
    }
    await this.settings.readAuthorized(async client => {
      await authorize(client)
      const saved = await this.settings.latest(client, input.instanceId)
      if (saved && sameTarget(saved.target, input.target)
        && (saved.driverId === 'opencode' || saved.configuration.harness === 'opencode')) {
        throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
      }
    })
    const reuseLatest = automatic ? await automatic.then(() => true, () => false) : false
    const checkId = nativeProfileCheckId(input.target.hostRef.mainId, principal.id, input.commandId)
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new DomainError('HARNESS_PROFILE_CHECK_TIMEOUT', 'Exact-host profile qualification exceeded its deadline.', 504)), 240_000)
    timer.unref()
    const signal = AbortSignal.any([this.stopping.signal, deadline.signal])
    try { return await this.commands.execute({ principal, source, operation: 'harness.instance.check', commandId: input.commandId,
      targetKey: `harness-instance:${input.instanceId}`, payload: input, dedicatedConnection: true, authorize,
      perform: client => this.qualifyProfile(client, input, checkId, authorize, signal,
        reuseLatest ? { reuseLatest: true } : {}),
    }) } finally { clearTimeout(timer) }
  }
  private async selectProfile(input: HostHarnessInstanceCheckInput,
    authorize: (client: pg.PoolClient) => Promise<void>, client: pg.PoolClient,
    options?: { lockRevision: true }) {
    await authorize(client)
    if (options?.lockRevision) await this.settings.lockRevision(client, input.instanceId)
    const value = await this.settings.latest(client, input.instanceId)
    if (!value || value.revision !== input.expectedRevision || !sameTarget(value.target, input.target)) {
      throw new DomainError('REVISION_CONFLICT', 'The exact host instance changed before qualification.', 409)
    }
    if (value.driverId === 'opencode' || value.configuration.harness === 'opencode') throw new DomainError(
      'HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    if (!value.enabled) throw new DomainError('HARNESS_INSTANCE_DISABLED', 'Disabled host instances cannot be qualified.', 409)
    assertClaudeFullAccess(value.configuration)
    return value
  }
  private async qualifyAutomatically(input: HostHarnessInstanceCheckInput, checkId: string,
    authorize: (client: pg.PoolClient) => Promise<void>, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted()
      try {
        return await this.settings.withProfileConnection(client =>
          this.qualifyProfile(client, input, checkId, authorize, signal, { source: 'system' }))
      } catch (error) {
        if (!deviceBackpressured(error)) throw error
        await delay(250, undefined, { signal })
      }
    }
  }
  private async qualifyProfile(client: pg.PoolClient, input: HostHarnessInstanceCheckInput, checkId: string,
    authorize: (client: pg.PoolClient) => Promise<void>, signal: AbortSignal,
    options: { source?: 'system'; reuseLatest?: true } = {}) {
    const profileLock = `harness-instance-profile:${input.instanceId}`
    await client.query('select pg_advisory_lock(hashtext($1))', [profileLock])
    try {
      signal.throwIfAborted()
      const value = await this.settings.readAuthorized(client => this.selectProfile(input, authorize, client))
      HostHarnessProfileCheckRequestSchema.parse({ checkId, override: value })
      const matches = (proof: HostHarnessProfileEvidence) => sameTarget(proof.target, value.target)
        && proof.instanceRevision === value.instanceRevision
        && proof.configurationFingerprint === value.configurationFingerprint && proof.driverId === value.driverId
      const previous = await this.proofs.findCheck(checkId, value.instanceId, value.revision)
        ?? (options.reuseLatest ? await this.proofs.latest(value.instanceId, value.revision) : null)
      if (previous) {
        if (!matches(previous)) throw new DomainError('COMMAND_ID_CONFLICT',
          'The completed check belongs to different profile input.', 409)
        return { override: value, proof: previous }
      }
      signal.throwIfAborted()
      const priority = options.source === 'system' ? 'background' : 'foreground'
      const proof = HostHarnessProfileEvidenceSchema.parse(await this.qualifier.qualify(value, { checkId, signal, priority }))
      signal.throwIfAborted()
      if (!matches(proof)) throw new DomainError('HARNESS_PROFILE_EVIDENCE_MISMATCH',
        'Native qualification did not match the exact selected host profile.', 409)
      await this.settings.readAuthorized(async client => {
        await this.selectProfile(input, authorize, client, { lockRevision: true })
        signal.throwIfAborted()
        if (proof.completedNativeQualification && !this.nativeRetention) throw new DomainError(
          'HARNESS_NATIVE_RETENTION_UNAVAILABLE', 'Completed native qualification requires the Main transaction retention service.', 503)
        const finalFence = proof.completedNativeQualification
          ? await this.nativeRetention!.retain(client, value, proof, checkId, signal) : undefined
        await this.proofs.append(client, checkId, value, proof)
        if (options.source === 'system') {
          await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values(null,'system','harness.instance.check',$1,'succeeded',$2::jsonb)`,
          [`harness-instance:${value.instanceId}`, JSON.stringify({ checkId, qualified: proof.qualified })])
        }
        await finalFence?.()
      })
      return { override: value, proof }
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [profileLock])
    }
  }

}
