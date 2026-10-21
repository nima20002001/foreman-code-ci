import { createRuntimeBuildIdentity } from '../packages/contracts/src/runtimeBuildIdentityNode.mjs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function copyApiRuntime(repository, output) {
  // Preserve the builder's relative asset paths inside the deployed API package.
  const runtime = join(output, 'ci-runtime')
  const controls = ['Containerfile', 'corepack', 'context.mjs', 'seed-policy.mjs',
    'verification-policy.mjs', 'verification-observation.mjs']
  const verification = ['ci-watchdog.mjs', 'ci-progress-reporter.mjs', 'ci-test-results.mjs', 'dense-resources.mjs',
    'verification-runner.mjs', 'verify-repository.mjs',
    'verification-reports.mjs', 'integration-process.mjs', 'integration-capabilities.mjs']
  const paths = [
    ...controls.map(name => `apps/worker/artifacts/ci-runtime/${name}`),
    ...verification.map(name => `scripts/${name}`),
    'apps/worker/src/diagnostics.mjs',
    'packages/contracts/src/verificationEnvironment.mjs',
    'packages/contracts/src/integrationScheduling.mjs',
  ]
  for (const path of paths) {
    const destination = join(runtime, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(repository, path), destination)
  }
  const browserSkill = 'modules/browser-runtime/skill/browser-use.md'
  await mkdir(dirname(join(output, browserSkill)), { recursive: true })
  await copyFile(join(repository, 'apps/api/src', browserSkill), join(output, browserSkill))
  const entrypoint = join(output, 'modules/jobs/ciRuntimeContext.mjs')
  await mkdir(dirname(entrypoint), { recursive: true })
  await writeFile(entrypoint,
    "export { buildCiRuntimeContext, ciRuntimeInputDigest, parseCiLock } from '../../ci-runtime/apps/worker/artifacts/ci-runtime/context.mjs'\n")
  await writeFile(join(output, 'runtime-build.json'), `${JSON.stringify(createRuntimeBuildIdentity(repository))}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repository = fileURLToPath(new URL('../', import.meta.url))
  const output = join(repository, 'apps/api/dist')
  await copyApiRuntime(repository, output)
}
