import type pg from 'pg'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { CiStartPreflightError } from './dispatch.js'
import { CI_DIRECTORY_PAGE_SIZE, ciDirectoryCleanupCandidates, expireCiLogTails } from './directoryRetention.js'
import { CI_HOST_NAMESPACE, CI_HOST_START_PROTOCOL_VERSION, CiHostReplySchema,
  type CiHostReply, type CiHostRequest } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import type { CiMirrorInput } from './serviceTypes.js'
import type { HostCiRunner } from './runner.js'
import type { CloudCi } from './cloud.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { DomainError } from '../errors.js'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { assertBuildComputerTarget } from '../settings/buildComputers.js'
import { readComputerNames } from '../computers/names.js'
import { DeviceAccessError } from '../devices/access.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { DeviceRequestPriority } from '@foreman-code/contracts/device-application'
import type { WorkerBundleReadiness } from '@foreman-code/contracts/computer-maintenance'
import { workerBundleErrorMessage } from '../computers/workerBundleReadiness.js'
import { withCiDatabaseReservation, withoutCiDatabasePriority } from '../../infrastructure/ciDatabasePriority.js'

import { RetryBackoff } from '../../infrastructure/retryBackoff.js'

const log = componentLogger('jobs')

interface DeviceRequests {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest?: boolean }[]
  assertWorkerBundleReady?(deviceId: string): Promise<void>
  workerBundleReadiness?(deviceId: string): Promise<WorkerBundleReadiness>
  request(deviceId: string, namespace: string, payload: unknown,
    options?: { timeoutMs?: number; priority?: DeviceRequestPriority }): Promise<{ payload: unknown }>
}

/** Build-enabled paired computers that serve host CI now, Main itself through its local runner, and cloud CI services
 * on the workspace's public mirror. */
export class ProductionHostCiEndpoint implements HostCiEndpoint {
  private readonly cleanupAt = new Map<string, number>()
  private readonly cleanupPending = new Map<string, Promise<void>>()
  private readonly cleanupRetries = new Map<string, RetryBackoff>()
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly devices: () => DeviceRequests | undefined, private readonly local: Pick<HostCiRunner, 'handle'>,
    private readonly clouds: CloudCi[] = [], private readonly discoverClouds?: () => Promise<void>,
    private readonly workerExecution = new WorkerExecutionPolicy()) {}

  async publishMirror(input: CiMirrorInput): Promise<void> {
    // Publication is shared by provider and slot; readiness remains a dispatch concern. Further CircleCI orgs publish
    // their own mirror copy in the background so a slow copy never holds the other services idle; their start
    // publishes again if this has not finished.
    for (const cloud of this.clouds.filter(cloud => cloud.provider.account)) {
      void cloud.publishMirror(input).catch(error => {
        log.warn({ err: error, provider: cloud.provider.label, commit: input.commit }, 'CI mirror copy publication failed; its start will retry')
      })
    }
    await Promise.all(this.clouds.filter(cloud => !cloud.provider.account).map(cloud => cloud.publishMirror(input)))
  }

  async computers(): Promise<HostCiComputer[]> {
    // Recovery sweeps and org discovery make provider calls; planning and listing must not wait for them.
    if (this.discoverClouds) void withoutCiDatabasePriority(this.discoverClouds)
    for (const cloud of this.clouds) {
      void withoutCiDatabasePriority(() => cloud.reconcile()).catch(error => {
        log.warn({ operation: 'recover cloud CI tickets', err: error, provider: cloud.provider.id },
          'Cloud CI recovery sweep failed')
      })
    }
    return withCiDatabaseReservation(this.pool, () => this.readComputers())
  }

  private async readComputers(): Promise<HostCiComputer[]> {
    const rows = (await this.pool.query<{ host_key: string; target: DeviceProvisioningTarget
      build_enabled: boolean; build_priority: number; build_allowance_percent: number }>(
      'select host_key,target,build_enabled,build_priority,build_allowance_percent from build_computer_preferences')).rows
    const devices = this.devices()
    const names = await readComputerNames(this.pool, this.mainId)
    const computers: HostCiComputer[] = []
    for (const row of rows) {
      const hostRef = row.target.hostRef
      if (!row.build_enabled || hostRef.mainId !== this.mainId) continue
      try {
        this.workerExecution.requireEnabled(hostRef)
        await assertBuildComputerTarget(this.pool, row.target)
      } catch (error) {
        if (error instanceof DeviceAccessError
          || error instanceof DomainError
            && ['BUILD_COMPUTER_IDENTITY_CHANGED', 'WORKER_EXECUTION_DISABLED'].includes(error.code)) continue
        throw error
      }
      if (hostRef.kind === 'main') {
        computers.push({ key: row.host_key, hostRef, label: names.get(row.host_key) ?? 'Main computer', priority: row.build_priority,
          buildAllowancePercent: row.build_allowance_percent })
        continue
      }
      if (hostRef.kind !== 'device' || !hostRef.deviceId) continue
      if (!devices?.capabilities(hostRef.deviceId).some(value => value.namespace === CI_HOST_NAMESPACE && value.mainCanRequest)) continue
      computers.push({ key: row.host_key, hostRef, label: names.get(row.host_key) ?? `Computer ${hostRef.deviceId.slice(0, 8)}`, priority: row.build_priority,
        buildAllowancePercent: row.build_allowance_percent })
    }
    return [...computers, ...this.clouds.flatMap(cloud => cloud.computers())]
      .sort((left, right) => right.priority - left.priority)
  }

  async request(computer: HostCiComputer, request: CiHostRequest,
    options?: { priority: DeviceRequestPriority }): Promise<CiHostReply> {
    if (request.operation === 'start') {
      try {
        if (computer.hostRef.kind === 'device') this.workerExecution.requireEnabled({ kind: computer.hostRef.kind })
        request = await this.prepareStart(computer, request)
        if (computer.hostRef.kind === 'device') this.workerExecution.requireEnabled({ kind: computer.hostRef.kind })
      } catch (error) {
        throw new CiStartPreflightError(error)
      }
    }
    let reply = await this.sendRequest(computer, request, options)
    if (reply.operation === 'status' && computer.hostRef.kind === 'device') {
      const readiness = await this.devices()?.workerBundleReadiness?.(computer.hostRef.deviceId!)
      if (readiness && !readiness.ready) {
        reply = { ...reply, ready: false, reasons: [...reply.reasons, workerBundleErrorMessage(readiness)].slice(-10) }
      }
    }
    if (reply.operation === 'status' && reply.cleanupSupported) {
      void withoutCiDatabasePriority(() => this.cleanDirectories(computer))
    }
    return reply
  }

  private async prepareStart(computer: HostCiComputer,
    request: Extract<CiHostRequest, { operation: 'start' }>) {
    if (computer.hostRef.kind !== 'cloud') {
      const saved = (await this.computers()).find(value => value.key === computer.key
        && JSON.stringify(value.hostRef) === JSON.stringify(computer.hostRef))
      if (!saved) {
        throw new DomainError('BUILD_COMPUTER_DISABLED', 'This computer is no longer available for builds.', 409)
      }
      request = { ...request, buildAllowancePercent: saved.buildAllowancePercent ?? 100 }
    }
    if (computer.hostRef.kind === 'device') {
      await this.devices()?.assertWorkerBundleReady?.(computer.hostRef.deviceId!)
      const status = await this.sendRequest(computer,
        { operation: 'status', buildAllowancePercent: request.buildAllowancePercent }, { priority: 'foreground' })
      if (status.operation !== 'status') throw new DomainError('CI_HOST_REPLY_INVALID', 'Expected Worker CI status.', 502)
      if ((status.startProtocolVersion ?? 0) < CI_HOST_START_PROTOCOL_VERSION) {
        throw new DomainError('CI_HOST_PROTOCOL_UNSUPPORTED', status.reasons.join('; '), 409)
      }
      if (!status.ready) throw new DomainError('CI_HOST_BUSY', status.reasons.join('; '), 409)
    }
    return request
  }

  private async cleanDirectories(computer: HostCiComputer): Promise<void> {
    const hostRef = { ...computer.hostRef }
    delete hostRef.slot
    const key = canonicalJson(hostRef)
    const pending = this.cleanupPending.get(key)
    if (pending) return pending
    const now = Date.now()
    const retry = this.cleanupRetries.get(key) ?? new RetryBackoff({ initialMs: 5 * 60_000, maxMs: 30 * 60_000 })
    this.cleanupRetries.set(key, retry)
    if (!retry.ready(now)) return
    if (now - (this.cleanupAt.get(key) ?? -Infinity) < 5 * 60_000) return
    const cleanup = (async () => {
      for (let offset = 0; ; offset += CI_DIRECTORY_PAGE_SIZE) {
        const runIds = await ciDirectoryCleanupCandidates(this.pool,
          { hostRef: computer.hostRef, label: computer.label }, now, { offset })
        if (runIds.length) {
          const reply = await this.sendRequest(computer, { operation: 'status', cleanupRunIds: runIds })
          if (reply.operation !== 'status' || !reply.removedRunIds) throw new Error('Expected CI cleanup reply.')
          const selected = new Set(runIds)
          const removed = reply.removedRunIds.filter(id => selected.has(id))
          await expireCiLogTails(this.pool, { hostRef: computer.hostRef, label: computer.label }, removed, now)
        }
        if (runIds.length < CI_DIRECTORY_PAGE_SIZE) break
      }
      this.cleanupAt.set(key, Date.now())
      retry.reset()
    })().catch(error => {
      const nextRetryMs = retry.fail()
      log.warn({ operation: 'clean retained CI directories', err: error, hostRef: computer.hostRef, nextRetryMs },
        'CI directory cleanup failed; retry scheduled')
    })
    this.cleanupPending.set(key, cleanup)
    try { await cleanup }
    finally { this.cleanupPending.delete(key) }
  }

  private async sendRequest(computer: HostCiComputer, request: CiHostRequest,
    options?: { priority: DeviceRequestPriority }): Promise<CiHostReply> {
    if (request.operation === 'status' && computer.hostRef.kind !== 'cloud') {
      request = { ...request, buildAllowancePercent: request.buildAllowancePercent ?? computer.buildAllowancePercent ?? 100 }
    }
    if (computer.hostRef.kind === 'main') return this.local.handle(request)
    if (computer.hostRef.kind === 'cloud') {
      const cloud = this.clouds.find(value => value.provider.id === computer.hostRef.provider
        && value.provider.account?.owner.toLowerCase() === computer.hostRef.account?.toLowerCase()
        && (value.provider.circleAccountId ?? 'default') === (computer.hostRef.circleAccountId ?? 'default'))
      if (!cloud) throw new Error('This cloud CI service is off.')
      return cloud.handle(request)
    }
    const devices = this.devices()
    const deviceId = computer.hostRef.deviceId
    if (!devices || !deviceId) throw new Error('The build computer is offline.')
    const priority = options?.priority ?? (request.operation === 'status' ? 'background' : 'foreground')
    // Execution and cleanup need live replies; readiness caching belongs to CiPlanningSnapshot.
    let reply: { payload: unknown }
    try {
      reply = await devices.request(deviceId, CI_HOST_NAMESPACE, request, { timeoutMs: 120_000, priority })
    } catch (error) {
      if (error instanceof DeviceApplicationError && error.code === 'CI_RUN_UNKNOWN') {
        throw new DomainError('CI_RUN_UNKNOWN', 'The build computer has no such CI run.', 404,
          undefined, { cause: error })
      }
      throw error
    }
    const parsed = CiHostReplySchema.parse(reply.payload)
    if (request.operation === 'status' && parsed.operation !== 'status') {
      throw new DomainError('CI_HOST_REPLY_INVALID', 'Expected Worker CI status.', 502)
    }
    if (parsed.operation === 'status' && (parsed.startProtocolVersion ?? 0) < CI_HOST_START_PROTOCOL_VERSION) {
      return { ...parsed, ready: false, reasons: [...parsed.reasons,
        'Worker CI start protocol is unsupported; update the Worker.'].slice(-10) }
    }
    return parsed
  }
}
