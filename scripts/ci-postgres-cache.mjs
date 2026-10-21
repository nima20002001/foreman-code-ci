import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function ciPostgresCacheDirectory(environment = process.env) {
  if (environment.CI_HOST_RUNNER !== '1' || !environment.FOREMAN_CODE_CI_HOST_RUN_ID) return undefined
  return environment.FOREMAN_CODE_CI_POSTGRES_CACHE ?? join(homedir(), '.cache', 'foreman-ci-postgres')
}

// The heavy-job wrapper replaces TMPDIR, so the host run's directory travels in its own variable.
export function ciTemplateCacheMarker(environment = process.env) {
  const directory = environment.FOREMAN_CODE_CI_DATABASE_STATE ?? environment.TMPDIR
  return directory ? join(directory, 'test-database-template-cache') : undefined
}

export function ciTemplateCacheDirectory(environment = process.env) {
  const marker = ciTemplateCacheMarker(environment)
  if (!ciPostgresCacheDirectory(environment) || !marker) return undefined
  return existsSync(marker) ? readFileSync(marker, 'utf8') : undefined
}
