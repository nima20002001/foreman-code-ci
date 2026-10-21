import { isDeepStrictEqual } from 'node:util'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { HarnessInstanceProjection, HarnessInstanceRegistry } from './instanceRegistry.js'
import type { LauncherEvidence } from './hostDiscovery.js'
import { DomainError } from '../errors.js'

export interface HarnessInstallationRecord {
  readonly hostRef: CanonicalMachineReference
  /** Provider executable installation, never the W07 application installationId. */
  readonly harnessInstallationId: string
  readonly installationFingerprint: string | null
  readonly driverId: string
  readonly driverRevision: string
  readonly protocolRevision: string
  readonly environmentGeneration: string
  readonly connectionGeneration: string
  readonly launcher: LauncherEvidence
  readonly claudeSdk?: { version: string; integrity: string } | undefined
  readonly observedVersion: string | null
  readonly installed: boolean
  readonly authenticated: boolean | null
  readonly compatible: boolean | null
  readonly qualified: boolean | null
}
export interface PinnedHarnessSelection {
  readonly driverId: string
  readonly instanceId: string
  readonly instanceRevision: string
  readonly hostRef: CanonicalMachineReference
  readonly harnessInstallationId: string
  readonly installationFingerprint: string
}
export interface RegistryHarnessSelection {
  /** Revision of the selected host installation, not the entire inventory. */
  readonly inventoryRevision: number
  readonly selection: PinnedHarnessSelection
  readonly instance: HarnessInstanceProjection
  readonly installation: HarnessInstallationRecord
}
const hostKey = (host: CanonicalMachineReference) => host.kind === 'main' ? `main:${host.mainId}` : `device:${host.mainId}:${host.deviceId}`
// Publishing qualification results does not change the installation being checked.
const installationIdentity = (record: HarnessInstallationRecord) => ({ ...record,
  observedVersion: undefined, qualified: undefined,
  launcher: { ...record.launcher, checkedAt: undefined, diagnostics: undefined } })
const usableInstallation = (record: HarnessInstallationRecord) => record.installed
  && record.launcher.status === 'installed' && Boolean(record.installationFingerprint)
  && record.installationFingerprint === record.launcher.fingerprint

/** A projection of canonical authorized-host inventory; no native managers or IO. */
export class HarnessInstallationRegistry {
  private readonly installations = new Map<string, HarnessInstallationRecord>()
  private readonly revisions = new Map<string, number>()
  private readonly cache = new Map<string, { value: Promise<unknown> }>()
  private readonly retained = new Map<string, HarnessInstallationRecord>()
  private epoch = 0
  constructor(private readonly instances: HarnessInstanceRegistry) {}
  refresh(records: readonly HarnessInstallationRecord[]): void {
    const next = new Map<string, HarnessInstallationRecord>()
    for (const record of records) {
      const key = `${hostKey(record.hostRef)}:${record.harnessInstallationId}`
      if (next.has(key)) throw new Error('Duplicate host harness installation.')
      next.set(key, structuredClone(record))
    }
    for (const [key, record] of next) {
      const prior = this.installations.get(key)
      if (prior && usableInstallation(prior)
        && (prior.installationFingerprint !== record.installationFingerprint || !usableInstallation(record))) {
        this.retained.set(`${key}:${prior.installationFingerprint}`, structuredClone(prior))
      }
      if (!prior || !isDeepStrictEqual(installationIdentity(prior), installationIdentity(record))) this.revisions.set(key, ++this.epoch)
    }
    for (const key of this.revisions.keys()) if (!next.has(key)) {
      const previous = this.installations.get(key)
      if (previous && usableInstallation(previous)) {
        this.retained.set(`${key}:${previous.installationFingerprint}`, structuredClone(previous))
      }
      this.revisions.delete(key)
    }
    this.installations.clear()
    for (const [key, record] of next) this.installations.set(key, record)
    this.cache.clear()
  }
  list(): readonly HarnessInstallationRecord[] { return [...this.installations.values()].map((record) => structuredClone(record)) }
  residentInstallation(host: CanonicalMachineReference, installationId: string,
    fingerprint: string): HarnessInstallationRecord | undefined {
    const key = `${hostKey(host)}:${installationId}`
    const current = this.installations.get(key)
    const record = current && usableInstallation(current) && current.installationFingerprint === fingerprint
      ? current : this.retained.get(`${key}:${fingerprint}`)
    return record ? structuredClone(record) : undefined
  }
  invalidate(): void {
    this.epoch++
    for (const key of this.revisions.keys()) this.revisions.set(key, this.epoch)
    this.cache.clear()
  }
  pin(input: { instanceId: string; hostRef: CanonicalMachineReference; harnessInstallationId: string; connectionGeneration: string; environmentGeneration: string }): RegistryHarnessSelection {
    const instance = this.instances.select(input.instanceId)
    const key = `${hostKey(input.hostRef)}:${input.harnessInstallationId}`
    const record = this.installations.get(key)
    if (!record) {
      throw new DomainError('HARNESS_INVENTORY_UNAVAILABLE', 'Harness installation inventory is unavailable on the selected host.', 503)
    }
    if (!record.installationFingerprint || !record.installed || record.launcher.status !== 'installed'
      || record.launcher.fingerprint !== record.installationFingerprint) {
      throw new DomainError('HARNESS_INSTALLATION_INVALID', 'The selected host has no usable harness installation.', 409)
    }
    if (record.driverId !== instance.driverId || record.driverRevision !== instance.driverRevision) {
      throw new DomainError('HARNESS_INSTALLATION_CHANGED', 'The selected harness installation no longer matches its driver.', 409)
    }
    if (record.connectionGeneration !== input.connectionGeneration || record.environmentGeneration !== input.environmentGeneration) {
      throw new DomainError('HARNESS_INVENTORY_STALE', 'Harness inventory belongs to another connection or environment.', 409)
    }
    // Return independent serializable snapshots; no process/session/token state is shared.
    return { inventoryRevision: this.revisions.get(key)!, instance, installation: structuredClone(record), selection: Object.freeze({ driverId: instance.driverId, instanceId: instance.instanceId, instanceRevision: instance.instanceRevision, hostRef: Object.freeze({ ...input.hostRef }), harnessInstallationId: record.harnessInstallationId, installationFingerprint: record.installationFingerprint }) }
  }
  assertCurrent(binding: RegistryHarnessSelection): void {
    const key = `${hostKey(binding.selection.hostRef)}:${binding.selection.harnessInstallationId}`
    if (this.instances.select(binding.instance.instanceId).instanceRevision !== binding.instance.instanceRevision) {
      throw new DomainError('HARNESS_INSTANCE_CHANGED', 'Harness metadata binding is stale because its instance changed.', 409)
    }
    if (binding.inventoryRevision !== this.revisions.get(key)) {
      throw new DomainError('HARNESS_INVENTORY_STALE', 'Harness metadata binding is stale.', 409)
    }
  }
  async metadata<T>(binding: RegistryHarnessSelection, suiteRevision: string, load: () => Promise<T>): Promise<T> {
    this.assertCurrent(binding)
    const { instance, installation } = binding
    const key = JSON.stringify([hostKey(installation.hostRef), installation.harnessInstallationId, installation.installationFingerprint,
      instance.instanceId, instance.instanceRevision, instance.driverRevision, installation.protocolRevision, suiteRevision, installation.environmentGeneration, installation.connectionGeneration])
    let entry = this.cache.get(key)
    if (!entry) {
      if (this.cache.size >= 128) throw new Error('Harness metadata cache is full; refresh inventory.')
      entry = { value: Promise.resolve().then(load) }
      this.cache.set(key, entry)
      const selected = entry
      void entry.value.catch(() => { if (this.cache.get(key) === selected) this.cache.delete(key) })
    }
    const value = await entry.value
    this.assertCurrent(binding)
    return structuredClone(value) as T
  }
}
