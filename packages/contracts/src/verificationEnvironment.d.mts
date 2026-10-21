export type VerificationCapability = 'nativeCgroupDelegation' | 'testDatabaseStartup' | 'dockerCompose' | 'installedWorkerHost'

export interface VerificationEnvironment {
  readonly schemaVersion: 1
  readonly runtime: 'isolated-job' | 'host'
  readonly capabilities: Readonly<Record<VerificationCapability, boolean>>
  readonly postgres?: 'job-private'
  readonly git?: 'mounted-readonly'
}

export const ISOLATED_VERIFICATION_ENVIRONMENT: VerificationEnvironment
export function readVerificationEnvironment(
  environment: Record<string, string | undefined>,
): VerificationEnvironment | null
