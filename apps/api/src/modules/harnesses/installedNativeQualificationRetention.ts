import type pg from 'pg'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { CompletedNativeQualificationSchema, type HostHarnessOverride, type HostHarnessProfileEvidence, type HostHarnessInstallationDto } from '@foreman-code/contracts/harness-registry'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { QUALIFICATION_TARGET_PROFILE } from './qualification/profiles.js'
import { HarnessQualificationSchema } from '@foreman-code/contracts/harness-qualification'
import type { HarnessQualificationRepository } from './qualification/repository.js'
import { completedNativeQualificationChecks } from './installedNativeQualification.js'
import { matchesHarnessConnectionGeneration } from './hostConnectionGeneration.js'
import { DomainError } from '../errors.js'
import { CompatibilityHarnessSchema } from '@foreman-code/contracts'

export interface NativeQualificationRetention {
  /** Returns the final live-channel fence to run after the profile insert and before commit. */
  retain(client: pg.PoolClient, value: HostHarnessOverride, proof: HostHarnessProfileEvidence,
    checkId: string, signal: AbortSignal): Promise<() => Promise<void>>
  refresh(value: HostHarnessOverride, signal: AbortSignal): Promise<void>
}
const same = (a: unknown, b: unknown) => commandInputHash(a) === commandInputHash(b)
const denied = (): never => { throw new DomainError('HARNESS_PROFILE_EVIDENCE_MISMATCH', 'Completed native qualification must match the current authorized host, check and installed bytes.', 409) }

/** Main-only retention into the existing harness_qualifications table. The
 * profile-check command provides its live authorized SQL transaction/receipt. */
export function createInstalledNativeQualificationRetention(input: {
  repository: Pick<HarnessQualificationRepository, 'save'>
  currentBinding(deviceId: string): Readonly<DeviceSessionBinding> | null
  currentInstallation(value: HostHarnessOverride): HostHarnessInstallationDto | null
  suiteRevision: string
  refreshInstallation(value: HostHarnessOverride, signal: AbortSignal): Promise<void>
}): NativeQualificationRetention {
  return { refresh: input.refreshInstallation, async retain(client, value, proof, checkId, signal) {
    const parsedDriver = CompatibilityHarnessSchema.safeParse(value.driverId)
    if (!parsedDriver.success) return denied()
    const harness = parsedDriver.data
    const suiteRevision = input.suiteRevision
    if (!suiteRevision) denied()
    const receipt = CompletedNativeQualificationSchema.parse(proof.completedNativeQualification)
    const assertCurrent = async () => {
      signal.throwIfAborted()
      const installation = input.currentInstallation(value)
      const binding = value.target.hostRef.kind === 'device' ? input.currentBinding(value.target.hostRef.deviceId) : null
      const record = receipt.record
      const binarySha256 = installation?.launcher.payloadFingerprints?.find(row => row.path === installation.launcher.resolvedLauncher)?.fingerprint
      if (!binding || !installation || value.target.hostRef.kind !== 'device' || !same(binding, receipt.binding)
        || receipt.purpose !== 'explicit-host-qualification' || receipt.checkId !== checkId || !same(receipt.target, value.target)
        || !same(proof.target, value.target) || !same(installation.hostRef, value.target.hostRef)
        || binding.mainId !== value.target.hostRef.mainId || binding.deviceId !== value.target.hostRef.deviceId
        || binding.workerInstallationId !== value.target.applicationInstallationId
        || !installation.installed || installation.driverId !== harness || installation.launcher.status !== 'installed'
        || installation.harnessInstallationId !== value.target.harnessInstallationId || installation.installationFingerprint !== value.target.installationFingerprint
        || installation.launcher.fingerprint !== value.target.installationFingerprint || binarySha256 !== receipt.binarySha256
        || record.binarySha256 !== receipt.binarySha256 || record.harness !== harness
        || record.suiteRevision !== suiteRevision || record.profile !== QUALIFICATION_TARGET_PROFILE[harness]
        || !record.startedAt || !record.checkedAt || !['qualified', 'failed'].includes(record.status)
        || record.checks.filter(check => check.id === 'owned-resource-closure' && check.passed).length !== 1
        || proof.checkedAt !== record.checkedAt || proof.instanceRevision !== value.instanceRevision
        || proof.configurationFingerprint !== value.configurationFingerprint || proof.driverId !== value.driverId
        || proof.driverRevision !== installation.driverRevision || proof.protocolRevision !== installation.protocolRevision
        || proof.suiteRevision !== `${harness}-profile-check-v1` || proof.environmentGeneration !== installation.environmentGeneration
        || proof.connectionGeneration !== installation.connectionGeneration
        || !matchesHarnessConnectionGeneration(binding, proof.connectionGeneration)
        || proof.qualified !== (record.status === 'qualified')) denied()
      if (record.status === 'qualified' && (proof.authenticated !== true || proof.compatible !== true || !record.checks.length
        || record.checks.some(check => !check.passed) || completedNativeQualificationChecks().some(id => !record.checks.some(check => check.id === id && check.passed)))) denied()
    }
    await assertCurrent()
    await input.repository.save(HarnessQualificationSchema.parse(receipt.record), { purpose: receipt.purpose, checkId: receipt.checkId,
      binding: receipt.binding, target: receipt.target, profile: proof }, client)
    await assertCurrent()
    return assertCurrent
  } }
}
