import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expectTypeOf, it } from 'vitest'

import type { ExecutionLocation, RunExecutionLocation } from '../src/index.js'

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const specifiers = Object.keys(manifest.exports).map(path => path === '.' ? '@foreman-code/contracts' : `@foreman-code/contracts/${path.slice(2)}`)
let fixture: string
beforeAll(async () => {
  const cache = join(packageRoot, 'node_modules', '.cache')
  await mkdir(cache, { recursive: true })
  fixture = await mkdtemp(join(cache, 'contracts-esm-'))
  await copyFile(join(packageRoot, 'package.json'), join(fixture, 'package.json'))
  await execute(join(packageRoot, 'node_modules', '.bin', 'tsc'), ['-p', join(packageRoot, 'tsconfig.build.json'), '--outDir', join(fixture, 'dist')], { timeout: 60_000 })
}, 60_000)
afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }) })

describe('fresh compiled contracts in native Node ESM', () => {
  it('preserves the public execution location types', () => {
    expectTypeOf<ExecutionLocation>().toEqualTypeOf<{ runnerId: string; rootPath: string }>()
    expectTypeOf<RunExecutionLocation>().toEqualTypeOf<{ runnerId: string; rootPath: string; locationRevision: number; identityHash: string }>()
  })
  it.each(specifiers)('loads %s as the first import', async (specifier) => {
    const path = specifier === '@foreman-code/contracts' ? '.' : `./${specifier.slice('@foreman-code/contracts/'.length)}`
    await stat(join(fixture, manifest.exports[path].import))
    await stat(join(fixture, manifest.exports[path].types))
    await execute(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(specifier)})`], { cwd: fixture })
  })
  it('shares the unchanged location schema through root exports and bound readback', async () => {
    await execute(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      const root = await import('@foreman-code/contracts');
      const bound = await import('@foreman-code/contracts/workspace-bound-location');
      assert.equal(bound.WorkspaceBoundLocationReadbackSchema.options[0].shape.executionLocation, root.ExecutionLocationSchema);
      assert.equal(bound.WorkspaceBoundLocationReadbackSchema.options[1].shape.executionLocation, root.ExecutionLocationSchema);
      assert.deepEqual(bound.WorkspaceBoundLocationReadbackSchema.parse({ evidence: 'legacy_missing', workspaceId: 'workspace',
        locationRevision: 1, executionLocation: { runnerId: 'runner', rootPath: '/project' } }).executionLocation,
        { runnerId: 'runner', rootPath: '/project' });
      assert.equal(root.ExecutionLocationSchema.safeParse({ runnerId: 'runner', rootPath: '/project\\0invalid' }).success, false);
    `], { cwd: fixture })
  })
})
