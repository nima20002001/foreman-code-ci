import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { emitTypeScriptFixture } from './helpers/compiledApiFixture.js'
import { removeFixtureDirectory } from './helpers/testResources.js'

it('emits executable runtime modules without loading unrelated ambient type dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'compiled-api-fixture-'))
  try {
    const source = join(directory, 'src')
    const output = join(directory, 'dist')
    await mkdir(source)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src',
      declaration: true, types: ['uninstalled-fixture-types'],
    }, include: ['src'], exclude: ['src/**/*.test.ts'] }))
    await writeFile(join(source, 'value.ts'), 'export const value: number = 41\n')
    await writeFile(join(source, 'ignored.test.ts'), 'invalid test source that is excluded\n')
    await writeFile(join(source, 'index.ts'), [
      "import { value } from './value.js'",
      'export const result = async (): Promise<number> => {',
      "  const loaded = await import('./value.js')",
      '  return value + loaded.value + 1',
      '}',
    ].join('\n'))
    await emitTypeScriptFixture(join(directory, 'tsconfig.json'), output)
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      'const module = await import(process.argv[1]); console.log(await module.result());',
      pathToFileURL(join(output, 'index.js')).href])
    expect(stdout.trim()).toBe('83')
  } finally {
    await removeFixtureDirectory(directory)
  }
})

it('rejects malformed executable sources instead of producing a broken runtime fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'invalid-api-fixture-'))
  try {
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: '.',
    }, files: ['invalid.ts'] }))
    await writeFile(join(directory, 'invalid.ts'), 'export const value = ;\n')
    await expect(emitTypeScriptFixture(join(directory, 'tsconfig.json'), join(directory, 'dist')))
      .rejects.toThrow('Expression expected')
  } finally {
    await removeFixtureDirectory(directory)
  }
})
