import { describe, expect, it, vi } from 'vitest'
import { CI_HOST_NAMESPACE } from '@foreman-code/contracts'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { JobRuntimeProfiles } from '../jobs/runtimeProfiles.js'
import type { JobSql } from '../jobs/repository.js'
import { jobComputerCapacity, jobComputerCapacityDecision } from '../jobs/computerSelection.js'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { BuildComputerSettings, buildComputerTarget } from './buildComputers.js'
import { buildComputerReadiness } from './buildComputerReadiness.js'
import { WorkerExecutionPolicy } from './workerExecution.js'
import { workerBundleReadinessFixture } from '../../../test/helpers/workerBundleReadinessFixture.js'

function fixture(host: 'main' | 'device', memory: number | null = 14 * 2 ** 30, computing = 0) {
  const profile = verificationCapacityFixture(host)
  const target = buildComputerTarget({ hostRef: profile.root.selection.hostRef,
    registration: profile.root.registration, mainInstallationId: profile.root.binding.mainId })
  const endpoint = { currentBinding: () => ({ workerInstallationId: target.applicationInstallationId,
    keyRevision: target.keyRevision, authorizationRevision: target.authorizationRevision }),
  captureRequest: () => ({}), clockReason: () => null, capabilities: () => [],
  workerBundleReadiness: async () => workerBundleReadinessFixture().read() } as unknown as DeviceEndpoint
  const sql = { query: async (text: string) => ({ rows: text.includes('select record from job_runtime_profiles')
    ? [{ record: profile }] : Array.from({ length: computing }, () => ({
      limits: profile.spec.resources.limits, compute_closed: false,
    })) }) } as unknown as JobSql
  const input = { endpoint: () => endpoint, localExecutor: true, workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
    profiles: { readiness: async () => ({ ready: true, reasons: [] }) } as unknown as JobRuntimeProfiles,
    availableMemory: async () => memory }
  return { input, sql, profile, target }
}

describe('build computer readiness', () => {
  it.each([true, false])('uses Host CI readiness (%s) without requiring protected profiles', async ready => {
    const f = fixture('device')
    const endpoint = f.input.endpoint()
    endpoint.capabilities = () => [{ namespace: CI_HOST_NAMESPACE, version: 1,
      mainCanRequest: true, workerCanRequest: false, maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }]
    const request = vi.fn(async () => ({ payload: { operation: 'status', ready,
      reasons: ready ? [] : ['Connect GitHub on this computer.'], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] } }))
    endpoint.captureRequest = () => ({ binding: endpoint.currentBinding(f.target.hostRef.kind === 'device'
      ? f.target.hostRef.deviceId : '')!, request }) as ReturnType<DeviceEndpoint['captureRequest']>
    f.input.profiles.readiness = vi.fn()
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 100)).toEqual({
      state: ready ? 'ready' : 'setup-required', reasons: ready ? [] : ['Connect GitHub on this computer.'],
      remoteExecutionEnabled: true,
    })
    expect(request).toHaveBeenCalledWith({ operation: 'status', buildAllowancePercent: 100 }, { timeoutMs: 30_000 })
    expect(f.input.profiles.readiness).not.toHaveBeenCalled()
  })
  it('reports an untrusted Worker clock before considering runtime or capacity', async () => {
    const f = fixture('device')
    f.input.endpoint().clockReason = () => 'Worker clock differs from Main by more than 2 minutes.'
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 100)).toMatchObject({
      state: 'setup-required', reasons: ['Worker clock differs from Main by more than 2 minutes.'],
    })
  })
  it('derives settings readback from the persisted build allowance', async () => {
    const f = fixture('main')
    f.profile.measurement!.fingerprint.deviceLimits!.cpuLimit = 4
    const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
      expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: ['settings:read'], scope: {} }] }
    const query = async (text: string) => {
      if (text.includes('from management_principals')) return { rows: [{ ...principal,
        expires_at: new Date(principal.expiresAt), revoked_at: null }] }
      if (text.includes('from application_installation')) return { rows: [{ id: f.target.hostRef.mainId }] }
      if (text.includes('from build_computer_preferences')) return { rows: [{ target: f.target, revision: '1',
        build_enabled: true, build_priority: 50, build_allowance_percent: 10 }] }
      return f.sql.query(text)
    }
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
    const service = new BuildComputerSettings(pool, {} as PostgresCommandCoordinator, buildComputerReadiness(f.input))
    expect(await service.read(principal, { target: f.target })).toMatchObject({
      preference: { buildAllowancePercent: 10 }, state: 'setup-required',
      reasons: ['The build allowance is too small for this runtime. Increase the allowance.'],
    })
  })
  it('admits an idle qualified remote computer using its fresh available memory', async () => {
    const f = fixture('device')
    expect(await jobComputerCapacityDecision(f.sql, { mainId: f.target.hostRef.mainId,
      hostRef: f.target.hostRef }, f.profile, f.input.availableMemory)).toEqual({ fits: true })
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 100))
      .toEqual({ state: 'ready', reasons: [], remoteExecutionEnabled: true })
  })
  it.each([
    [null, 'setup-required', 'Available memory could not be read.'],
    [0, 'busy', 'More available memory is required before another build can start.'],
  ] as const)('reports the memory admission failure for %s bytes', async (memory, state, reason) => {
    const f = fixture('device', memory)
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 100))
      .toEqual({ state, reasons: [reason], remoteExecutionEnabled: true })
  })
  it('uses the saved allowance for occupied capacity just as scheduling does', async () => {
    const f = fixture('main', null, 1)
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 100)).toMatchObject({ state: 'ready' })
    const percent = Math.max(10, Math.ceil(100 * f.profile.spec.resources.limits.memoryBytes
      / jobComputerCapacity(f.profile).memoryBytes))
    expect(await jobComputerCapacityDecision(f.sql, { mainId: f.target.hostRef.mainId,
      hostRef: f.target.hostRef }, f.profile, f.input.availableMemory, percent)).toEqual({ fits: false, reason: 'busy' })
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, percent))
      .toMatchObject({ state: 'busy', reasons: ['Build capacity is reserved.'] })
  })
  it('reports an allowance too small for even one build as setup required', async () => {
    const f = fixture('main')
    f.profile.measurement!.fingerprint.deviceLimits!.cpuLimit = 4
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 10)).toMatchObject({
      state: 'setup-required', reasons: ['The build allowance is too small for this runtime. Increase the allowance.'],
    })
  })
})

it.each([
  [10, 0, 0, 1, 'setup-required', 'allowance is too small'],
  [100, 2, 2, 16, 'busy', 'capacity is reserved'],
  [100, 0, 0, 0, 'busy', 'available memory'],
] as const)('observes Host CI capacity with saved allowance %s', async (allowance, slotsTotal, slotsUsed, availableGiB, state, reason) => {
  const f = fixture('device')
  const endpoint = f.input.endpoint()
  endpoint.capabilities = () => [{ namespace: CI_HOST_NAMESPACE, version: 1,
    mainCanRequest: true, workerCanRequest: false, maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }]
  endpoint.captureRequest = () => ({ binding: endpoint.currentBinding('')!, request: async (payload: unknown) => {
    const percent = (payload as { buildAllowancePercent?: number }).buildAllowancePercent ?? 100
    return { payload: { operation: 'status', ready: true, reasons: [], cpuCount: Math.max(1, Math.floor(16 * percent / 100)),
      memoryBytes: Math.floor(16 * 2 ** 30 * percent / 100), availableMemoryBytes: availableGiB * 2 ** 30,
      buildAllowancePercent: percent, slotsTotal: percent === allowance ? slotsTotal : 2, slotsUsed, runs: [] } }
  } }) as ReturnType<DeviceEndpoint['captureRequest']>
  const result = await buildComputerReadiness(f.input)(f.sql, f.target, allowance)
  expect(result.state).toBe(state)
  expect(result.reasons.join(' ')).toContain(reason)
})
