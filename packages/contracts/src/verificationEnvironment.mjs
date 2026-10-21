/** The isolated Job runtime supplies delegated child cgroups and private PostgreSQL. */
export const ISOLATED_VERIFICATION_ENVIRONMENT = Object.freeze({
  schemaVersion: 1,
  runtime: 'isolated-job',
  capabilities: Object.freeze({ nativeCgroupDelegation: true, testDatabaseStartup: true,
    dockerCompose: false, installedWorkerHost: false }),
  postgres: 'job-private',
  git: 'mounted-readonly',
})

/** This describes the installed runtime; it does not grant permissions or enable capabilities. */
export function readVerificationEnvironment(environment) {
  const value = environment.FOREMAN_CODE_VERIFICATION_ENVIRONMENT
  if (value === undefined) {
    if (environment.FOREMAN_CODE_VERIFICATION_ROOT) {
      throw new Error('Verification Job environment contract is missing; refresh the installed runtime.')
    }
    return null
  }
  if (value !== 'isolated-job-v1') throw new Error('Unknown verification environment contract.')
  return ISOLATED_VERIFICATION_ENVIRONMENT
}
