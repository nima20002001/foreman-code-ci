import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRuntimeBuildIdentity } from '../packages/contracts/src/runtimeBuildIdentityNode.mjs'
import { copyApiRuntime } from './copy-api-runtime.mjs'

async function fixture(t) {
  const storage = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const root = await mkdtemp(join(storage, 'build-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['apps/api/src', 'apps/web/src', 'apps/web/public', 'packages/contracts/src']) {
    await mkdir(join(root, path), { recursive: true })
  }
  for (const path of ['package.json', 'pnpm-lock.yaml', 'apps/web/index.html', 'apps/web/vite.config.ts',
    'apps/api/package.json', 'apps/web/package.json', 'packages/contracts/package.json']) {
    await writeFile(join(root, path), '{}')
  }
  await writeFile(join(root, 'apps/api/src/app.ts'), 'export const response = { name: "first" }')
  await writeFile(join(root, 'apps/web/src/main.ts'), 'export const browser = "first"')
  await writeFile(join(root, 'packages/contracts/src/response.ts'), 'export const fields = ["name"]')
  return root
}

test('identifies in-place builds and contract changes independently of checkout location', async t => {
  const root = await fixture(t)
  const first = createRuntimeBuildIdentity(root)
  assert.deepEqual(createRuntimeBuildIdentity(root), first)
  const copy = await fixture(t)
  assert.deepEqual(createRuntimeBuildIdentity(copy), first)
  await writeFile(join(root, 'apps/api/src/app.ts'), 'export const response = { name: "second" }')
  const rebuilt = createRuntimeBuildIdentity(root)
  assert.notEqual(rebuilt.buildId, first.buildId)
  assert.equal(rebuilt.contractsId, first.contractsId)
  await writeFile(join(root, 'packages/contracts/src/response.ts'), 'export const fields = ["name", "revision"]')
  const extended = createRuntimeBuildIdentity(root)
  assert.notEqual(extended.buildId, rebuilt.buildId)
  assert.notEqual(extended.contractsId, rebuilt.contractsId)
  assert.equal(first.version, 1)
})

test('packages the captured build identity when the API runtime is copied through its library interface', async t => {
  const root = await fixture(t)
  const repository = fileURLToPath(new URL('../', import.meta.url))
  const output = join(root, 'installed-api')
  const expected = createRuntimeBuildIdentity(repository)

  await copyApiRuntime(repository, output)

  const identity = JSON.parse(await readFile(join(output, 'runtime-build.json'), 'utf8'))
  assert.deepEqual(identity, expected)
})
