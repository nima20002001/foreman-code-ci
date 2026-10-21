import type { VerificationCapability, VerificationEnvironment }
  from '../packages/contracts/src/verificationEnvironment.mjs'

export interface UnavailableIntegrationFile {
  file: string
  code: null
  complete: false
  requiredCapabilities: VerificationCapability[]
  reason: string
}

export function integrationEnvironmentCapabilities(
  environment?: Record<string, string | undefined>,
): Promise<VerificationEnvironment>

export function supportsInstalledWorkerHost(
  facts: { os: string; osRelease: string; arch: string; libc: string; node: string;
    rootPersistent: boolean; homePersistent: boolean; storagePersistent: boolean },
  targets: Array<{ os: string; osRelease: string; arch: string; libc: string; node: string }>,
): boolean
export function partitionIntegrationCapabilities(files: string[], environment: VerificationEnvironment): {
  runnable: string[]
  unavailable: UnavailableIntegrationFile[]
}

export function partitionUnitCapabilities(files: string[], environment: VerificationEnvironment): {
  runnable: string[]
  unavailable: UnavailableIntegrationFile[]
}
