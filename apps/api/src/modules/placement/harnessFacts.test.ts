import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord } from '../harnesses/installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../harnesses/instanceRegistry.js'
import { qualificationIdentity } from '../harnesses/qualification/identity.js'
import { readPlacementHarnessFacts } from './harnessFacts.js'
import { placementDigest } from './binding.js'

function fixture(driver: 'codex' | 'claude' = 'codex', hostKind: 'main' | 'device' = 'main') {
  const mainId = randomUUID()
  const hostRef = hostKind === 'main' ? { kind: 'main' as const, mainId }
    : { kind: 'device' as const, mainId, deviceId: randomUUID() }
  const instanceId = randomUUID()
  const fingerprint = 'a'.repeat(64)
  const suiteRevision = 'codex-live-fixture'
  const configuration = driver === 'codex' ? DEFAULT_HARNESS_DEFAULTS.codex : { harness: 'claude' as const, model: 'claude-haiku-4-5',
    authMode: 'subscription' as const, configDirectory: '/home/operator/.claude', permissionMode: 'default' as const,
    sandbox: 'danger-full-access' as const, tools: ['Read', 'Write'], permissionRules: [], instructions: '', mcpServers: {} }
  const installation: HarnessInstallationRecord = {
    hostRef, harnessInstallationId: 'installed-codex', installationFingerprint: fingerprint,
    driverId: driver, driverRevision: '1', protocolRevision: 'codex-native-adapter-v1',
    environmentGeneration: 'environment', connectionGeneration: 'connection',
    observedVersion: hostKind === 'device' ? '0.154.0' : null,
    installed: true, authenticated: null, compatible: null, qualified: null,
    launcher: { requested: '/installed/codex', resolvedLauncher: '/installed/codex', fingerprint,
      payloadFingerprints: [{ path: '/installed/codex', fingerprint }], status: 'installed', interpreter: null,
      diagnostics: [], checkedAt: new Date().toISOString(),
      environment: { generation: 'environment', provenance: 'systemd', cwd: '/workspace', path: '/usr/bin' } },
  }
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  instances.reload([{ instanceId, instanceRevision: '1', driverId: driver, enabled: true, configuration }])
  const installations = new HarnessInstallationRegistry(instances)
  installations.refresh([installation])
  const binding = installations.pin({ instanceId, hostRef, harnessInstallationId: installation.harnessInstallationId,
    connectionGeneration: 'connection', environmentGeneration: 'environment' })
  const override: HostHarnessOverride = { instanceId, revision: 1, instanceRevision: '1',
    target: { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: installation.harnessInstallationId,
      installationFingerprint: fingerprint }, presetId: `local-default:${driver}`, enabled: true, driverId: driver,
    configuration, configurationFingerprint: commandInputHash(configuration), qualification: 'qualified' }
  const proof: HostHarnessProfileEvidence = { target: override.target, instanceRevision: '1',
    configurationFingerprint: override.configurationFingerprint, driverId: driver, driverRevision: '1',
    protocolRevision: installation.protocolRevision, suiteRevision: 'codex-profile-check-v1',
    environmentGeneration: 'environment', connectionGeneration: 'connection', authenticated: true,
    compatible: true, qualified: true, checkedAt: new Date().toISOString() }
  const evidence = { qualificationIdentity: qualificationIdentity(binding, suiteRevision) }
  const records = [{ harness: 'codex', version: '0.154.0', binary_sha256: fingerprint, suite_revision: suiteRevision,
    profile: 'codex-0.156', checks: [{ id: 'native-fixture-check', passed: true, detail: null }], failure_reason: null,
    started_at: new Date(), checked_at: new Date(), evidence }]
  const settingsRecords = [override]
  const proofRecords = new Map<number, HostHarnessProfileEvidence[]>([[1, [proof]]])
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('from harness_instance_settings')) {
      const selected = [...settingsRecords].sort((left, right) => right.revision - left.revision)
      return { rows: (sql.includes('limit 1') ? selected.slice(0, 1) : selected).map(record => ({ record })) }
    }
    if (sql.includes('from harness_instance_profile_evidence')) {
      const revisions = Array.isArray(values?.[1]) ? values[1] : [values?.[1]]
      return { rows: revisions.flatMap(revision => (proofRecords.get(Number(revision)) ?? [])
        .map(record => ({ instance_revision: Number(revision), record }))) }
    }
    if (sql.includes('from host_harness_measurements')) return { rows: records.map(row => ({
      evidence: row.evidence, qualification: { harness: row.harness, version: row.version, binarySha256: row.binary_sha256,
        suiteRevision: row.suite_revision, profile: row.profile, status: 'qualified', checks: row.checks,
        failureReason: row.failure_reason, startedAt: row.started_at.toISOString(), checkedAt: row.checked_at.toISOString() },
    })) }
    return { rows: records }
  })
  const placement: Pick<AcceptedNodePlacement, 'hostRef' | 'payload'> = { hostRef, payload: {
    kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: driver, driverRevision: '1',
    instanceId, instanceRevision: '1', harnessInstallationId: installation.harnessInstallationId,
    installationFingerprint: fingerprint, runtimeContractVersion: 1, protocolRevision: installation.protocolRevision, credentialScopeRefs: [],
  } }
  const read = (options?: { purpose: 'resident' }) => readPlacementHarnessFacts(
    { query } as unknown as GraphSqlClient, placement, installations, { codex: suiteRevision }, options)
  return { read, installations, records, proof, evidence, override, placement, query, settingsRecords, proofRecords }
}

async function reconnectedWorker() {
  const f = fixture('codex', 'device')
  if (f.placement.payload.kind !== 'agent' || f.placement.hostRef.kind !== 'device') {
    throw new Error('Expected a Worker Agent placement.')
  }
  const initial = await f.read()
  if (!initial.qualification) throw new Error('Expected native Worker qualification.')
  f.proof.completedNativeQualification = { purpose: 'explicit-host-qualification', checkId: randomUUID(),
    target: f.override.target, binarySha256: initial.qualification.binarySha256!, record: initial.qualification,
    binding: { mainId: f.placement.hostRef.mainId, deviceId: f.placement.hostRef.deviceId,
      workerInstallationId: f.override.target.applicationInstallationId, keyRevision: 1, authorizationRevision: 1,
      bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 },
  }
  const accepted = await f.read()
  f.placement.payload.profileProofDigest = placementDigest(accepted.profileProof)
  f.placement.payload.qualificationDigest = placementDigest(accepted.qualification)
  const original = structuredClone(f.placement)
  const refreshed: HostHarnessProfileEvidence = { ...f.proof, connectionGeneration: 'replacement-channel',
    checkedAt: new Date(Date.parse(f.proof.checkedAt) + 1_000).toISOString() }
  f.proofRecords.set(1, [refreshed, f.proof])
  f.installations.refresh(f.installations.list().map(installation => ({
    ...installation, connectionGeneration: refreshed.connectionGeneration,
  })))
  return { ...f, accepted, original, refreshed }
}

it('launches an unstarted Worker with its requalified connection and retains the accepted Run facts', async () => {
  const f = await reconnectedWorker()
  const launched = await f.read()
  expect(launched.profileProof).toEqual(f.refreshed)
  expect(launched.qualification).toEqual(f.accepted.qualification)
  expect(f.placement).toEqual(f.original)
  expect((await f.read({ purpose: 'resident' })).profileProof).toEqual(f.accepted.profileProof)
})

it('uses the completed native qualification from the reconnected Worker check', async () => {
  const f = await reconnectedWorker()
  if (f.placement.hostRef.kind !== 'device' || !f.accepted.qualification) {
    throw new Error('Expected a qualified Worker placement.')
  }
  const qualification = { ...f.accepted.qualification, checkedAt: f.refreshed.checkedAt }
  f.refreshed.completedNativeQualification = { purpose: 'explicit-host-qualification', checkId: randomUUID(),
    target: f.override.target, binarySha256: qualification.binarySha256!, record: qualification,
    binding: { mainId: f.placement.hostRef.mainId, deviceId: f.placement.hostRef.deviceId,
      workerInstallationId: f.override.target.applicationInstallationId, keyRevision: 1, authorizationRevision: 1,
      bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 2 },
  }
  expect((await f.read()).qualification).toEqual(qualification)
  expect(f.placement).toEqual(f.original)
})

it.each(['missing-check', 'failed-check', 'environment', 'configuration', 'binary'] as const)(
  'rejects an unstarted reconnected Worker with a %s', async defect => {
    const f = await reconnectedWorker()
    if (defect === 'missing-check') f.proofRecords.set(1, [f.proof])
    if (defect === 'failed-check') f.refreshed.qualified = false
    if (defect === 'environment') f.refreshed.environmentGeneration = 'replacement-environment'
    if (defect === 'configuration') f.refreshed.configurationFingerprint = 'different-configuration'
    if (defect === 'binary') f.installations.refresh(f.installations.list().map(installation => ({
      ...installation, installationFingerprint: 'b'.repeat(64),
    })))
    await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
    expect(f.placement).toEqual(f.original)
  },
)

it('admits passive inventory only with its exact measured binary and qualified profile', async () => {
  const f = fixture()
  const facts = await f.read()
  expect(facts.installation.observedVersion).toBe('0.154.0')
  expect(facts.profileProof).toMatchObject({ authenticated: true, compatible: true, qualified: true })
  expect(f.installations.list()[0]?.observedVersion).toBeNull()
})

it('identifies a missing Main binary measurement without exposing private qualification data', async () => {
  const f = fixture()
  f.records.length = 0
  await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE',
    details: { reason: 'main_qualification_identity_missing', hostKind: 'main' } })
})

it.each(['payload', 'generation', 'host', 'missing', 'profile', 'suite-check'] as const)(
  'rejects unconfirmed %s qualification without promoting passive metadata', async failure => {
    const f = fixture()
    if (failure === 'payload') f.evidence.qualificationIdentity.payloadFingerprints = [
      { ...f.evidence.qualificationIdentity.payloadFingerprints[0]!, fingerprint: 'changed' },
    ]
    if (failure === 'generation') f.evidence.qualificationIdentity.connectionGeneration = 'old'
    if (failure === 'host') f.evidence.qualificationIdentity.selection = {
      ...f.evidence.qualificationIdentity.selection, hostRef: { kind: 'main', mainId: randomUUID() },
    }
    if (failure === 'missing') f.records.length = 0
    if (failure === 'profile') f.proof.authenticated = false
    if (failure === 'suite-check') f.records[0]!.checks[0]!.passed = false
    await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
  },
)

it('retains original qualification for a surviving process across transport reconnection only', async () => {
  const f = fixture()
  f.installations.refresh(f.installations.list().map(installation => ({
    ...installation, connectionGeneration: 'replacement-channel',
  })))
  await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
  const facts = await f.read({ purpose: 'resident' })
  expect(facts.installation.connectionGeneration).toBe('replacement-channel')
  expect(facts.profileProof.connectionGeneration).toBe('connection')
  expect(facts.qualification?.status).toBe('qualified')
})

it('keeps the qualified installed payload for a resident process while new admission requires the updated payload', async () => {
  const f = fixture()
  const original = f.installations.list()[0]!
  const fingerprint = 'b'.repeat(64)
  f.installations.refresh([{ ...original, installationFingerprint: fingerprint,
    launcher: { ...original.launcher, fingerprint,
      payloadFingerprints: [{ path: '/installed/codex', fingerprint }] } }])
  await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
  const resident = await f.read({ purpose: 'resident' })
  expect(resident.installation.installationFingerprint).toBe(original.installationFingerprint)
  expect(resident.profileProof).toEqual(f.proof)
  expect(resident.qualification?.status).toBe('qualified')
  expect(f.installations.list()[0]!.installationFingerprint).toBe(fingerprint)
})

it.each(['environment', 'unknown-installation', 'payload', 'disabled'])('keeps %s checks for an existing process', async defect => {
  const f = fixture()
  const installation = { ...f.installations.list()[0]!, connectionGeneration: 'replacement-channel' }
  if (defect === 'environment') installation.environmentGeneration = 'changed'
  if (defect === 'unknown-installation' && f.placement.payload.kind === 'agent') {
    f.placement.payload.installationFingerprint = 'unknown'
  }
  if (defect === 'payload') installation.launcher = { ...installation.launcher,
    payloadFingerprints: [{ path: '/installed/codex', fingerprint: 'b'.repeat(64) }] }
  if (defect === 'disabled') f.override.enabled = false
  f.installations.refresh([installation])
  await expect(f.read({ purpose: 'resident' })).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
})

it.each(['missing', 'unreadable', 'incomplete'] as const)(
  'retains the admitted installation through %s replacement inventory and the completed update', async state => {
    const f = fixture()
    const original = f.installations.list()[0]!
    const accepted = await f.read()
    if (f.placement.payload.kind !== 'agent') throw new Error('Expected an Agent placement.')
    f.placement.payload.profileProofDigest = placementDigest(accepted.profileProof)
    f.placement.payload.qualificationDigest = placementDigest(accepted.qualification)
    f.installations.refresh([{ ...original, installed: state !== 'missing', installationFingerprint: null,
      launcher: { ...original.launcher, status: state === 'incomplete' ? 'installed' : state, fingerprint: null } }])
    await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
    expect((await f.read({ purpose: 'resident' })).qualification).toEqual(accepted.qualification)
    const fingerprint = 'b'.repeat(64)
    f.installations.refresh([{ ...original, installationFingerprint: fingerprint,
      launcher: { ...original.launcher, fingerprint,
        payloadFingerprints: [{ path: '/installed/codex', fingerprint }] } }])
    await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
    const resident = await f.read({ purpose: 'resident' })
    expect(resident.installation).toEqual(accepted.installation)
    expect(resident.profileProof).toEqual(accepted.profileProof)
    expect(resident.qualification).toEqual(accepted.qualification)
  },
)

it('restores the pinned Main qualification from persisted records after restart and requalification', async () => {
  const f = fixture()
  const original = await f.read()
  if (f.placement.payload.kind !== 'agent') throw new Error('Expected an Agent placement.')
  f.placement.payload.profileProofDigest = placementDigest(original.profileProof)
  f.placement.payload.qualificationDigest = placementDigest(original.qualification)
  const newer = structuredClone(f.records[0]!)
  newer.checked_at = new Date(newer.checked_at.getTime() + 1_000)
  f.records.push(newer)
  const restarted = new HarnessInstallationRegistry(new HarnessInstanceRegistry(localHarnessDrivers))
  restarted.refresh(f.installations.list())
  const recovered = await readPlacementHarnessFacts({ query: f.query } as unknown as GraphSqlClient,
    f.placement, restarted, { codex: newer.suite_revision })
  expect(recovered.qualification).toEqual(original.qualification)
  expect(recovered.profileProof).toEqual(original.profileProof)
  expect(restarted.list()[0]?.observedVersion).toBeNull()
  expect((await f.read({ purpose: 'resident' })).qualification).toEqual(original.qualification)
  delete f.placement.payload.qualificationDigest
  expect((await f.read()).qualification?.checkedAt).toBe(newer.checked_at.toISOString())
})

it('resolves a resident proof across historical settings revisions after a payload rollback', async () => {
  const f = fixture()
  const original = await f.read()
  if (f.placement.payload.kind !== 'agent') throw new Error('Expected an Agent placement.')
  f.placement.payload.profileProofDigest = placementDigest(original.profileProof)
  f.placement.payload.qualificationDigest = placementDigest(original.qualification)
  const returned = { ...f.override, revision: 3 }
  const newerProof = { ...f.proof, checkedAt: new Date(Date.parse(f.proof.checkedAt) + 1_000).toISOString() }
  f.settingsRecords.push(returned)
  f.proofRecords.set(3, [newerProof])
  const resident = await f.read({ purpose: 'resident' })
  expect(resident.override.revision).toBe(1)
  expect(resident.profileProof).toEqual(original.profileProof)
  expect((await f.read()).profileProof).toEqual(original.profileProof)
  delete f.placement.payload.profileProofDigest
  delete f.placement.payload.qualificationDigest
  const next = await f.read()
  expect(next.override.revision).toBe(3)
  expect(next.profileProof).toEqual(newerProof)
})

it('rejects missing pinned qualification even when a newer measurement is qualified', async () => {
  const f = fixture()
  if (f.placement.payload.kind !== 'agent') throw new Error('Expected an Agent placement.')
  f.placement.payload.qualificationDigest = 'b'.repeat(64)
  await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE',
    details: { reason: 'main_qualification_identity_missing' } })
})

it.each([true, false])('uses the latest measurement after a native instance revision changes, passed=%s', async passed => {
  const f = fixture()
  const newer = structuredClone(f.records[0]!)
  newer.evidence.qualificationIdentity.selection = {
    ...newer.evidence.qualificationIdentity.selection, instanceRevision: '2',
  }
  newer.checked_at = new Date(newer.checked_at.getTime() + 1_000)
  newer.checks[0]!.passed = passed
  f.records.push(newer)
  if (passed) expect((await f.read()).qualification?.checkedAt).toBe(newer.checked_at.toISOString())
  else await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
})

it('admits Main Claude by its exact qualified profile check, which is its native qualification', async () => {
  const f = fixture('claude')
  f.records.length = 0
  const facts = await f.read()
  expect(facts.profileProof).toMatchObject({ authenticated: true, compatible: true, qualified: true })
  expect(facts.qualification).toBeUndefined()
  f.proof.qualified = false
  await expect(f.read()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE',
    message: 'The native check for the selected harness profile did not pass.',
    details: { reason: 'profile_check_failed' } })
})


it('resolves a pinned profile across a large settings history with bounded database reads', async () => {
  const f = fixture()
  const accepted = await f.read()
  if (f.placement.payload.kind !== 'agent') throw new Error('Expected an Agent placement.')
  f.placement.payload.profileProofDigest = placementDigest(accepted.profileProof)
  f.placement.payload.qualificationDigest = placementDigest(accepted.qualification)
  for (let revision = 2; revision <= 80; revision++) {
    f.settingsRecords.push({ ...f.override, revision })
    f.proofRecords.set(revision, [{ ...f.proof, checkedAt: new Date(Date.parse(f.proof.checkedAt) + revision).toISOString() }])
  }
  const before = structuredClone({ settings: f.settingsRecords, proofs: [...f.proofRecords], placement: f.placement })
  f.query.mockClear()
  expect(await f.read()).toEqual(accepted)
  expect({ settings: f.settingsRecords, proofs: [...f.proofRecords], placement: f.placement }).toEqual(before)
  expect(f.query.mock.calls.length).toBeLessThanOrEqual(4)
})
