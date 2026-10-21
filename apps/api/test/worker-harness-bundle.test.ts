import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const workerRequire = createRequire(new URL('../../worker/package.json', import.meta.url))
const { build } = workerRequire('esbuild') as {
  build(options: Record<string, unknown>): Promise<{ errors: unknown[]; outputFiles: unknown[] }>
}
const { assertWorkerDependency } = workerRequire(
  fileURLToPath(new URL('../../../scripts/worker-artifact-files.mjs', import.meta.url)),
) as { assertWorkerDependency(path: string): void }
const { workerContractAliases } = workerRequire(
  fileURLToPath(new URL('../../../scripts/worker-snapshot-policy.mjs', import.meta.url)),
) as { workerContractAliases(exports: Record<string, unknown>): Record<string, string> }

it('bundles installed Worker harness discovery with the production dependency guard', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../packages/contracts/package.json', import.meta.url),
    'utf8')) as { exports: Record<string, unknown> }
  await expect(build({
    absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
    entryPoints: ['apps/api/src/modules/harnesses/installedWorkerHarnessOptions.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: workerContractAliases(manifest.exports),
    plugins: [{ name: 'worker-dependency-policy', setup(builder: {
      onResolve(options: { filter: RegExp }, callback: (input: { path: string }) => void): void
    }) {
      builder.onResolve({ filter: /.*/ }, input => { assertWorkerDependency(input.path) })
    } }],
  })).resolves.toMatchObject({ errors: [], outputFiles: expect.any(Array) })
})
