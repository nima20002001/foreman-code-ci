export const workerEntryPoints = {
  cli: 'apps/worker/src/cli.mjs',
  worker: 'apps/worker/src/workerFactory.mjs',
}
export const rsyncWriterEntrypoint = 'apps/api/src/modules/byte-transfer/rsyncWriterCli.ts'
export const schemaWorkerEntrypoint = 'apps/api/src/modules/harnesses/compatibility/schemaWorker.ts'

export const verificationScripts = [
  'scripts/ci-watchdog.mjs',
  'scripts/ci-progress-reporter.mjs',
  'scripts/ci-test-results.mjs',
  'scripts/dense-resources.mjs',
  'scripts/verification-runner.mjs',
  'scripts/verify-repository.mjs',
  'scripts/verification-reports.mjs',
  'scripts/integration-process.mjs',
  'scripts/integration-capabilities.mjs',
]

export const workerSnapshotFiles = [
  'apps/web/public/graphql.svg',
  'scripts/build-worker-artifact.mjs',
  'scripts/quota-helper-abi.mjs',
  'scripts/worker-artifact-files.mjs',
  'scripts/worker-snapshot-policy.mjs',
  'scripts/graphql-mcp.mjs',
  'packages/contracts/package.json',
  'packages/contracts/src/productEnvironment.mjs',
  'packages/contracts/src/verificationEnvironment.mjs',
  'packages/contracts/src/integrationScheduling.mjs',
  'apps/worker/package.json',
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
]

export function assertWorkerSnapshotSource(path) {
  const forbiddenApiModule = /^apps\/api\/src\/(?:server|app|production)\.ts$/.test(path)
    || /^apps\/api\/src\/(?:infrastructure\/(?:db|database)|(?:db|migrations|bootstrap)\/)/.test(path)
  const invalidPath = path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')
  const testSource = /\.(?:test|spec)\.[cm]?[jt]s$/.test(path)
  const secretSource = /(?:^|\/)\.env(?:\.|$)|\.(?:pem|key)$|(?:^|\/)(?:credentials|secrets)\.json$/.test(path)
  const allowedSource = path.startsWith('apps/api/src/') || path.startsWith('apps/worker/src/')
    || path.startsWith('apps/worker/artifacts/') || path.startsWith('packages/contracts/src/')
    || verificationScripts.includes(path) || workerSnapshotFiles.includes(path)
  if (forbiddenApiModule || invalidPath || testSource || secretSource || !allowedSource) {
    throw new Error(`Forbidden snapshot source: ${path}`)
  }
}

export function workerContractAliases(exports) {
  return Object.fromEntries(Object.entries(exports).map(([key, value]) => [
    key === '.' ? '@foreman-code/contracts' : `@foreman-code/contracts/${key.slice(2)}`,
    `./packages/contracts/${(typeof value === 'string' ? value : value.import)
      .replace('./dist/', './src/').replace(/\.js$/, '.ts')}`,
  ]))
}
