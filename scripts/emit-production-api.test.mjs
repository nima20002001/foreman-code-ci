import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { emitProductionApi } from './emit-production-api.mjs'

async function fixture(t) {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const repository = await mkdtemp(join(cache, 'production-emit-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  const api = join(repository, 'apps/api')
  await mkdir(join(api, 'src'), { recursive: true })
  await mkdir(join(api, 'node_modules'), { recursive: true })
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
  await symlink(dirname(require.resolve('typescript/package.json')), join(api, 'node_modules/typescript'))
  await writeFile(join(api, 'package.json'), '{"type":"module"}')
  await writeFile(join(api, 'tsconfig.build.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', rootDir: 'src', outDir: 'dist', sourceMap: true,
    declaration: true, strict: true,
  }, include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'] }))
  return { repository, api }
}

test('emits executable ESM and source maps without declarations or importing type-only dependencies', async t => {
  const { repository, api } = await fixture(t)
  await writeFile(join(api, 'src/types.ts'), 'export interface Value { count: number }\n')
  await writeFile(join(api, 'src/value.ts'),
    'import type { Value } from "./types.js"; export const value: Value = { count: 7 }\n')
  await writeFile(join(api, 'src/value.test.ts'), 'invalid test syntax !!!')
  await emitProductionApi(repository)
  const emitted = await import(pathToFileURL(join(api, 'dist/value.js')))
  assert.deepEqual(emitted.value, { count: 7 })
  assert.deepEqual(JSON.parse(await readFile(join(api, 'dist/value.js.map'))).sources, ['../src/value.ts'])
  await assert.rejects(readFile(join(api, 'dist/value.d.ts')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(api, 'dist/value.test.js')), { code: 'ENOENT' })
  await rm(join(api, 'dist/value.js'))
  await emitProductionApi(repository)
  assert.ok((await readFile(join(api, 'dist/value.js'))).length > 0)
})

test('invalid TypeScript syntax fails emission', async t => {
  const { repository, api } = await fixture(t)
  await writeFile(join(api, 'src/broken.ts'), 'export const = !!!')
  await assert.rejects(emitProductionApi(repository), /broken\.ts/)
})

test('API-only edits retain unchanged output and repair corrupted cached JavaScript', async t => {
  const { repository, api } = await fixture(t)
  await writeFile(join(api, 'src/kept.ts'), 'export const value = 1\n')
  await writeFile(join(api, 'src/changed.ts'), 'export const value = 1\n')
  await emitProductionApi(repository)
  const kept = join(api, 'dist/kept.js')
  await utimes(kept, 1_000_000, 1_000_000)
  const timestamp = (await stat(kept)).mtimeMs
  await writeFile(join(api, 'src/changed.ts'), 'export const value = 2\n')
  await emitProductionApi(repository)
  assert.equal((await stat(kept)).mtimeMs, timestamp)
  assert.equal((await import(pathToFileURL(join(api, 'dist/changed.js')))).value, 2)
  await writeFile(kept, 'export const value = 999\n')
  await emitProductionApi(repository)
  assert.equal((await import(pathToFileURL(kept))).value, 1)
})
