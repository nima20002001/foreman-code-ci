export interface CiRepositoryCapabilities {
  parts: boolean
  integrationPartitions: boolean
  affected: boolean
}

/** The suite hook implements the named CI parts; selectors opt into file selection and partitioning. */
export function ciRepositoryCapabilities(files: Iterable<string>): CiRepositoryCapabilities {
  const paths = new Set(files)
  const hook = paths.has('scripts/ci-suite.sh')
  return {
    parts: hook,
    integrationPartitions: hook && paths.has('scripts/ci-files.mjs'),
    affected: hook && paths.has('scripts/ci-affected-run.mjs'),
  }
}
