import type { HarnessInstallationRegistry, RegistryHarnessSelection } from '../installationRegistry.js'
import type { QualificationSuite, QualificationSuiteInput } from './types.js'

export function qualificationRevisionWithIdentity(revision: string): string {
  return `${revision}+identity-v1`
}

/** The same selection and inventory evidence used for admission, never provider
 * session provenance or a filesystem observation mislabeled as qualification. */
export function qualificationIdentity(binding: RegistryHarnessSelection, suiteRevision: string) {
  return {
    schemaVersion: 1,
    selection: binding.selection,
    driverRevision: binding.installation.driverRevision,
    protocolRevision: binding.installation.protocolRevision,
    suiteRevision,
    environmentGeneration: binding.installation.environmentGeneration,
    connectionGeneration: binding.installation.connectionGeneration,
    launcher: binding.installation.launcher.resolvedLauncher,
    payloadFingerprints: binding.installation.launcher.payloadFingerprints ?? [],
  }
}

/** Only explicitly supplied, canonical host inventory can bind live evidence.
 * Forced live runs execute every time; only their evidence is generation-fenced. */
export function withQualificationIdentity(suite: QualificationSuite, registry: HarnessInstallationRegistry,
  pin: (input: QualificationSuiteInput) => RegistryHarnessSelection): QualificationSuite {
  const revision = qualificationRevisionWithIdentity(suite.revision)
  return { harness: suite.harness, revision,
    async run(input) {
      const binding = pin(input)
      const launcher = binding.installation.launcher
      const executable = launcher.payloadFingerprints?.find((entry) => entry.path === launcher.resolvedLauncher)
      if (binding.selection.driverId !== suite.harness || launcher.resolvedLauncher !== input.binary
        || executable?.fingerprint !== input.binarySha256) {
        throw new Error('Qualification must use the exact selected installation launcher.')
      }
      registry.assertCurrent(binding)
      const result = await suite.run(input)
      registry.assertCurrent(binding)
      return { ...result, evidence: { ...result.evidence,
        qualificationIdentity: qualificationIdentity(binding, revision) } }
    },
  }
}
