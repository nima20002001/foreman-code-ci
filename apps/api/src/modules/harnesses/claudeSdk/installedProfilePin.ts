import { isDeepStrictEqual } from 'node:util'
import { ClaudeQualificationPinSchema } from '@foreman-code/contracts/claude-qualification'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { DomainError } from '../../errors.js'
import type { RegistryHarnessSelection } from '../installationRegistry.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { CLAUDE_PROFILE_CHECK_REVISION } from './profileRevision.js'

/** A saved native proof applies only while the paired host reports the same installed SDK and executable. */
export function installedClaudeProfilePin(value: HostHarnessOverride, binding: RegistryHarnessSelection,
  proof: HostHarnessProfileEvidence | null) {
  const installation = binding.installation
  const pin = proof?.claudeProof?.pin
  const nativeSha256 = installation.launcher.payloadFingerprints
    ?.find(payload => payload.path === installation.launcher.resolvedLauncher)?.fingerprint
  if (value.configuration.harness !== 'claude' || !value.enabled || installation.driverId !== 'claude'
    || !installation.installed || installation.launcher.status !== 'installed'
    || installation.launcher.fingerprint !== installation.installationFingerprint
    || installation.installationFingerprint !== value.target.installationFingerprint
    || binding.selection.instanceId !== value.instanceId || binding.selection.instanceRevision !== value.instanceRevision
    || !isDeepStrictEqual(binding.selection.hostRef, value.target.hostRef)
    || binding.selection.harnessInstallationId !== value.target.harnessInstallationId
    || value.configurationFingerprint !== commandInputHash(withAdvancedDefaults(value.configuration))
    || !proof?.qualified || proof.authenticated !== true || proof.compatible !== true
    || !pin || !installation.claudeSdk || !isDeepStrictEqual(proof.target, value.target)
    || proof.instanceRevision !== value.instanceRevision || proof.configurationFingerprint !== value.configurationFingerprint
    || proof.suiteRevision !== CLAUDE_PROFILE_CHECK_REVISION || proof.driverId !== 'claude'
    || proof.driverRevision !== installation.driverRevision || proof.protocolRevision !== installation.protocolRevision
    || proof.environmentGeneration !== installation.environmentGeneration
    || proof.connectionGeneration !== installation.connectionGeneration
    || pin.sdkVersion !== installation.claudeSdk.version || pin.sdkIntegrity !== installation.claudeSdk.integrity
    || pin.executableSha256 !== nativeSha256 || pin.profilePath !== value.configuration.configDirectory
    || pin.configRevision !== value.instanceRevision) {
    throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The installed Claude profile requires a current native check.', 409)
  }
  return ClaudeQualificationPinSchema.parse(pin)
}
