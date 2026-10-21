import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { HostHarnessOverrideSchema, HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import { assertMcpReadback } from './helpers/workerProfileRequalification.js'

it.each([0, 1, 'main'] as const)(
  'reads persisted Worker checks after pending checks finish when the shared suite row belongs to %s', async retainedIndex => {
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 2,
    keyRevision: 1, authorizationRevision: 1 }
  const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
  const target = { hostRef, applicationInstallationId: binding.workerInstallationId,
    harnessInstallationId: 'fixture-installation', installationFingerprint: 'fixture-payload' }
  const profiles = [0, 1].map(() => HostHarnessOverrideSchema.parse({
    instanceId: randomUUID(), revision: 1, instanceRevision: '1', target,
    presetId: 'fixture', enabled: true, driverId: 'codex', configuration: DEFAULT_HARNESS_DEFAULTS.codex,
    configurationFingerprint: 'fixture-profile', qualification: 'qualified',
  }))
  const evidence = profiles.map((profile, index) => {
    const checkedAt = new Date(index + 1).toISOString()
    const record = { harness: 'codex', version: '0.154.0', binarySha256: 'a'.repeat(64),
      status: 'qualified', profile: 'codex-0.154', suiteRevision: 'fixture-suite',
      checks: [{ id: 'native-check', passed: true, detail: null }], failureReason: null,
      startedAt: new Date(0).toISOString(), checkedAt }
    return HostHarnessProfileEvidenceSchema.parse({ target, instanceRevision: profile.instanceRevision,
      configurationFingerprint: profile.configurationFingerprint, driverId: 'codex', driverRevision: '1',
      protocolRevision: 'fixture-protocol', suiteRevision: 'fixture-profile-suite',
      environmentGeneration: 'fixture-environment', connectionGeneration: 'fixture-generation',
      authenticated: true, compatible: true, qualified: true, checkedAt,
      completedNativeQualification: { purpose: 'explicit-host-qualification', checkId: randomUUID(),
        binding, target, binarySha256: record.binarySha256, record } })
  })
  const sharedRecord = retainedIndex === 'main'
    ? { ...evidence[0]!.completedNativeQualification!.record, checkedAt: new Date(3).toISOString() }
    : evidence[retainedIndex]!.completedNativeQualification!.record
  let finishChecks!: () => void
  const checking = new Promise<void>(resolve => { finishChecks = resolve })
  let beginRead!: () => void
  const reading = new Promise<void>(resolve => { beginRead = resolve })
  const value = vi.fn(async (name: string) => {
    if (name === 'harness_instances_list') {
      beginRead()
      await checking
      return { overrides: profiles }
    }
    if (name === 'harness_qualifications_list') return { qualifications: [sharedRecord] }
    throw new Error(`Unexpected MCP tool: ${name}`)
  })
  const inventory = vi.fn(async () => ({ installations: [
    { driverId: 'codex', connectionGeneration: 'fixture-generation', qualified: true, observedVersion: '0.154.0' },
  ] }))
  const query = vi.fn(async (_statement: string, parameters?: unknown[]) => {
    if (parameters) {
      if (retainedIndex === 'main') return { rows: [] }
      return { rows: [{ check_id: evidence[retainedIndex]!.completedNativeQualification!.checkId }] }
    }
    return { rows: evidence.map(record => ({ record })) }
  })
  const fixture = {
    hostRef, profiles, value, inventory, db: { pool: { query } },
  } as unknown as Parameters<typeof assertMcpReadback>[0]
  const readback = assertMcpReadback(fixture, evidence)
  try {
    await reading
    expect(value.mock.calls.map(([name]) => name)).toEqual(['harness_instances_list'])
    expect(inventory).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  } finally {
    finishChecks()
    await readback
  }
  expect(value.mock.calls.map(([name]) => name)).toEqual([
    'harness_instances_list', 'harness_qualifications_list',
  ])
  expect(inventory).toHaveBeenCalledOnce()
  expect(query).toHaveBeenCalledOnce()
})
