import * as fs from 'node:fs'
import { PayloadFingerprintCache } from '../src/modules/harnesses/payloadFingerprintCache.js'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { describe, expect, it, vi } from 'vitest'
import { inspectInstalledCodex, readInstalledCodexQualification, retainInstalledHarnessInventory } from '../src/modules/harnesses/installedCodexInspection.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'

import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

async function fixture(version = '0.132.0') {
  const root = await mkdtemp(join(tmpdir(), 'installed-codex-inspection-'))
  const binary = join(root, 'codex')
  // File bytes only; this fixture is never an executable provider/probe.
  await writeFile(binary, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('actual-fixture-image')]), { mode: 0o700 })
  const path = join(root, 'installed-workflow.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 1, codexBinary: binary, appMcpLauncher: '/installed/graphql-mcp-launcher', expectedVersion: version, payloadPaths: [] }), { mode: 0o600 })
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID() }
  const input = { binding, configuration: { path, ownerUid: process.getuid!() }, environment: { PATH: '/usr/bin' }, cwd: root, signal: new AbortController().signal }
  return { root, binary, path, input }
}
function proof(target: NonNullable<Awaited<ReturnType<typeof inspectInstalledCodex>>['currentTarget']>): HarnessQualification {
  return { harness: 'codex', version: target.expectedVersion, binarySha256: target.binarySha256,
    suiteRevision: 'actual-suite-v1', profile: 'codex-0.156', status: 'qualified',
    checks: [{ id: 'native-protocol-and-live-turn', passed: true, detail: null }], failureReason: null,
    startedAt: '2026-10-01T00:00:00.000Z', checkedAt: '2026-10-01T00:01:00.000Z' }
}

describe('passive installed worker Codex evidence producer', () => {

  it('reuses worker inventory hashes while qualification inspection rereads bytes', async () => {
    const f = await fixture()
    try {
      vi.mocked(fs.createReadStream).mockClear()
      const input = { ...f.input, fingerprintCache: new PayloadFingerprintCache() }
      const first = await inspectInstalledCodex(input)
      expect(first.currentTarget).not.toBeNull()
      const second = await inspectInstalledCodex(input)
      expect(second.currentTarget?.binarySha256).toBe(first.currentTarget?.binarySha256)
      expect(fs.createReadStream).toHaveBeenCalledTimes(1)
      await inspectInstalledCodex({ ...f.input, fingerprintCache: new PayloadFingerprintCache() })
      expect(fs.createReadStream).toHaveBeenCalledTimes(2)
      await writeFile(f.binary, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('changed-image')]))
      expect((await inspectInstalledCodex(input)).currentTarget?.binarySha256)
        .not.toBe(first.currentTarget?.binarySha256)
      expect(fs.createReadStream).toHaveBeenCalledTimes(3)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
  it('derives installed metadata and the exact W07 tuple without promoting 0.132 selection or login to trust', async () => {
    const f = await fixture()
    try {
      const result = await inspectInstalledCodex(f.input)
      const target = result.currentTarget!
      expect(target.expectedVersion).toBe('0.132.0')
      expect(target.binarySha256).toBe(createHash('sha256').update(await readFile(f.binary)).digest('hex'))
      expect(result.inventory.instances).toEqual([])
      expect(result.inventory.installations[0]).toMatchObject({ driverId: 'codex', installed: true,
        connectionGeneration: harnessConnectionGeneration(f.input.binding), observedVersion: null,
        authenticated: null, compatible: null, qualified: false })
      expect(result.inventory.hostMetadata).toMatchObject({ hostRef: { kind: 'device', mainId: f.input.binding.mainId, deviceId: f.input.binding.deviceId }, applicationInstallationId: f.input.binding.workerInstallationId })
      expect(target.target.installationFingerprint).toBe(result.inventory.installations[0]?.installationFingerprint)
      const findInstalled = vi.fn(async () => [])
      expect(await readInstalledCodexQualification({ findInstalled }, target, 'actual-suite-v1')).toBeNull()
      expect(findInstalled).toHaveBeenCalledWith(target.target, target.binarySha256, 'actual-suite-v1')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it.each([false, true])('detects changed executable and payload bytes with cached inspection=%s', async cached => {
    const f = await fixture()
    try {
      const input = { ...f.input, ...(cached ? { fingerprintCache: new PayloadFingerprintCache() } : {}) }
      const payload = join(f.root, 'provider-payload')
      await writeFile(payload, 'payload-one')
      await writeFile(f.path, JSON.stringify({ schemaVersion: 1, codexBinary: f.binary, appMcpLauncher: '/installed/graphql-mcp-launcher', expectedVersion: '0.132.0', payloadPaths: [payload] }), { mode: 0o600 })
      const before = await inspectInstalledCodex(input)
      await writeFile(payload, 'payload-two')
      const afterPayload = await inspectInstalledCodex(input)
      expect(afterPayload.currentTarget?.target.installationFingerprint).not.toBe(before.currentTarget?.target.installationFingerprint)
      expect(afterPayload.currentTarget?.binarySha256).toBe(before.currentTarget?.binarySha256)
      await writeFile(f.binary, Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.from('replacement-image')]))
      const afterBinary = await inspectInstalledCodex(input)
      expect(afterBinary.currentTarget?.binarySha256).not.toBe(before.currentTarget?.binarySha256)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it.each([false, true])('rejects a missing pinned tool host with cached inspection=%s', async cached => {
    const f = await fixture()
    try {
      const input = { ...f.input, ...(cached ? { fingerprintCache: new PayloadFingerprintCache() } : {}) }
      const helper = join(f.root, 'codex-code-mode-host')
      await writeFile(f.path, JSON.stringify({ schemaVersion: 1, codexBinary: f.binary,
        appMcpLauncher: '/installed/graphql-mcp-launcher', expectedVersion: '0.132.0', payloadPaths: [helper] }), { mode: 0o600 })
      const missing = await inspectInstalledCodex(input)
      expect(missing.currentTarget).toBeNull()
      expect(missing.inventory.installations[0]).toMatchObject({ installed: false, qualified: false })
      await writeFile(helper, 'pinned tool host', { mode: 0o500 })
      const installed = await inspectInstalledCodex(input)
      expect(installed.currentTarget).not.toBeNull()
      expect(installed.inventory.installations[0]?.launcher.payloadFingerprints)
        .toEqual(expect.arrayContaining([expect.objectContaining({ path: helper })]))
      await rm(helper)
      expect((await inspectInstalledCodex(input)).currentTarget).toBeNull()
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
  it('returns unavailable selection without scanning PATH when configuration is absent and rejects local trust flags', async () => {
    const f = await fixture()
    try {
      expect((await inspectInstalledCodex({ ...f.input, configuration: null })).inventory.installations).toEqual([])
      await writeFile(f.path, JSON.stringify({ schemaVersion: 1, codexBinary: f.binary, appMcpLauncher: '/installed/graphql-mcp-launcher', expectedVersion: '0.132.0', payloadPaths: [], qualified: true }), { mode: 0o600 })
      await expect(inspectInstalledCodex(f.input)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      await chmod(f.path, 0o644)
      await expect(inspectInstalledCodex(f.input)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('keeps arbitrary executable scripts unqualified even when explicitly selected', async () => {
    const f = await fixture()
    try {
      await writeFile(f.binary, '#!/bin/sh\nexit 0\n')
      const result = await inspectInstalledCodex(f.input)
      expect(result.inventory.installations[0]).toMatchObject({ installed: true, installationFingerprint: null, qualified: false })
      expect(result.currentTarget).toBeNull()
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('requires the genuine exact current suite, SHA, profile, completed checks and positive persisted status', async () => {
    const f = await fixture()
    try {
      const target = (await inspectInstalledCodex(f.input)).currentTarget!
      const original = { ...proof(target), version: '0.160.0' }
      expect(await readInstalledCodexQualification({ findInstalled: async () => [original] }, target, 'actual-suite-v1')).toEqual(original)
      for (const changed of [ { status: 'unqualified' as const }, { status: 'baseline' as const },
        { binarySha256: 'a'.repeat(64) }, { suiteRevision: 'stale-suite' }, { checkedAt: null }, { checks: [] },
        { profile: 'codex-0.154' as const }, { checks: [{ id: 'native-protocol-and-live-turn', passed: false, detail: null }] } ]) {
        expect(await readInstalledCodexQualification({ findInstalled: async () => [{ ...original, ...changed }] }, target, 'actual-suite-v1')).toBeNull()
      }
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
  it('retains the passive report only on its current authenticated Main binding and revalidates read grants', async () => {
    const f = await fixture()
    let permitted = true
    let connected = true
    const binding = f.input.binding
    const principal: ManagementPrincipal = { id: 'operator-fixture', name: 'Read fixture', audience: 'operator', revokedAt: null,
      expiresAt: '9999-01-01T00:00:00.000Z', grants: [{ actions: ['harnesses:read'], scope: {} }] }
    const registration = { mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId,
      publicKeyFingerprint: 'a'.repeat(64), keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }
    const client = { release: () => undefined, query: async (sql: string) => {
      if (sql.includes('worker_installation_id::text')) return { rows: [{ id: binding.workerInstallationId }] }
      if (sql.includes('management_principals')) return { rows: [{ id: principal.id, name: principal.name, audience: 'operator',
        grants: permitted ? principal.grants : [], expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
      if (sql.includes('application_installation')) return { rows: [{ id: binding.mainId }] }
      if (sql.includes('device_registrations')) return { rows: [{ record: registration }] }
      return { rows: [] }
    } }
    const pool = { connect: async () => client } as unknown as pg.Pool
    const registry = new ProductionHarnessRegistry(pool, { codexBinary: 'not-probed',  },
      async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }), new HostHarnessProfileEvidenceRepository(pool),
      () => connected ? binding : null, {})
    try {
      const report = (await inspectInstalledCodex(f.input)).inventory
      await retainInstalledHarnessInventory({ registry, qualifications: { findInstalled: async () => [] }, binding, inventory: report, suiteRevision: 'actual-suite-v1' })
      const host = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
      const readback = await registry.get(principal, host)
      expect(readback.installations).toEqual(report.installations)
      expect(readback.installations[0]?.qualified).toBe(false)
      expect(() => registry.acceptRemoteSnapshot({ ...binding, connectionEpoch: randomUUID() }, report)).toThrow('unavailable connection generation')
      permitted = false
      await expect(registry.get(principal, host)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      connected = false
      expect(() => registry.acceptRemoteSnapshot(binding, report)).toThrow('unavailable connection generation')
    } finally { registry.stop(); await rm(f.root, { recursive: true, force: true }) }
  })

  it('retains the current payload proof when two versions share the same launcher bytes', async () => {
    const f = await fixture()
    try {
      const payload = join(f.root, 'native-payload')
      await writeFile(payload, 'native-a')
      await writeFile(f.path, JSON.stringify({ schemaVersion: 1, codexBinary: f.binary,
        appMcpLauncher: '/installed/graphql-mcp-launcher', expectedVersion: '0.154.0', payloadPaths: [payload] }), { mode: 0o600 })
      const previous = await inspectInstalledCodex(f.input)
      const old = { target: previous.currentTarget!.target, record: { ...proof(previous.currentTarget!), version: '0.158.0' } }
      await writeFile(payload, 'native-b')
      const current = await inspectInstalledCodex(f.input)
      const next = { target: current.currentTarget!.target, record: { ...proof(current.currentTarget!), version: '0.160.0' } }
      expect(old.record.binarySha256).toBe(next.record.binarySha256)
      expect(old.target.installationFingerprint).not.toBe(next.target.installationFingerprint)
      const records = [old, next]
      const qualifications = { findInstalled: async (target: typeof next.target) => records
        .filter(row => row.target.installationFingerprint === target.installationFingerprint).map(row => row.record) }
      const acceptRemoteSnapshot = vi.fn()
      await retainInstalledHarnessInventory({ registry: { acceptRemoteSnapshot }, qualifications,
        binding: f.input.binding, inventory: current.inventory, suiteRevision: 'actual-suite-v1' })
      expect(acceptRemoteSnapshot.mock.calls[0]?.[1].installations[0]).toMatchObject({ observedVersion: '0.160.0', qualified: true })
      expect(await readInstalledCodexQualification(qualifications, current.currentTarget!, 'actual-suite-v1')).toEqual(next.record)
      expect(old.record.version).toBe('0.158.0')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('Main supplies observed version only from its unique exact persisted proof and clears worker trust claims', async () => {
    const f = await fixture()
    try {
      const inspection = await inspectInstalledCodex(f.input), target = inspection.currentTarget!
      inspection.inventory.installations[0]!.qualified = true
      inspection.inventory.installations[0]!.observedVersion = '0.154.0'
      inspection.inventory.installations[0]!.authenticated = true
      const acceptRemoteSnapshot = vi.fn()
      await retainInstalledHarnessInventory({ registry: { acceptRemoteSnapshot }, qualifications: { findInstalled: async () => [] },
        binding: f.input.binding, inventory: inspection.inventory, suiteRevision: 'actual-suite-v1' })
      expect(acceptRemoteSnapshot.mock.calls[0]?.[1].installations[0]).toMatchObject({ observedVersion: null, qualified: false, authenticated: null })
      const actual = proof(target)
      await retainInstalledHarnessInventory({ registry: { acceptRemoteSnapshot }, qualifications: { findInstalled: async () => [actual] },
        binding: f.input.binding, inventory: inspection.inventory, suiteRevision: 'actual-suite-v1' })
      expect(acceptRemoteSnapshot.mock.calls[1]?.[1].installations[0]).toMatchObject({ observedVersion: '0.132.0', qualified: true, authenticated: null })
      await retainInstalledHarnessInventory({ registry: { acceptRemoteSnapshot }, qualifications: { findInstalled: async () => [actual, { ...actual, version: 'ambiguous-version' }] },
        binding: f.input.binding, inventory: inspection.inventory, suiteRevision: 'actual-suite-v1' })
      expect(acceptRemoteSnapshot.mock.calls[2]?.[1].installations[0]).toMatchObject({ observedVersion: null, qualified: false })
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

})
